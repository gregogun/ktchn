import { execFile } from 'node:child_process';
import {
  closeSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  Connection,
  packagedDaemon,
  RemoteExecutionEnv,
} from '@earendil-works/pi-env';
import { COPY_PATH, SAFE_GIT, SEEDED, seedScript } from './box-scripts.ts';
import { type ExecResult, runBounded } from './bounded.ts';
import { docker } from './docker.ts';
import {
  checkRefName,
  git,
  importPack,
  isAncestor,
  OID,
  tryGit,
} from './git.ts';
import {
  HOME_LABEL,
  RUN_LABEL,
  sandboxName,
  volumeName,
} from './run-resources.ts';

const PI_ENV_DIR = '/opt/pi-env';
const REVIEW_REF = 'refs/ktchn/review';
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const GROUPED = `exec setsid -w sh -c 'echo $$ >"$0"; exec sh -c "$1"' "$0" "$1"`;
const KILL_GROUP = 'kill -s KILL -- -"$(cat "$0")"; rm -f "$0"';

export const EXEC_TIMEOUT_MS = 10 * 60_000;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const MAX_PACK_BYTES = 256 * 1024 * 1024;
const QUICK_MS = 60_000;
const PACK_MS = 5 * 60_000;
export const PIDS_LIMIT = 512;
export const MEMORY_LIMIT = '2g';

export type ExecOptions = {
  stdin?: string | number;
  stdoutFile?: string;
  maxBytes?: number;
  timeoutMs?: number;
};

export class CollectRefused extends Error {}

export type Sandbox = {
  name: string;
  exec: (command: string, opts?: ExecOptions) => Promise<ExecResult>;
  close: () => Promise<void>;
};

export type AgentSandbox = Sandbox & { env: RemoteExecutionEnv };

// Each kind's settings are fixed by ADR 0015.
export type SandboxOpts = {
  runId: string;
  name: string;
  image: string;
} & (
  | { kind: 'agent'; home: string; network: boolean }
  | { kind: 'collect'; home: string }
  | { kind: 'review' }
);

export const sandboxSettings = (opts: SandboxOpts) => {
  switch (opts.kind) {
    case 'agent':
      return {
        volume: { home: opts.home },
        piEnv: true,
        network: opts.network,
      };
    case 'collect':
      return { volume: { home: opts.home }, piEnv: false, network: false };
    case 'review':
      return { volume: undefined, piEnv: false, network: false };
  }
};

const LIMITS = [
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--pids-limit',
  String(PIDS_LIMIT),
  '--memory',
  MEMORY_LIMIT,
  '--memory-swap',
  MEMORY_LIMIT,
];

export const containerArgs = (opts: {
  name: string;
  runId: string;
  image: string;
  network: boolean;
  mounts: readonly string[];
}) => [
  'run',
  '-d',
  '--rm',
  '-u',
  '1000:1000',
  '--name',
  opts.name,
  '--label',
  `${RUN_LABEL}=${opts.runId}`,
  ...LIMITS,
  ...(opts.network ? [] : ['--network', 'none']),
  ...opts.mounts,
  '--entrypoint',
  'sleep',
  opts.image,
  'infinity',
];

/* A new volume belongs to root. This hands it to the sandbox's user, as root
   with only CHOWN.
*/
export const chownArgs = (volume: string, image: string) => [
  'run',
  '--rm',
  '-u',
  'root',
  ...LIMITS,
  '--cap-add',
  'CHOWN',
  '--network',
  'none',
  '-v',
  `${volume}:${COPY_PATH}`,
  '--entrypoint',
  'chown',
  image,
  '1000:1000',
  COPY_PATH,
];

const piEnvBinDir = () =>
  dirname(
    packagedDaemon({
      platform: 'linux',
      arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    })
  );

const volumeExists = (volume: string) =>
  docker(['volume', 'ls', '-q', '--filter', `name=^${volume}$`]) !== '';

export const listVolumes = (): {
  runId: string;
  volume: string;
  home: string;
}[] =>
  docker([
    'volume',
    'ls',
    '--filter',
    `label=${RUN_LABEL}`,
    '--format',
    `{{.Name}}\t{{.Label "${RUN_LABEL}"}}\t{{.Label "${HOME_LABEL}"}}`,
  ])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [volume = '', runId = '', home = ''] = line.split('\t');
      return { runId, volume, home };
    });

export const removeSandboxes = (runId: string, withVolume: boolean) => {
  const ids = docker([
    'ps',
    '-aq',
    '--filter',
    `label=${RUN_LABEL}=${runId}`,
  ]).split('\n');
  const found = ids.filter(Boolean);
  if (found.length > 0) docker(['rm', '-f', ...found]);
  if (withVolume) docker(['volume', 'rm', '-f', volumeName(runId)]);
};

export async function openSandbox(
  opts: Extract<SandboxOpts, { kind: 'agent' }>
): Promise<AgentSandbox>;
export async function openSandbox(opts: SandboxOpts): Promise<Sandbox>;
export async function openSandbox(
  opts: SandboxOpts
): Promise<Sandbox | AgentSandbox> {
  const { runId, name } = opts;
  const settings = sandboxSettings(opts);
  if (!NAME.test(name)) throw new Error(`Not a sandbox name: ${name}`);
  const volume = volumeName(runId);
  docker(['rm', '-f', name]);
  const volumeExisted = settings.volume !== undefined && volumeExists(volume);
  const mounts: string[] = [];
  const forgetVolume = () => {
    try {
      docker(['volume', 'rm', '-f', volume]);
    } catch {
      // Already gone.
    }
  };
  let made = false;
  try {
    if (settings.volume) {
      docker([
        'volume',
        'create',
        '--label',
        `${RUN_LABEL}=${runId}`,
        '--label',
        `${HOME_LABEL}=${settings.volume.home}`,
        volume,
      ]);
      made = true;
      docker(chownArgs(volume, opts.image));
      mounts.push('-v', `${volume}:${COPY_PATH}`);
    }
    if (settings.piEnv) {
      mounts.push('-v', `${realpathSync(piEnvBinDir())}:${PI_ENV_DIR}:ro`);
    }
    docker(
      containerArgs({
        name,
        runId,
        image: opts.image,
        network: settings.network,
        mounts,
      })
    );
  } catch (error) {
    if (made && !volumeExisted) forgetVolume();
    throw error;
  }
  const remove = () => {
    try {
      docker(['rm', '-f', name]);
    } catch {
      // Already gone.
    }
  };
  try {
    docker(['exec', name, 'mkdir', '-p', COPY_PATH]);
  } catch (error) {
    remove();
    if (made && !volumeExisted) forgetVolume();
    throw error;
  }

  let execs = 0;
  const connection = settings.piEnv
    ? new Connection({
        command: ['docker', 'exec', '-i', name, `${PI_ENV_DIR}/pi-env`],
      })
    : undefined;
  const sandbox: Sandbox = {
    name,
    exec: (command, io = {}) => {
      const pidFile = `/tmp/ktchn-exec-${++execs}.pid`;
      return runBounded({
        file: 'docker',
        args: [
          'exec',
          '-i',
          '-w',
          COPY_PATH,
          name,
          'sh',
          '-c',
          GROUPED,
          pidFile,
          command,
        ],
        stdin: io.stdin,
        stdoutFile: io.stdoutFile,
        maxBytes: io.maxBytes ?? MAX_OUTPUT_BYTES,
        timeoutMs: io.timeoutMs ?? EXEC_TIMEOUT_MS,
        /* Killing the docker client leaves its command running in the
           container, so the command's own process group is killed too, and
           nothing else (the pi-env daemon is another group).
        */
        onKill: () =>
          new Promise<void>((done) => {
            execFile(
              'docker',
              ['exec', name, 'sh', '-c', KILL_GROUP, pidFile],
              { timeout: 10_000 },
              () => done()
            );
          }),
      });
    },
    close: async () => {
      connection?.close();
      remove();
    },
  };
  if (connection === undefined) return sandbox;
  return {
    ...sandbox,
    env: new RemoteExecutionEnv({
      connection,
      id: `ktchn:${name}`,
      cwd: COPY_PATH,
    }),
  };
}

const stopped = (result: ExecResult, what: string) => {
  if (result.limit === 'timeout') {
    throw new CollectRefused(
      `${what} was stopped in the sandbox for taking too long.`
    );
  }
  if (result.limit === 'output') {
    throw new CollectRefused(
      `${what} was stopped in the sandbox for printing more than the limit.`
    );
  }
};

const firstLine = (text: string) =>
  text.trim().split('\n')[0]?.slice(0, 300) ?? '';

const succeed = (result: ExecResult, what: string) => {
  stopped(result, what);
  if (result.exitCode !== 0) {
    throw new Error(
      `${what} failed in the sandbox: ${result.stderr.trim().slice(0, 300)}`
    );
  }
  return result.stdout.trim();
};

const answer = async (sandbox: Sandbox, result: ExecResult, what: string) => {
  stopped(result, what);
  if (result.exitCode === 0) return result.stdout.trim();
  const alive = await sandbox.exec('true', { timeoutMs: QUICK_MS });
  if (alive.exitCode !== 0) {
    throw new Error(
      `${what} failed and the sandbox does not answer: ${firstLine(result.stderr)}`
    );
  }
  throw new CollectRefused(
    `The work could not be collected from the sandbox. ${what} failed there: ${firstLine(result.stderr)}. Check that .git in the sandbox's copy is intact.`
  );
};

export const seed = async (
  sandbox: Sandbox,
  opts: { repo: string; ref: string; branch?: string }
) => {
  const { repo, ref, branch } = opts;
  checkRefName(ref);
  if (branch !== undefined) checkRefName(branch);
  const done = await sandbox.exec(`test -e ${SEEDED}`, {
    timeoutMs: QUICK_MS,
  });
  if (done.exitCode === 0) return;
  const scratch = mkdtempSync(join(tmpdir(), 'ktchn-seed-'));
  try {
    const bundle = join(scratch, 'seed.bundle');
    git(repo, ['bundle', 'create', '--quiet', bundle, '--end-of-options', ref]);
    const identity = ['user.name', 'user.email']
      .map((key) => [key, tryGit(repo, ['config', '--get', key])] as const)
      .filter((pair): pair is [string, string] => pair[1] !== undefined);
    const input = openSync(bundle, 'r');
    try {
      succeed(
        await sandbox.exec(seedScript({ ref, branch, identity }), {
          stdin: input,
          timeoutMs: PACK_MS,
        }),
        'Seeding'
      );
    } finally {
      closeSync(input);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

export const openReviewSandbox = async (
  opts: {
    runId: string;
    repo: string;
    oid: string;
    image: string;
  },
  open: (
    opts: Extract<SandboxOpts, { kind: 'review' }>
  ) => Promise<Sandbox> = openSandbox
): Promise<Sandbox> => {
  if (!OID.test(opts.oid)) throw new Error(`Not an object id: ${opts.oid}`);
  const sandbox = await open({
    runId: opts.runId,
    name: sandboxName(opts.runId, { kind: 'review' }),
    image: opts.image,
    kind: 'review',
  });
  try {
    git(opts.repo, ['update-ref', '--end-of-options', REVIEW_REF, opts.oid]);
    await seed(sandbox, { repo: opts.repo, ref: REVIEW_REF });
    return sandbox;
  } catch (error) {
    await sandbox.close();
    throw error;
  } finally {
    tryGit(opts.repo, ['update-ref', '-d', '--end-of-options', REVIEW_REF]);
  }
};

export type Collected = {
  oid: string;
  dirty: string;
};

export const collect = async (opts: {
  sandbox: Sandbox;
  repo: string;
  branch: string;
  base: string;
}): Promise<Collected> => {
  const { sandbox, repo, branch, base } = opts;
  checkRefName(branch);
  const ref = `refs/heads/${branch}`;
  const tip = git(repo, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${ref}^{commit}`,
  ]);
  const oid = await answer(
    sandbox,
    await sandbox.exec(
      `${SAFE_GIT} rev-parse --verify --end-of-options ${ref}^{commit}`,
      {
        timeoutMs: QUICK_MS,
      }
    ),
    `Reading ${ref}`
  );
  if (!OID.test(oid)) {
    throw new CollectRefused(
      `The sandbox answered ${oid.slice(0, 80)} for ${ref}, which is not a commit id`
    );
  }
  const status = await sandbox.exec(
    `${SAFE_GIT} status --porcelain -z --untracked-files=all --ignore-submodules=all`,
    { timeoutMs: QUICK_MS }
  );
  await answer(sandbox, status, 'Reading the status');
  if (oid !== tip) {
    const scratch = mkdtempSync(join(tmpdir(), 'ktchn-pack-'));
    try {
      const file = join(scratch, 'objects.pack');
      const pack = (exclude: string) =>
        sandbox.exec(`${SAFE_GIT} pack-objects --revs --stdout --quiet`, {
          stdin: `${oid}\n${exclude}`,
          stdoutFile: file,
          maxBytes: MAX_PACK_BYTES,
          timeoutMs: PACK_MS,
        });
      let sent = await pack(`^${tip}\n`);
      if (sent.exitCode !== 0 && sent.limit === undefined) {
        sent = await pack('');
      }
      await answer(sandbox, sent, 'Packing');
      try {
        importPack(file, repo, oid, { maxBytes: MAX_PACK_BYTES });
      } catch (error) {
        if (typeof (error as { status?: unknown }).status !== 'number') {
          throw error;
        }
        throw new CollectRefused(
          `The pack the sandbox sent was refused by git: ${firstLine(String((error as { stderr?: unknown }).stderr))}. Check that .git in the sandbox's copy is intact.`
        );
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    if (!isAncestor(repo, base, oid)) {
      throw new CollectRefused(
        `The commit ${oid} on branch ${branch} does not descend from ${base}, the commit this job started from. Build on top of the branch's history and do not replace it.`
      );
    }
    git(repo, ['update-ref', '--end-of-options', ref, oid, tip]);
  }
  return { oid, dirty: status.stdout };
};
