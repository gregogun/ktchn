import { describe, expect, test } from 'vitest';
import { makeJob } from './job.ts';

const spec = {
  repo: '/repo',
  text: 'Add a README',
  checks: ['pnpm test'],
  model: 'm',
  reviewerProvider: 'openrouter' as const,
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

  test('a different reviewer provider makes a different run', () => {
    expect(
      makeJob({ ...spec, reviewerProvider: 'claude-code' }).runId
    ).not.toBe(makeJob(spec).runId);
  });

  test('allowing the network makes a different run', () => {
    expect(makeJob({ ...spec, policy: { network: true } }).runId).not.toBe(
      makeJob(spec).runId
    );
  });

  describe('with a workflow', () => {
    const workflow = {
      name: 'flow',
      method: 'm',
      skills: [{ name: 'tdd', text: 'one' }],
      findingsSkills: [],
    };

    test('a job without a workflow keeps the run id it has always had', () => {
      expect(makeJob(spec).runId).toBe('30fe30b4d211');
    });

    test('a workflow makes a different run', () => {
      expect(makeJob({ ...spec, workflow }).runId).not.toBe(
        makeJob(spec).runId
      );
    });

    test('a workflow with the same name and different text is the same run', () => {
      const edited = {
        ...workflow,
        method: 'changed',
        skills: [{ name: 'tdd', text: 'two' }],
      };
      expect(makeJob({ ...spec, workflow: edited }).runId).toBe(
        makeJob({ ...spec, workflow }).runId
      );
    });
  });
});
