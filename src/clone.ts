import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { copyCommit, git, tryGit } from './git.ts';
import type { Ledger } from './ledger.ts';
import { listVolumes, removeSandboxes } from './sandbox.ts';
import { isTerminal } from './run-machine.ts';

const ZERO_OID = '0'.repeat(40);

export const runDir = (home: string, runId: string) =>
  join(home, 'runs', runId);

// The run's trusted clone of the owner's project (ADR 0015). It is bare: no
// worktree exists for anything to be checked out into, and no sandbox ever
// mounts it. Only ktchn writes to it, and what the agent wrote enters it only
// as a pack. The run's branch starts at the base the ledger recorded. A clone
// already in place is reused. It is built beside its place and renamed into
// it, so a crash while cloning never leaves one that looks complete.
export const ensureClone = (opts: {
  home: string;
  runId: string;
  source: string;
  base: string;
  branch: string;
}): string => {
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
    git(partial, ['update-ref', `refs/heads/${opts.branch}`, opts.base]);
    git(partial, ['remote', 'remove', 'origin']);
    // The agent commits as the owner would. Nothing else of the owner's
    // configuration comes along.
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

// Brings the one reviewed commit into the owner's project as the run's
// branch, as a pack the owner's side checks (see git.ts), and changes
// nothing else there. The branch is
// created only if absent, so doing it again is a no-op and a branch that is
// somewhere else is left alone.
export const handOff = (opts: {
  owner: string;
  clone: string;
  branch: string;
  oid: string;
  // The commit the run started from, which the owner's project already has.
  base: string;
}) => {
  const ref = `refs/heads/${opts.branch}`;
  const current = tryGit(opts.owner, ['rev-parse', '--verify', '-q', ref], {
    scope: 'owner',
  });
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
  git(opts.owner, ['update-ref', ref, opts.oid, ZERO_OID], { scope: 'owner' });
};

export const removeRun = (home: string, runId: string) =>
  rmSync(runDir(home, runId), { recursive: true, force: true });

export type Sweep = {
  removed: string[];
  // Runs another process is carrying out, left for it.
  skipped: string[];
  failed: { runId: string; error: string }[];
};

// A crash between reaching a terminal state and deleting would leak the
// directory, so every start clears whatever is left of finished runs. Each is
// swept under its lease: a terminal run can still have a live driver that has
// not yet noticed (another process cancelled it mid-round), and that driver's
// sandbox must not lose its volume under it. A run whose lease is held is
// skipped for a later start. One run that will not go is reported and the rest
// are still swept.
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
        sweep.skipped.push(runId);
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

// A volume is made only after its run's directory, so a volume whose run has
// no directory is a leftover (only this home's volumes count, since homes
// share one docker): a crash or a failed start, or a run swept
// without its volume. The listing is by label, so runs this ledger never
// heard of are found too. A run another process holds is left for it.
export const sweepOrphanVolumes = (
  home: string,
  ledger: Ledger,
  volumes: () => { runId: string; home: string }[] = listVolumes,
  removeSandboxesOf: (runId: string) => unknown = (runId) =>
    removeSandboxes(runId, true)
): Sweep => {
  const sweep: Sweep = { removed: [], skipped: [], failed: [] };
  const seen = new Set<string>();
  for (const { runId, home: owner } of volumes()) {
    if (owner !== home || seen.has(runId) || runId === '') continue;
    seen.add(runId);
    if (existsSync(runDir(home, runId))) continue;
    try {
      if (!ledger.acquireLease(runId).held) {
        sweep.skipped.push(runId);
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
