import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { AgentOutcome } from './agent.ts';
import { makeJob } from './job.ts';
import { openLedger } from './ledger.ts';
import { prepareRun, type RunPreparation } from './run-start.ts';
import { replay, type RunState } from './run-machine.ts';
import type { AgentSession } from './shell.ts';
import { git } from './test-git.ts';
import { fakeAgentSandbox } from './test-sandbox.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const noOrphans = () => ({ removed: [], skipped: [], failed: [] });

const world = () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ktchn-start-')));
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'ktchn-start-repo-')));
  dirs.push(home, repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  const { runId, job } = makeJob({
    repo,
    text: 't',
    checks: [],
    allowPaths: [],
    policy: { network: false },
    model: 'm',
    reviewerModel: 'rm',
  });
  const fetched: string[] = [];
  const reports: { state: RunState; cost: number }[] = [];
  const closed: string[] = [];
  const opts = {
    home,
    runId,
    job,
    report: (progress: { state: RunState; cost: number }) => {
      reports.push(progress);
    },
    checkCanOpenPr: () => {},
    originBase: () => {
      fetched.push(repo);
      return { base: git(repo, 'rev-parse', 'HEAD'), baseBranch: 'main' };
    },
    sweepOrphanVolumes: noOrphans,
    readOpenRouterKey: () => 'key',
    sandboxes: {
      open: async () => ({
        ...fakeAgentSandbox(),
        close: async () => {
          closed.push('sandbox');
        },
      }),
      removeAll: () => {},
      seed: async () => {},
      collect: async () => ({ oid: 'a'.repeat(40), dirty: '' }),
    },
  };
  const seed = () => openLedger(join(home, 'ledger.sqlite'));
  return { opts, runId, job, fetched, reports, closed, seed };
};

const session = (run: AgentSession['run']): AgentSession => ({
  run,
  close: async () => {},
});

const endsEarly = (calls: AgentOutcome['calls'] = []) =>
  session(async () => ({
    event: { type: 'AgentEndedEarly', reason: 'stopped' },
    calls,
  }));

const ready = (prepared: RunPreparation) => {
  if (prepared.status !== 'ready') {
    throw new Error(`expected a ready run, got ${prepared.status}`);
  }
  return prepared;
};

const leaseIsFree = (w: ReturnType<typeof world>) => {
  const ledger = w.seed();
  try {
    return ledger.acquireLease(w.runId).held;
  } finally {
    ledger.releaseLease(w.runId);
    ledger.close();
  }
};

describe('prepareRun', () => {
  test('an orphan sweep that throws stops the run with its message and takes no lease', async () => {
    const w = world();
    const prepared = await prepareRun({
      ...w.opts,
      sweepOrphanVolumes: () => {
        throw new Error('Cannot list the sandbox volumes');
      },
    });
    expect(prepared).toEqual({
      status: 'orphan_sweep_failed',
      leftovers: [],
      message: 'Cannot list the sandbox volumes',
    });
    expect(leaseIsFree(w)).toBe(true);
  });

  test("a held lease stops the run with the holder's pid and leaves the lease with its holder", async () => {
    const w = world();
    const other = w.seed();
    expect(other.acquireLease(w.runId, process.ppid).held).toBe(true);
    other.close();
    const prepared = await prepareRun(w.opts);
    expect(prepared).toMatchObject({ status: 'held', pid: process.ppid });
    expect(w.fetched).toEqual([]);
    const after = w.seed();
    expect(after.acquireLease(w.runId)).toEqual({
      held: false,
      pid: process.ppid,
    });
    after.close();
  });

  test('a run that is already done stops with its PR and releases the lease', async () => {
    const w = world();
    const ledger = w.seed();
    ledger.startRun(w.runId, w.job, 'a'.repeat(40), 'main');
    ledger.appendEvent(w.runId, 0, { type: 'Dequeued' });
    ledger.appendEvent(w.runId, 1, { type: 'AgentFinished' });
    ledger.appendEvent(w.runId, 2, {
      type: 'ReviewPassed',
      oid: 'a'.repeat(40),
    });
    ledger.appendEvent(w.runId, 3, {
      type: 'PrOpened',
      pr: 'https://github.com/o/r/pull/1',
    });
    ledger.close();
    const prepared = await prepareRun({
      ...w.opts,
      checkCanOpenPr: () => {
        throw new Error('must not be asked of a finished run');
      },
    });
    expect(prepared).toMatchObject({
      status: 'already_done',
      pr: 'https://github.com/o/r/pull/1',
    });
    expect(leaseIsFree(w)).toBe(true);
  });

  test('a project that cannot open a PR stops the run before it starts and releases the lease', async () => {
    const w = world();
    const prepared = await prepareRun({
      ...w.opts,
      checkCanOpenPr: () => {
        throw new Error('gh cannot reach the repository');
      },
    });
    expect(prepared).toMatchObject({
      status: 'cannot_open_pr',
      message: 'gh cannot reach the repository',
    });
    const ledger = w.seed();
    expect(ledger.base(w.runId)).toBeUndefined();
    ledger.close();
    expect(w.fetched).toEqual([]);
    expect(leaseIsFree(w)).toBe(true);
  });

  test('a ready run carries what the orphan sweep skipped and failed to remove', async () => {
    const w = world();
    const sweeps = {
      leftovers: [],
      orphans: {
        skipped: [{ runId: 'x', reason: 'unlabelled' }],
        failed: [{ runId: 'y', error: 'busy' }],
      },
    };
    const prepared = ready(
      await prepareRun({
        ...w.opts,
        sweepOrphanVolumes: () => ({ removed: [], ...sweeps.orphans }),
      })
    );
    expect(prepared.sweeps).toEqual(sweeps);
    await prepared.drive();
  });

  test('a run with no recorded base is started from the origin base, and one with a base is resumed without fetching again', async () => {
    const w = world();
    const first = ready(
      await prepareRun({
        ...w.opts,
        openAgent: async () => {
          throw new Error('daemon down');
        },
      })
    );
    expect(first.start).toBe('started');
    await expect(first.drive()).rejects.toThrow('daemon down');
    const ledger = w.seed();
    expect(ledger.base(w.runId)).toBe(git(w.job.repo, 'rev-parse', 'HEAD'));
    expect(ledger.baseBranch(w.runId)).toBe('main');
    ledger.close();

    const second = ready(
      await prepareRun({ ...w.opts, openAgent: async () => endsEarly() })
    );
    expect(second.start).toBe('resumed');
    expect(w.fetched).toHaveLength(1);
    await second.drive();
  });

  test('a run recorded with a base but no base branch is resumed, then fails to drive and releases the lease', async () => {
    const w = world();
    const ledger = w.seed();
    // Runs started before the base branch was recorded have no such key.
    ledger.startRun(w.runId, w.job, 'a'.repeat(40), undefined as never);
    ledger.close();
    const prepared = ready(await prepareRun(w.opts));
    expect(prepared.start).toBe('resumed');
    await expect(prepared.drive()).rejects.toThrow(
      `Run ${w.runId} has no recorded base branch`
    );
    expect(leaseIsFree(w)).toBe(true);
  });

  test('a key that cannot be read stops the start with the sweeps and the error, and releases the lease', async () => {
    const w = world();
    const prepared = await prepareRun({
      ...w.opts,
      readOpenRouterKey: () => {
        throw new Error('No OpenRouter key');
      },
    });
    expect(prepared).toMatchObject({
      status: 'error',
      sweeps: { leftovers: [], orphans: { skipped: [], failed: [] } },
      error: new Error('No OpenRouter key'),
    });
    expect(leaseIsFree(w)).toBe(true);
  });
});

describe('drive', () => {
  test('a run that stops without a PR to open is finished, reports its state and cost, and releases the lease', async () => {
    const w = world();
    const call = {
      entryId: 1,
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.25,
    };
    const prepared = ready(
      await prepareRun({
        ...w.opts,
        openAgent: async () => endsEarly([call]),
      })
    );
    expect(await prepared.drive()).toEqual({ status: 'finished' });
    expect(w.reports.at(-1)).toMatchObject({
      state: { status: 'parked' },
      cost: 0.25,
    });
    expect(w.closed).toEqual(['sandbox']);
    expect(leaseIsFree(w)).toBe(true);
  });

  test('a run that passed review but could not open its PR says so, and can be started again', async () => {
    const w = world();
    const prepared = ready(
      await prepareRun({
        ...w.opts,
        openAgent: async () =>
          session(async () => ({
            event: { type: 'AgentFinished' },
            calls: [],
          })),
        review: async () => ({
          event: { type: 'ReviewPassed', oid: 'a'.repeat(40) },
          results: [],
        }),
      })
    );
    const end = await prepared.drive();
    expect(end).toMatchObject({ status: 'pr_not_opened' });
    expect(end.status === 'pr_not_opened' && end.error).not.toBe('');
    expect(leaseIsFree(w)).toBe(true);
    const ledger = w.seed();
    expect(replay(ledger.events(w.runId)).state).toMatchObject({
      status: 'in_review',
      step: 'opening_pr',
    });
    ledger.close();
  });

  test('any other crash is rethrown, and the lease is still released', async () => {
    const w = world();
    const prepared = ready(
      await prepareRun({
        ...w.opts,
        openAgent: async () =>
          session(async () => {
            throw new Error('model unreachable');
          }),
      })
    );
    await expect(prepared.drive()).rejects.toThrow('model unreachable');
    expect(w.closed).toEqual(['sandbox']);
    expect(leaseIsFree(w)).toBe(true);
  });
});
