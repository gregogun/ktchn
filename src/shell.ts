import { ensureClone, handOff, removeRun } from './clone.ts';
import type { AgentOutcome, RunShell } from './driver.ts';
import type { AgentRequest, Job } from './ledger.ts';
import { openPr, prText } from './pr.ts';
import { reviewRun } from './review.ts';
import {
  collect,
  CollectRefused,
  openSandbox,
  removeSandboxes,
  sandboxName,
  seed,
  type AgentSandbox,
  type Sandbox,
} from './sandbox.ts';
import type { RunState } from './run-machine.ts';

export type SandboxPort = {
  open: typeof openSandbox;
  removeAll: typeof removeSandboxes;
  seed: typeof seed;
  collect: typeof collect;
};

export const realSandboxes: SandboxPort = {
  open: openSandbox,
  removeAll: removeSandboxes,
  seed,
  collect,
};

export type AgentSession = {
  run: (request: AgentRequest) => Promise<AgentOutcome>;
  close: () => Promise<void>;
};

export const buildShell = (opts: {
  home: string;
  runId: string;
  job: Job;
  image: string;
  base: string;
  baseBranch: string;
  openAgent: (sandbox: AgentSandbox) => Promise<AgentSession>;
  report: (state: RunState) => void;
  sandboxes?: SandboxPort;
  review?: typeof reviewRun;
  gh?: string;
}) => {
  const { job, runId } = opts;
  const sandboxes = opts.sandboxes ?? realSandboxes;
  const review = opts.review ?? reviewRun;
  let clone: string | undefined;
  let open:
    { sandbox: Sandbox; round?: number; agent?: AgentSession } | undefined;
  const theClone = () =>
    (clone ??= ensureClone({
      home: opts.home,
      runId,
      source: job.repo,
      base: opts.base,
      branch: job.branch,
    }));

  const closeRound = async () => {
    const round = open;
    open = undefined;
    try {
      await round?.agent?.close();
    } finally {
      await round?.sandbox.close();
    }
  };

  const beginRound = async () => {
    await closeRound();
    sandboxes.removeAll(runId, false);
    return theClone();
  };

  const seedRound = (sandbox: Sandbox, source: string) =>
    sandboxes.seed(sandbox, {
      repo: source,
      ref: `refs/heads/${job.branch}`,
      branch: job.branch,
    });

  const agentRound = async (round: number) => {
    if (open?.round === round && open.agent !== undefined) return open.agent;
    const source = await beginRound();
    const sandbox = await sandboxes.open({
      kind: 'agent',
      runId,
      name: sandboxName(runId, round),
      image: opts.image,
      home: opts.home,
      network: job.policy.network,
    });
    open = { sandbox, round };
    try {
      await seedRound(sandbox, source);
      const agent = await opts.openAgent(sandbox);
      open = { sandbox, round, agent };
      return agent;
    } catch (error) {
      await closeRound();
      throw error;
    }
  };

  const collectRound = async () => {
    const source = await beginRound();
    const sandbox = await sandboxes.open({
      kind: 'collect',
      runId,
      name: `ktchn-${runId}-collect`,
      image: opts.image,
      home: opts.home,
    });
    open = { sandbox };
    await seedRound(sandbox, source);
    return sandboxes.collect({
      sandbox,
      repo: source,
      branch: job.branch,
      base: opts.base,
    });
  };

  const shell: RunShell = {
    runAgent: async (request) =>
      (await agentRound(request.number)).run(request),
    runReview: async () => {
      let collected;
      try {
        collected = await collectRound();
      } catch (error) {
        if (!(error instanceof CollectRefused)) throw error;
        return {
          event: { type: 'ReviewFailed', findings: error.message },
          results: [],
        };
      } finally {
        await closeRound();
      }
      return review({
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
    openPr: async (oid, checks) => {
      handOff({
        owner: job.repo,
        clone: theClone(),
        branch: job.branch,
        oid,
        base: opts.base,
      });
      sandboxes.removeAll(runId, true);
      return openPr({
        repo: job.repo,
        branch: job.branch,
        baseBranch: opts.baseBranch,
        gh: opts.gh,
        ...prText(runId, job, checks),
      });
    },
    discard: async () => {
      await closeRound();
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
