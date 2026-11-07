import { execFile, execFileSync } from 'node:child_process';
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
import { git, importPack, isAncestor, OID, tryGit } from './git.ts';

const PI_ENV_DIR = '/opt/pi-env';
const REVIEW_REF = 'refs/ktchn/review';
const LABEL = 'ktchn.run';
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const REF = /^[A-Za-z0-9._/-]+$/;

export const EXEC_TIMEOUT_MS = 10 * 60_000;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const MAX_PACK_BYTES = 256 * 1024 * 1024;
const QUICK_MS = 60_000;
const PACK_MS = 5 * 60_000;
export const PIDS_LIMIT = 512;
export const MEMORY_LIMIT = '2g';

export type ExecOptions = {
  stdin?: string | number;
  // Writes stdout to this file instead of returning it.
  stdoutFile?: string;
  // Most bytes kept from stdout and from stderr, or written to `stdoutFile`.
  maxBytes?: number;
  timeoutMs?: number;
};

// The box stopped a command or the host did, so what the sandbox said cannot
// be trusted to be whole. It is a finding for the agent, not a crash of ktchn.
export class CollectRefused extends Error {}

// A sandbox is a container whose files exist only inside docker. The host
// copies code in and data out, and never mounts or reads what the agent
// wrote there (ADR 0015).
export type Sandbox = {
  name: string;
  env: RemoteExecutionEnv | undefined;
  // Every command is bounded: it is killed when it outruns `timeoutMs` or
  // prints more than `maxBytes`, and the result says which (`limit`).
  exec: (command: string, opts?: ExecOptions) => Promise<ExecResult>;
  close: () => Promise<void>;
};

export const sandboxName = (runId: string, round: number) =>
  `ktchn-${runId}-r${round}`;
const volumeName = (runId: string) => `ktchn-${runId}`;

const docker = (args: readonly string[]) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

// What every sandbox container is run with. The network is a Policy of the
// job: `--network none` unless the job allows it (ADR 0015).
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
  `${LABEL}=${opts.runId}`,
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--pids-limit',
  String(PIDS_LIMIT),
  '--memory',
  MEMORY_LIMIT,
  ...(opts.network ? [] : ['--network', 'none']),
  ...opts.mounts,
  '--entrypoint',
  'sleep',
  opts.image,
  'infinity',
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

// Every volume ktchn made, by label, whether or not its run is still known.
export const listVolumes = (): { runId: string; volume: string }[] =>
  docker([
    'volume',
    'ls',
    '--filter',
    `label=${LABEL}`,
    '--format',
    `{{.Name}} {{.Label "${LABEL}"}}`,
  ])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [volume = '', runId = ''] = line.split(' ');
      return { runId, volume };
    });

// Removes every container of a run, and with `withVolume` its volume too.
// A crashed driver leaves its containers behind, so a resume and the sweep of
// finished runs both call this.
export const removeSandboxes = (runId: string, withVolume: boolean) => {
  const ids = docker([
    'ps',
    '-aq',
    '--filter',
    `label=${LABEL}=${runId}`,
  ]).split('\n');
  const found = ids.filter(Boolean);
  if (found.length > 0) docker(['rm', '-f', ...found]);
  if (withVolume) docker(['volume', 'rm', '-f', volumeName(runId)]);
};

// With a volume the sandbox's copy outlives its container, so a run that
// crashes carries on from what its agent had written (ADR 0015).
export const openSandbox = async (opts: {
  runId: string;
  name: string;
  image: string;
  volume: boolean;
  piEnv: boolean;
  // The job's Policy. A sandbox with no network cannot fetch anything.
  network: boolean;
}): Promise<Sandbox> => {
  const { runId, name } = opts;
  if (!NAME.test(name)) throw new Error(`Not a sandbox name: ${name}`);
  const volume = volumeName(runId);
  docker(['rm', '-f', name]);
  const volumeExisted = opts.volume && volumeExists(volume);
  const mounts: string[] = [];
  const forgetVolume = () => {
    try {
      docker(['volume', 'rm', '-f', volume]);
    } catch {
      // Already gone, or the sweep by label finds it.
    }
  };
  let made = false;
  try {
    if (opts.volume) {
      docker(['volume', 'create', '--label', `${LABEL}=${runId}`, volume]);
      made = true;
      // A new volume belongs to root.
      docker([
        'run',
        '--rm',
        '-u',
        'root',
        '--cap-drop',
        'ALL',
        '--cap-add',
        'CHOWN',
        '--network',
        'none',
        '-v',
        `${volume}:${COPY_PATH}`,
        '--entrypoint',
        'chown',
        opts.image,
        '1000:1000',
        COPY_PATH,
      ]);
      mounts.push('-v', `${volume}:${COPY_PATH}`);
    }
    if (opts.piEnv) {
      mounts.push('-v', `${realpathSync(piEnvBinDir())}:${PI_ENV_DIR}:ro`);
    }
    docker(
      containerArgs({
        name,
        runId,
        image: opts.image,
        network: opts.network,
        mounts,
      })
    );
  } catch (error) {
    // A volume made by this call has no run directory to sweep it with yet.
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

  const connection = opts.piEnv
    ? new Connection({
        command: ['docker', 'exec', '-i', name, `${PI_ENV_DIR}/pi-env`],
      })
    : undefined;
  return {
    name,
    env:
      connection === undefined
        ? undefined
        : new RemoteExecutionEnv({
            connection,
            id: `ktchn:${name}`,
            cwd: COPY_PATH,
          }),
    exec: (command, io = {}) =>
      runBounded({
        file: 'docker',
        args: ['exec', '-i', '-w', COPY_PATH, name, 'sh', '-c', command],
        stdin: io.stdin,
        stdoutFile: io.stdoutFile,
        maxBytes: io.maxBytes ?? MAX_OUTPUT_BYTES,
        timeoutMs: io.timeoutMs ?? EXEC_TIMEOUT_MS,
        // Killing the docker client leaves its command running in the
        // container, so everything but the container's init is killed too.
        onKill: () =>
          execFile(
            'docker',
            ['exec', name, 'sh', '-c', 'kill -s KILL -- -1'],
            { timeout: 10_000 },
            () => {}
          ),
      }),
    close: async () => {
      connection?.close();
      remove();
    },
  };
};

const succeed = (result: ExecResult, what: string) => {
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
  if (result.exitCode !== 0) {
    throw new Error(
      `${what} failed in the sandbox: ${result.stderr.trim().slice(0, 300)}`
    );
  }
  return result.stdout.trim();
};

// Puts one commit and its history into the sandbox's copy, as a bundle
// streamed in. A copy that already holds a seed is left alone, which is
// what makes a crashed run's work survive. `branch` names the branch to check
// out, and without it the commit is checked out detached.
export const seed = async (
  sandbox: Sandbox,
  opts: { repo: string; ref: string; branch?: string }
) => {
  const { repo, ref, branch } = opts;
  for (const name of [ref, branch ?? 'x']) {
    if (!REF.test(name)) throw new Error(`Not a ref name: ${name}`);
  }
  const done = await sandbox.exec(`test -e ${SEEDED}`, {
    timeoutMs: QUICK_MS,
  });
  if (done.exitCode === 0) return;
  const scratch = mkdtempSync(join(tmpdir(), 'ktchn-seed-'));
  try {
    const bundle = join(scratch, 'seed.bundle');
    git(repo, ['bundle', 'create', '--quiet', bundle, ref]);
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

// Review's own sandbox: a fresh repository holding the reviewed commit with
// no volume, no pi-env and no secrets, so checks judge that commit and only
// that commit.
export const openReviewSandbox = async (
  opts: {
    runId: string;
    repo: string;
    oid: string;
    image: string;
  },
  open: typeof openSandbox = openSandbox
): Promise<Sandbox> => {
  if (!OID.test(opts.oid)) throw new Error(`Not an object id: ${opts.oid}`);
  const sandbox = await open({
    runId: opts.runId,
    name: `ktchn-${opts.runId}-review`,
    image: opts.image,
    volume: false,
    piEnv: false,
    network: false,
  });
  git(opts.repo, ['update-ref', REVIEW_REF, opts.oid]);
  try {
    await seed(sandbox, { repo: opts.repo, ref: REVIEW_REF });
    return sandbox;
  } catch (error) {
    await sandbox.close();
    throw error;
  } finally {
    tryGit(opts.repo, ['update-ref', '-d', REVIEW_REF]);
  }
};

export type Collected = {
  oid: string;
  // `git status --porcelain -z` of the sandbox's copy, empty when it is clean.
  dirty: string;
};

// The end of a round. Everything the host will ever learn about the agent's
// work leaves the sandbox here: a commit id, a status listing, and a pack
// that git checks object by object before the run's branch moves to it. The
// sandbox's copy itself is never read. The commit must descend from `base`,
// the commit the run started from.
export const collect = async (opts: {
  sandbox: Sandbox;
  repo: string;
  branch: string;
  base: string;
}): Promise<Collected> => {
  const { sandbox, repo, branch, base } = opts;
  const ref = `refs/heads/${branch}`;
  const tip = git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
  const oid = succeed(
    await sandbox.exec(`${SAFE_GIT} rev-parse --verify ${ref}^{commit}`, {
      timeoutMs: QUICK_MS,
    }),
    `Reading ${ref}`
  );
  if (!OID.test(oid)) {
    throw new Error(
      `The sandbox answered ${oid.slice(0, 80)} for ${ref}, which is not a commit id`
    );
  }
  const status = await sandbox.exec(
    `${SAFE_GIT} status --porcelain -z --untracked-files=all --ignore-submodules=all`,
    { timeoutMs: QUICK_MS }
  );
  succeed(status, 'Reading the status');
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
      // A tip the sandbox no longer has means a full pack.
      if (sent.exitCode !== 0 && sent.limit === undefined) {
        sent = await pack('');
      }
      succeed(sent, 'Packing');
      importPack(file, repo, oid, { maxBytes: MAX_PACK_BYTES });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    if (!isAncestor(repo, base, oid)) {
      throw new CollectRefused(
        `The commit ${oid} on branch ${branch} does not descend from ${base}, the commit this job started from. Build on top of the branch's history and do not replace it.`
      );
    }
    git(repo, ['update-ref', ref, oid, tip]);
  }
  return { oid, dirty: status.stdout };
};
