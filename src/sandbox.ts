import { execFileSync, spawn } from 'node:child_process';
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
import { git, importPack, OID, tryGit } from './git.ts';

export const WORKSPACE = '/home/agent/workspace';
const PI_ENV_DIR = '/opt/pi-env';
const SEEDED = '.git/ktchn-seeded';
const REVIEW_REF = 'refs/ktchn/review';
const LABEL = 'ktchn.run';
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const REF = /^[A-Za-z0-9._/-]+$/;

export type ExecResult = { exitCode: number; stdout: string; stderr: string };

// A sandbox is a container whose files exist only inside docker. The host
// copies code in and data out, and never mounts or reads what the agent
// wrote there (ADR 0015).
export type Sandbox = {
  name: string;
  env: RemoteExecutionEnv | undefined;
  exec: (
    command: string,
    opts?: { stdin?: string | number; stdout?: number }
  ) => Promise<ExecResult>;
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

const piEnvBinDir = () =>
  dirname(
    packagedDaemon({
      platform: 'linux',
      arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    })
  );

// Removes every container of a run, and with `withVolume` its workspace too.
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

// With a volume the sandbox's workspace outlives its container, so a run that
// crashes carries on from what its agent had written (ADR 0015).
export const openSandbox = async (opts: {
  runId: string;
  name: string;
  image: string;
  volume: boolean;
  piEnv: boolean;
}): Promise<Sandbox> => {
  const { runId, name } = opts;
  if (!NAME.test(name)) throw new Error(`Not a sandbox name: ${name}`);
  const volume = volumeName(runId);
  docker(['rm', '-f', name]);
  const mounts: string[] = [];
  if (opts.volume) {
    docker(['volume', 'create', '--label', `${LABEL}=${runId}`, volume]);
    // A new volume belongs to root.
    docker([
      'run',
      '--rm',
      '-u',
      'root',
      '-v',
      `${volume}:${WORKSPACE}`,
      '--entrypoint',
      'chown',
      opts.image,
      '1000:1000',
      WORKSPACE,
    ]);
    mounts.push('-v', `${volume}:${WORKSPACE}`);
  }
  if (opts.piEnv) {
    mounts.push('-v', `${realpathSync(piEnvBinDir())}:${PI_ENV_DIR}:ro`);
  }
  docker([
    'run',
    '-d',
    '--rm',
    '-u',
    '1000:1000',
    '--name',
    name,
    '--label',
    `${LABEL}=${runId}`,
    ...mounts,
    '--entrypoint',
    'sleep',
    opts.image,
    'infinity',
  ]);
  const remove = () => {
    try {
      docker(['rm', '-f', name]);
    } catch {
      // Already gone.
    }
  };
  try {
    docker(['exec', name, 'mkdir', '-p', WORKSPACE]);
  } catch (error) {
    remove();
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
            cwd: WORKSPACE,
          }),
    exec: (command, io = {}) =>
      new Promise((resolve) => {
        const child = spawn(
          'docker',
          ['exec', '-i', '-w', WORKSPACE, name, 'sh', '-c', command],
          {
            stdio: [
              typeof io.stdin === 'number' ? io.stdin : 'pipe',
              io.stdout ?? 'pipe',
              'pipe',
            ],
          }
        );
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d: Buffer) => (stdout += String(d)));
        child.stderr?.on('data', (d: Buffer) => (stderr += String(d)));
        child.on('error', (error) =>
          resolve({ exitCode: 127, stdout, stderr: String(error) })
        );
        child.on('close', (code) =>
          resolve({ exitCode: code ?? 1, stdout, stderr })
        );
        if (typeof io.stdin !== 'number') child.stdin?.end(io.stdin);
      }),
    close: async () => {
      connection?.close();
      remove();
    },
  };
};

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const succeed = (result: ExecResult, what: string) => {
  if (result.exitCode !== 0) {
    throw new Error(`${what} failed in the sandbox: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
};

// Puts one commit and its history into the sandbox's workspace, as a bundle
// streamed in. A workspace that already holds a seed is left alone, which is
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
  const done = await sandbox.exec(`test -e ${SEEDED}`);
  if (done.exitCode === 0) return;
  const scratch = mkdtempSync(join(tmpdir(), 'ktchn-seed-'));
  try {
    const bundle = join(scratch, 'seed.bundle');
    git(repo, ['bundle', 'create', '--quiet', bundle, ref]);
    const identity = ['user.name', 'user.email']
      .map((key) => [key, tryGit(repo, ['config', '--get', key])] as const)
      .filter((pair): pair is [string, string] => pair[1] !== undefined)
      .map(([key, value]) => `git config ${key} ${quote(value)}`);
    const checkout =
      branch === undefined
        ? 'git checkout -q --detach FETCH_HEAD'
        : `git checkout -q -B ${branch} FETCH_HEAD`;
    const input = openSync(bundle, 'r');
    try {
      succeed(
        await sandbox.exec(
          [
            // An interrupted seed left files that are not a repository.
            'find . -mindepth 1 -maxdepth 1 -exec rm -rf {} +',
            'cat > /tmp/seed.bundle',
            'git init -q .',
            `git fetch -q /tmp/seed.bundle ${ref}`,
            checkout,
            ...identity,
            'rm -f /tmp/seed.bundle',
            `touch ${SEEDED}`,
          ].join(' && '),
          { stdin: input }
        ),
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
export const openReviewSandbox = async (opts: {
  runId: string;
  repo: string;
  oid: string;
  image: string;
}): Promise<Sandbox> => {
  if (!OID.test(opts.oid)) throw new Error(`Not an object id: ${opts.oid}`);
  const sandbox = await openSandbox({
    runId: opts.runId,
    name: `ktchn-${opts.runId}-review`,
    image: opts.image,
    volume: false,
    piEnv: false,
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
  // `git status --porcelain -z` of the workspace, empty when it is clean.
  dirty: string;
};

// The end of a round. Everything the host will ever learn about the agent's
// work leaves the sandbox here: a commit id, a status listing, and a pack
// that git checks object by object before the run's branch moves to it. The
// workspace itself is never read.
export const collect = async (opts: {
  sandbox: Sandbox;
  repo: string;
  branch: string;
}): Promise<Collected> => {
  const { sandbox, repo, branch } = opts;
  const ref = `refs/heads/${branch}`;
  const tip = git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
  const oid = succeed(
    await sandbox.exec(`git rev-parse --verify ${ref}^{commit}`),
    `Reading ${ref}`
  );
  if (!OID.test(oid)) throw new Error(`The sandbox answered ${oid} for ${ref}`);
  const status = await sandbox.exec(
    'git status --porcelain -z --untracked-files=all'
  );
  succeed(status, 'Reading the status');
  if (oid !== tip) {
    const scratch = mkdtempSync(join(tmpdir(), 'ktchn-pack-'));
    try {
      const file = join(scratch, 'objects.pack');
      const pack = async (exclude: string) => {
        const out = openSync(file, 'w');
        try {
          return await sandbox.exec(
            'git pack-objects --revs --stdout --quiet',
            { stdin: `${oid}\n${exclude}`, stdout: out }
          );
        } finally {
          closeSync(out);
        }
      };
      let sent = await pack(`^${tip}\n`);
      // A tip the sandbox no longer has means a full pack.
      if (sent.exitCode !== 0) sent = await pack('');
      succeed(sent, 'Packing');
      importPack(file, repo, oid);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    git(repo, ['update-ref', ref, oid, tip]);
  }
  return { oid, dirty: status.stdout };
};
