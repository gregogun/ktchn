import { createHash } from 'node:crypto';
import type { Job } from './ledger.ts';

// The same job names the same run, so running it again resumes it.
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
      ])
    )
    .digest('hex')
    .slice(0, 12);
  return { runId, job: { ...spec, branch: `ktchn/${runId}` } };
};
