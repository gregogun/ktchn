import { describe, expect, test } from 'vitest';
import { makeJob } from './job.ts';

const spec = {
  repo: '/repo',
  text: 'Add a README',
  checks: ['pnpm test'],
  model: 'm',
  reviewerModel: 'rm',
  allowPaths: [],
  policy: { network: false },
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

  test('a different reviewer model makes a different run', () => {
    expect(makeJob({ ...spec, reviewerModel: 'other' }).runId).not.toBe(
      makeJob(spec).runId
    );
  });

  test('allowing the network makes a different run', () => {
    expect(makeJob({ ...spec, policy: { network: true } }).runId).not.toBe(
      makeJob(spec).runId
    );
  });
});
