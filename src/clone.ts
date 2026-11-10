import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { checkRefName, copyCommit, git, tryGit } from './git.ts';
import type { Ledger } from './ledger.ts';
import { listVolumes, removeSandboxes } from './sandbox.ts';
import { isTerminal } from './run-machine.ts';
import { runDir } from './run-resources.ts';

const ZERO_OID = '0'.repeat(40);

export const ensureClone = (opts: {
  home: string;
  runId: string;
  source: string;
  base: string;
  branch: string;
}): string => {
  checkRefName(opts.branch);
  const dir = join(runDir(opts.home, opts.runId), 'repo');
  if (existsSync(dir)) return dir;
  const partial = `${dir}.partial`;
  rmSync(partial, { recursive: true, force: true });
  const parent = runDir(opts.home, opts.runId);
  mkdirSync(parent, { recursive: true });
  try {
    git(parent, [
      'clone',
      '--quiet',
      '--bare',
      '--no-hardlinks',
      opts.source,
      partial,
    ]);
    if (
      tryGit(partial, ['cat-file', '-e', `${opts.base}^{commit}`]) === undefined
    ) {
      git(partial, ['fetch', '--quiet', '--no-tags', opts.source, opts.base]);
    }
    git(partial, [
      'update-ref',
      '--end-of-options',
      `refs/heads/${opts.branch}`,
      opts.base,
    ]);
    git(partial, ['remote', 'remove', 'origin']);
    for (const key of ['user.name', 'user.email']) {
      const value = tryGit(opts.source, ['config', '--get', key], {
        scope: 'owner',
      });
      if (value !== undefined) git(partial, ['config', key, value]);
    }
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
  renameSync(partial, dir);
  return dir;
};

export const handOff = (opts: {
  owner: string;
  clone: string;
  branch: string;
  oid: string;
  base: string;
}) => {
  checkRefName(opts.branch);
  const ref = `refs/heads/${opts.branch}`;
  const current = tryGit(
    opts.owner,
    ['rev-parse', '--verify', '-q', '--end-of-options', ref],
    {
      scope: 'owner',
    }
  );
  if (current === opts.oid) return;
  if (current !== undefined) {
    throw new Error(
      `Refusing to hand off: ${ref} in ${opts.owner} is at ${current}, not the reviewed ${opts.oid}.`
    );
  }
  copyCommit({
    from: opts.clone,
    to: opts.owner,
    oid: opts.oid,
    excluding: opts.base,
    toScope: 'owner',
  });
  git(opts.owner, ['update-ref', '--end-of-options', ref, opts.oid, ZERO_OID], {
    scope: 'owner',
  });
};

export const removeRun = (home: string, runId: string) =>
  rmSync(runDir(home, runId), { recursive: true, force: true });

const HELD = 'another process is carrying it out';

export type Sweep = {
  removed: string[];
  skipped: { runId: string; reason: string }[];
  failed: { runId: string; error: string }[];
};

export const sweepFinishedRuns = (
  home: string,
  ledger: Ledger,
  removeSandboxesOf: (runId: string) => unknown = (runId) =>
    removeSandboxes(runId, true)
): Sweep => {
  const sweep: Sweep = { removed: [], skipped: [], failed: [] };
  const runs = join(home, 'runs');
  if (!existsSync(runs)) return sweep;
  for (const runId of readdirSync(runs)) {
    try {
      if (!isTerminal(ledger.replay(runId).state)) continue;
      if (!ledger.acquireLease(runId).held) {
        sweep.skipped.push({ runId, reason: HELD });
        continue;
      }
      try {
        removeSandboxesOf(runId);
        removeRun(home, runId);
        sweep.removed.push(runId);
      } finally {
        ledger.releaseLease(runId);
      }
    } catch (error) {
      sweep.failed.push({ runId, error: String(error) });
    }
  }
  return sweep;
};

export const sweepOrphanVolumes = (
  home: string,
  ledger: Ledger,
  volumes: () => { runId: string; home: string }[] = listVolumes,
  removeSandboxesOf: (runId: string) => unknown = (runId) =>
    removeSandboxes(runId, true)
): Sweep => {
  const sweep: Sweep = { removed: [], skipped: [], failed: [] };
  const seen = new Set<string>();
  let listed;
  try {
    listed = volumes();
  } catch (error) {
    throw new Error(
      `Cannot list the sandbox volumes, is docker running? ${String(error).slice(0, 300)}`,
      { cause: error }
    );
  }
  for (const { runId, home: owner } of listed) {
    if (seen.has(runId) || runId === '') continue;
    if (owner === '') {
      seen.add(runId);
      if (existsSync(runDir(home, runId))) continue;
      sweep.skipped.push({
        runId,
        reason:
          "its volume has no ktchn.home label, so it cannot be told from another home's; remove it by hand if it is yours",
      });
      continue;
    }
    if (owner !== home) continue;
    seen.add(runId);
    if (existsSync(runDir(home, runId))) continue;
    try {
      if (!ledger.acquireLease(runId).held) {
        sweep.skipped.push({ runId, reason: HELD });
        continue;
      }
      try {
        removeSandboxesOf(runId);
        sweep.removed.push(runId);
      } finally {
        ledger.releaseLease(runId);
      }
    } catch (error) {
      sweep.failed.push({ runId, error: String(error) });
    }
  }
  return sweep;
};
