import { execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The host runs git only on repositories ktchn alone writes: the owner's
// project, a run's clone, and scratch directories (ADR 0015). Variables a
// hook or a parent git left in the environment must not steer it.
//
// A run's clone and scratch directories are `trusted`: git there reads no
// system or user configuration, so nothing but ktchn's own flags and the
// repository's config decides what it does. The owner's project is `owner`
// and keeps the owner's own system and user configuration. ktchn needs the
// owner's identity from it for the agent's commits, and the project is the
// owner's own code on the owner's own machine, written only by ktchn
// (ADR 0015). Inherited `GIT_*` variables are dropped for both.
export type Scope = 'trusted' | 'owner';

const hostEnv = (scope: Scope): Record<string, string> => {
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_NO_LAZY_FETCH: '1',
  };
  if (scope === 'trusted') {
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = '/dev/null';
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith('GIT_')) env[name] = value;
  }
  return env;
};

// A host git call that outruns this is killed. index-pack of a pack at the
// 256 MiB cap is the slowest call ktchn makes, and this leaves it room on a
// slow disk. It stops a hostile pack or a stuck repository from hanging ktchn.
const GIT_TIMEOUT_MS = 10 * 60_000;

export const git = (
  cwd: string,
  args: readonly string[],
  opts: { stdin?: string | number; stdout?: number; scope?: Scope } = {}
): string =>
  (
    execFileSync('git', [...args], {
      cwd,
      env: hostEnv(opts.scope ?? 'trusted'),
      input: typeof opts.stdin === 'string' ? opts.stdin : undefined,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
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
  args: readonly string[],
  opts: { scope?: Scope } = {}
): string | undefined => {
  try {
    return git(cwd, args, opts);
  } catch {
    return undefined;
  }
};

export const OID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

// The one rule for a branch or ref name ktchn passes to git, on the host or
// in a sandbox's shell: characters that need no quoting, no leading `-` that
// git would read as an option, and nothing `git check-ref-format` refuses
// (which includes `..`).
const REF_CHARS = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;
export const checkRefName = (name: string) => {
  if (
    !REF_CHARS.test(name) ||
    tryGit(tmpdir(), ['check-ref-format', '--allow-onelevel', name]) ===
      undefined
  ) {
    throw new Error(`Not a ref name: ${JSON.stringify(name.slice(0, 200))}`);
  }
};

const checkOid = (id: string) => {
  if (!OID.test(id)) throw new Error(`Not an object id: ${id}`);
};

// Whether `ancestor` is reachable from `descendant`, both already in `repo`.
// Git exits 1 for "no"; any other failure is not an answer and is thrown.
export const isAncestor = (
  repo: string,
  ancestor: string,
  descendant: string
) => {
  checkOid(ancestor);
  checkOid(descendant);
  try {
    git(repo, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (error) {
    if ((error as { status?: unknown }).status === 1) return false;
    throw error;
  }
};

// The one way anything an agent wrote enters a repository the host reads:
// a pack file, which git checks object by object, and then a check that
// everything `oid` needs is present. Nothing in the pack is ever executed or
// checked out.
export const importPack = (
  pack: string,
  repo: string,
  oid: string,
  opts: { maxBytes?: number; scope?: Scope } = {}
) => {
  checkOid(oid);
  const input = openSync(pack, 'r');
  try {
    git(
      repo,
      [
        'index-pack',
        '--stdin',
        '--strict',
        ...(opts.maxBytes === undefined
          ? []
          : [`--max-input-size=${opts.maxBytes}`]),
      ],
      { stdin: input, scope: opts.scope }
    );
  } finally {
    closeSync(input);
  }
  git(repo, ['rev-list', '--objects', '--quiet', oid, '--not', '--all'], {
    scope: opts.scope,
  });
};

// Brings one commit and what it needs from one repository into another as a
// pack. `excluding` is a commit the destination already has, to send less.
export const copyCommit = (opts: {
  // How git treats `to`, which is the owner's project in a handoff.
  toScope?: Scope;
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
    importPack(file, to, oid, { scope: opts.toScope });
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
