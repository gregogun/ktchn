import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openAgent, readOpenRouterKey } from './agent.ts';
import { driveRun } from './driver.ts';
import { type Job, type Ledger, openLedger } from './ledger.ts';
import { checkCanOpenPr, originBase } from './pr.ts';
import type { reviewRun } from './review.ts';
import { isTerminal, type RunState } from './run-machine.ts';
import { sweepFinishedRuns, sweepOrphanVolumes } from './run-resources.ts';
import { DEFAULT_SANDBOX_IMAGE } from './sandbox.ts';
import { buildShell, type SandboxPort } from './shell.ts';

type Leftovers = ReturnType<typeof sweepFinishedRuns>['failed'];
type Orphans = Pick<
  ReturnType<typeof sweepOrphanVolumes>,
  'skipped' | 'failed'
>;

type Sweeps = { leftovers: Leftovers; orphans: Orphans };

export type RunPreparation =
  | { status: 'orphan_sweep_failed'; leftovers: Leftovers; message: string }
  | { status: 'held'; sweeps: Sweeps; pid: number }
  | { status: 'already_done'; sweeps: Sweeps; pr: string }
  | { status: 'cannot_open_pr'; sweeps: Sweeps; message: string }
  | {
      status: 'ready';
      sweeps: Sweeps;
      start: 'started' | 'resumed';
      drive: () => Promise<RunEnd>;
    };

export type RunEnd =
  { status: 'finished' } | { status: 'pr_not_opened'; error: string };

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const modelCost = (ledger: Ledger, runId: string) =>
  ledger
    .records(runId)
    .reduce((sum, r) => sum + (r.kind === 'model_call' ? r.call.cost : 0), 0);

/* A stop outcome has released the lease and closed the ledger. A ready one
   hands both to drive(), which releases them whatever the run does, so the
   caller must call it.
*/
export const prepareRun = async (opts: {
  home: string;
  runId: string;
  job: Job;
  report: (progress: { state: RunState; cost: number }) => void;
  image?: string;
  checkCanOpenPr?: typeof checkCanOpenPr;
  originBase?: typeof originBase;
  sweepOrphanVolumes?: typeof sweepOrphanVolumes;
  readOpenRouterKey?: typeof readOpenRouterKey;
  openAgent?: typeof openAgent;
  sandboxes?: SandboxPort;
  review?: typeof reviewRun;
}): Promise<RunPreparation> => {
  const { home, runId, job } = opts;
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const ledger = openLedger(join(home, 'ledger.sqlite'));
  let handedOver = false;
  try {
    const leftovers = sweepFinishedRuns(home, ledger).failed;
    let swept;
    try {
      swept = (opts.sweepOrphanVolumes ?? sweepOrphanVolumes)(home, ledger);
    } catch (error) {
      return {
        status: 'orphan_sweep_failed',
        leftovers,
        message: messageOf(error),
      };
    }
    const sweeps = {
      leftovers,
      orphans: { skipped: swept.skipped, failed: swept.failed },
    };
    const lease = ledger.acquireLease(runId);
    if (!lease.held) return { status: 'held', sweeps, pid: lease.pid };

    const before = ledger.replay(runId).state;
    if (before.status === 'done') {
      return { status: 'already_done', sweeps, pr: before.pr };
    }
    if (!isTerminal(before)) {
      try {
        (opts.checkCanOpenPr ?? checkCanOpenPr)(job.repo);
      } catch (error) {
        return { status: 'cannot_open_pr', sweeps, message: messageOf(error) };
      }
    }
    const apiKey = (opts.readOpenRouterKey ?? readOpenRouterKey)();

    let start: 'started' | 'resumed' = 'resumed';
    if (ledger.base(runId) === undefined) {
      const origin = (opts.originBase ?? originBase)(job.repo);
      ledger.startRun(runId, job, origin.base, origin.baseBranch);
      start = 'started';
    }
    const base = ledger.base(runId);
    const baseBranch = ledger.baseBranch(runId);
    if (base === undefined || baseBranch === undefined) {
      throw new Error(`Run ${runId} has no recorded base branch`);
    }

    const { shell, close } = buildShell({
      home,
      runId,
      job,
      image: opts.image ?? DEFAULT_SANDBOX_IMAGE,
      base,
      baseBranch,
      openAgent: async ({ env }) =>
        (opts.openAgent ?? openAgent)({
          runId,
          storePath: join(home, 'sessions', `${runId}.sqlite`),
          env,
          model: job.model,
          jobText: job.text,
          apiKey,
        }),
      report: (state) => opts.report({ state, cost: modelCost(ledger, runId) }),
      sandboxes: opts.sandboxes,
      review: opts.review,
    });

    handedOver = true;
    return {
      status: 'ready',
      sweeps,
      start,
      drive: async () => {
        try {
          await driveRun(ledger, runId, shell);
          return { status: 'finished' };
        } catch (error) {
          const state = ledger.replay(runId).state;
          if (state.status !== 'in_review' || state.step !== 'opening_pr') {
            throw error;
          }
          return { status: 'pr_not_opened', error: messageOf(error) };
        } finally {
          await close();
          ledger.releaseLease(runId);
          ledger.close();
        }
      },
    };
  } finally {
    if (!handedOver) {
      // Drops only this process's own lease row, so it is a no-op when another holds it.
      ledger.releaseLease(runId);
      ledger.close();
    }
  }
};
