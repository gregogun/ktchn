import { ensureClone, handOff, removeRun } from './clone.ts';
import type { AgentOutcome, RunShell } from './driver.ts';
import type { AgentRequest, Job } from './ledger.ts';
import { reviewRun } from './review.ts';
import {
  collect,
  CollectRefused,
  openSandbox,
  removeSandboxes,
  sandboxName,
  seed,
  type Sandbox,
} from './sandbox.ts';
import type { RunState } from './run-machine.ts';

// The sandbox operations a run uses, so a test can stand in a recording fake.
export type SandboxPort = {
  open: typeof openSandbox;
  removeAll: typeof removeSandboxes;
  seed: typeof seed;
  collect: typeof collect;
  review: typeof reviewRun;
};

export const realSandboxes: SandboxPort = {
  open: openSandbox,
  removeAll: removeSandboxes,
  seed,
  collect,
  review: reviewRun,
};

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
  sandboxes?: SandboxPort;
}) => {
  const { job, runId } = opts;
  const sandboxes = opts.sandboxes ?? realSandboxes;
  let clone: string | undefined;
  // A number is an agent round. Collect has a sandbox of its own.
  let open: { sandbox: Sandbox; round: number | 'collect' } | undefined;
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

  const openRound = async (number: number | 'collect') => {
    const withAgent = number !== 'collect';
    if (withAgent && open?.round === number) return;
    await closeRound();
    // A driver that was killed left its containers running on the volume.
    sandboxes.removeAll(runId, false);
    // The clone comes first: a volume made before it would have nothing that
    // names it if the clone failed.
    const source = theClone();
    const sandbox = await sandboxes.open({
      runId,
      name: withAgent ? sandboxName(runId, number) : `ktchn-${runId}-collect`,
      image: opts.image,
      volume: true,
      home: opts.home,
      piEnv: withAgent,
      network: withAgent && job.policy.network,
    });
    open = { sandbox, round: number };
    try {
      await sandboxes.seed(sandbox, {
        repo: source,
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
      await openRound(request.number);
      return (agent as AgentSession).run(request);
    },
    // The agent's session and sandbox are closed first, so nothing the agent
    // left running can change the copy while it is read. The round's data
    // leaves through a collect sandbox over the same volume, which is then
    // removed and the volume kept. Review judges one commit, resolved once,
    // from the trusted clone.
    runReview: async () => {
      let collected;
      try {
        await openRound('collect');
        collected = await sandboxes.collect({
          sandbox: (open as { sandbox: Sandbox }).sandbox,
          repo: theClone(),
          branch: job.branch,
          base: opts.base,
        });
      } catch (error) {
        if (!(error instanceof CollectRefused)) throw error;
        return {
          event: { type: 'ReviewFailed', findings: error.message },
          results: [],
        };
      } finally {
        await closeRound();
      }
      return sandboxes.review({
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
        sandboxes.removeAll(runId, true);
        removeRun(opts.home, runId);
      } catch (error) {
        console.error(
          `could not remove what run ${runId} left: ${String(error)}`
        );
      }
    },
    report: opts.report,
  };

  return { shell, close: closeRound };
};
