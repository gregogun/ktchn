import { ensureClone, handOff, removeRun } from './clone.ts';
import type { AgentOutcome, RunShell } from './driver.ts';
import type { AgentRequest, Job } from './ledger.ts';
import { reviewRun, unreadable } from './review.ts';
import {
  collect,
  openSandbox,
  removeSandboxes,
  sandboxName,
  seed,
  type Sandbox,
} from './sandbox.ts';
import type { RunState } from './run-machine.ts';

export type AgentSession = {
  run: (request: AgentRequest) => Promise<AgentOutcome>;
  close: () => Promise<void>;
};

// Wires a run's effects to the real sandbox and review. The agent is the one
// part passed in, so a run can be driven by a scripted agent with no model.
// Each round gets its own sandbox over the run's volume. The host reads only
// the run's trusted clone, never the sandbox (ADR 0015).
export const buildShell = (opts: {
  home: string;
  runId: string;
  job: Job;
  image: string;
  // The commit the run started from, as the ledger recorded it.
  base: string;
  openAgent: (sandbox: Sandbox) => Promise<AgentSession>;
  report: (state: RunState) => void;
}) => {
  const { job, runId } = opts;
  let clone: string | undefined;
  let open: { sandbox: Sandbox; round: number } | undefined;
  let agent: AgentSession | undefined;
  const theClone = () =>
    (clone ??= ensureClone({
      home: opts.home,
      runId,
      source: job.repo,
      base: opts.base,
      branch: job.branch,
    }));

  const closeRound = async () => {
    const session = agent;
    const round = open;
    agent = undefined;
    open = undefined;
    try {
      await session?.close();
    } finally {
      await round?.sandbox.close();
    }
  };

  const openRound = async (number: number, withAgent: boolean) => {
    if (open?.round === number && (agent !== undefined || !withAgent)) return;
    await closeRound();
    // A driver that was killed left its containers running on the volume.
    removeSandboxes(runId, false);
    const sandbox = await openSandbox({
      runId,
      name: withAgent ? sandboxName(runId, number) : `ktchn-${runId}-collect`,
      image: opts.image,
      volume: true,
      piEnv: withAgent,
    });
    open = { sandbox, round: number };
    try {
      await seed(sandbox, {
        repo: theClone(),
        ref: `refs/heads/${job.branch}`,
        branch: job.branch,
      });
      if (withAgent) agent = await opts.openAgent(sandbox);
    } catch (error) {
      await closeRound();
      throw error;
    }
  };

  const shell: RunShell = {
    runAgent: async (request) => {
      await openRound(request.number, true);
      return (agent as AgentSession).run(request);
    },
    // The round's data leaves the sandbox first, then the sandbox is removed
    // and its volume kept. Review then judges one commit, resolved once, from
    // the trusted clone.
    runReview: async () => {
      let collected;
      try {
        await openRoundForCollect();
        collected = await collect({
          sandbox: (open as { sandbox: Sandbox }).sandbox,
          repo: theClone(),
          branch: job.branch,
        });
      } catch (error) {
        return {
          event: { type: 'ReviewFailed', findings: unreadable(error) },
          results: [],
        };
      } finally {
        await closeRound();
      }
      return reviewRun({
        runId,
        repo: theClone(),
        branch: job.branch,
        oid: collected.oid,
        base: opts.base,
        dirty: collected.dirty,
        image: opts.image,
        checks: job.checks,
        allowPaths: job.allowPaths,
      });
    },
    closeSandbox: closeRound,
    handOff: (oid) =>
      handOff({
        owner: job.repo,
        clone: theClone(),
        branch: job.branch,
        oid,
        base: opts.base,
      }),
    discard: async () => {
      await closeRound();
      // The run is over either way, and the next start sweeps what is left.
      try {
        removeSandboxes(runId, true);
        removeRun(opts.home, runId);
      } catch (error) {
        console.error(
          `could not remove what run ${runId} left: ${String(error)}`
        );
      }
    },
    report: opts.report,
  };

  // The agent's sandbox is still open when review follows a round. After a
  // crash there is none, and a sandbox without the agent is opened over the
  // same volume.
  const openRoundForCollect = async () => {
    if (open !== undefined) return;
    await openRound(0, false);
  };
  return { shell, close: closeRound };
};
