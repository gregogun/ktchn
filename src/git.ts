import { execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The host runs git only on repositories ktchn alone writes: the owner's
// project, a run's clone, and scratch directories (ADR 0015). Variables a
// hook or a parent git left in the environment must not steer it.
const hostEnv = (): Record<string, string> => {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith('GIT_')) env[name] = value;
  }
  return env;
};

export const git = (
  cwd: string,
  args: readonly string[],
  opts: { stdin?: string | number; stdout?: number } = {}
): string =>
  (
    execFileSync('git', [...args], {
      cwd,
      env: hostEnv(),
      input: typeof opts.stdin === 'string' ? opts.stdin : undefined,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: [
        typeof opts.stdin === 'number'
          ? opts.stdin
          : opts.stdin === undefined
            ? 'ignore'
            : 'pipe',
        opts.stdout ?? 'pipe',
        'pipe',
      ],
    }) ?? ''
  ).trim();

export const tryGit = (
  cwd: string,
  args: readonly string[]
): string | undefined => {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
};

export const OID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

const checkOid = (id: string) => {
  if (!OID.test(id)) throw new Error(`Not an object id: ${id}`);
};

// The one way anything an agent wrote enters a repository the host reads:
// a pack file, which git checks object by object, and then a check that
// everything `oid` needs is present. Nothing in the pack is ever executed or
// checked out.
export const importPack = (pack: string, repo: string, oid: string) => {
  checkOid(oid);
  const input = openSync(pack, 'r');
  try {
    git(repo, ['index-pack', '--stdin', '--strict'], { stdin: input });
  } finally {
    closeSync(input);
  }
  git(repo, ['rev-list', '--objects', '--quiet', oid, '--not', '--all']);
};

// Brings one commit and what it needs from one repository into another as a
// pack. `excluding` is a commit the destination already has, to send less.
export const copyCommit = (opts: {
  from: string;
  to: string;
  oid: string;
  excluding?: string;
}) => {
  const { from, to, oid } = opts;
  for (const id of [oid, opts.excluding ?? oid]) checkOid(id);
  const scratch = mkdtempSync(join(tmpdir(), 'ktchn-pack-'));
  const file = join(scratch, 'objects.pack');
  const attempt = (excluding: string | undefined) => {
    const out = openSync(file, 'w');
    try {
      git(from, ['pack-objects', '--revs', '--stdout', '--quiet'], {
        stdin: `${oid}\n${excluding === undefined ? '' : `^${excluding}\n`}`,
        stdout: out,
      });
    } finally {
      closeSync(out);
    }
    importPack(file, to, oid);
  };
  try {
    try {
      attempt(opts.excluding);
    } catch (error) {
      if (opts.excluding === undefined) throw error;
      attempt(undefined);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};
