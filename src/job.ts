import { createHash } from 'node:crypto';
import type { Workflow } from './workflow.ts';

type Policy = { network: boolean };

export type Job = {
  policy: Policy;
  repo: string;
  branch: string;
  text: string;
  checks: readonly string[];
  allowPaths: readonly string[];
  model: string;
  workflow?: Workflow;
};

export const runIdOf = (
  spec: Omit<Job, 'branch' | 'workflow'>,
  workflow: string | undefined
) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        spec.repo,
        spec.text,
        spec.checks,
        spec.model,
        spec.allowPaths,
        spec.policy.network,
        ...(workflow === undefined ? [] : [workflow]),
      ])
    )
    .digest('hex')
    .slice(0, 12);

export const makeJob = (
  spec: Omit<Job, 'branch'>
): { runId: string; job: Job } => {
  const runId = runIdOf(spec, spec.workflow?.name);
  return { runId, job: { ...spec, branch: `ktchn/${runId}` } };
};
