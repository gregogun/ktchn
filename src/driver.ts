import type { AgentOutcome } from './agent.ts';
import type { Ledger } from './ledger.ts';
import type { CheckResult, ReviewOutcome } from './review.ts';
import {
  isTerminal,
  replay,
  type AgentRequest,
  type RunEvent,
  type RunState,
} from './run-machine.ts';

export type RunShell = {
  runAgent: (request: AgentRequest) => Promise<AgentOutcome>;
  runReview: () => Promise<ReviewOutcome>;
  closeSandbox: () => Promise<void>;
  openPr: (oid: string, checks: readonly CheckResult[]) => Promise<string>;
  discard: () => Promise<void>;
  report: (state: RunState) => void;
};

const append = (ledger: Ledger, runId: string, at: number, event: RunEvent) => {
  if (!ledger.appendEvent(runId, at, event)) {
    throw new Error(
      `Run ${runId} already has an event at position ${at}; another driver is carrying it out. Stopping.`
    );
  }
};

const lastChecks = (ledger: Ledger, runId: string) =>
  ledger
    .records(runId)
    .flatMap((r) => (r.kind === 'checks_ran' ? [r.results] : []))
    .at(-1) ?? [];

export const driveRun = async (
  ledger: Ledger,
  runId: string,
  shell: RunShell
): Promise<RunState> => {
  let run = replay(ledger.events(runId));
  if (
    run.state.status === 'running' ||
    (run.state.status === 'in_review' && run.state.step === 'reviewing')
  ) {
    append(ledger, runId, run.events, { type: 'Crashed' });
    run = replay(ledger.events(runId));
  }

  for (;;) {
    if (run.state.status === 'queued') {
      append(ledger, runId, run.events, { type: 'Dequeued' });
    } else {
      const effect = run.effects.find(
        (e) =>
          e.type === 'RunAgent' || e.type === 'RunReview' || e.type === 'OpenPr'
      );
      if (effect?.type === 'RunAgent') {
        if (run.agentRequest === undefined) {
          throw new Error(`Run ${runId} resumed an agent it never started`);
        }
        const { event, calls } = await shell.runAgent(run.agentRequest);
        for (const call of calls) ledger.recordModelCall(runId, call);
        append(ledger, runId, run.events, event);
      } else if (effect?.type === 'RunReview') {
        const { event, results } = await shell.runReview();
        ledger.recordChecks(runId, run.events, results);
        append(ledger, runId, run.events, event);
      } else if (effect?.type === 'OpenPr') {
        const pr = await shell.openPr(effect.oid, lastChecks(ledger, runId));
        append(ledger, runId, run.events, { type: 'PrOpened', pr });
      } else {
        if (run.effects.some((e) => e.type === 'KillSandbox')) {
          await shell.closeSandbox();
        }
        if (isTerminal(run.state)) await shell.discard();
        shell.report(run.state);
        return run.state;
      }
    }
    run = replay(ledger.events(runId));
  }
};
