import { describe, expect, test } from 'vitest';
import { makeJob } from './job.ts';

const spec = {
  repo: '/repo',
  text: 'Add a README',
  checks: ['pnpm test'],
  model: 'm',
  allowPaths: [],
};

describe('makeJob', () => {
  test('the same job is the same run and its branch carries the run id', () => {
    const a = makeJob(spec);
    expect(makeJob({ ...spec }).runId).toBe(a.runId);
    expect(a.job.branch).toBe(`ktchn/${a.runId}`);
  });

  test('allowed paths make a different run', () => {
    expect(makeJob({ ...spec, allowPaths: ['package.json'] }).runId).not.toBe(
      makeJob(spec).runId
    );
  });
});
