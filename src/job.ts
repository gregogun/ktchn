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

export const makeJob = (
  spec: Omit<Job, 'branch'>
): { runId: string; job: Job } => {
  const runId = createHash('sha256')
    .update(
      JSON.stringify([
        spec.repo,
        spec.text,
        spec.checks,
        spec.model,
        spec.allowPaths,
        spec.policy.network,
        ...(spec.workflow ? [spec.workflow.name] : []),
      ])
    )
    .digest('hex')
    .slice(0, 12);
  return { runId, job: { ...spec, branch: `ktchn/${runId}` } };
};
