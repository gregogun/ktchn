import { describe, expect, test } from 'vitest';
import { judgedOutcome, reviewOutcome, type ReviewOutcome } from './review.ts';
import type { Judge, Judgement, Verdict } from './reviewer.ts';

describe('reviewOutcome', () => {
  test('passes when every check exits 0', () => {
    expect(
      reviewOutcome(
        [
          { command: 'pnpm lint', exitCode: 0, output: '' },
          { command: 'pnpm test', exitCode: 0, output: 'ok' },
        ],
        'abc123'
      ).event
    ).toEqual({ type: 'ReviewPassed', oid: 'abc123' });
  });

  test('fails with the output of each failing check as findings', () => {
    const { event } = reviewOutcome(
      [
        { command: 'pnpm lint', exitCode: 0, output: 'clean' },
        { command: 'pnpm test', exitCode: 1, output: '1 failed' },
        { command: 'pnpm types:check', exitCode: 2, output: 'TS2339' },
      ],
      'abc123'
    );
    expect(event).toEqual({
      type: 'ReviewFailed',
      findings:
        '`pnpm test` exited 1:\n1 failed\n\n`pnpm types:check` exited 2:\nTS2339',
    });
  });

  test('a run with no checks passes', () => {
    expect(reviewOutcome([], 'abc123').event.type).toBe('ReviewPassed');
  });
});

describe('judgedOutcome', () => {
  const results = [{ command: 'pnpm test', exitCode: 0, output: 'ok' }];
  const passedChecks: ReviewOutcome = {
    event: { type: 'ReviewPassed', oid: 'abc123' },
    results,
  };
  const judging = (verdict: Verdict) => {
    const inputs: Parameters<Judge>[0][] = [];
    const judgement: Judgement = { model: 'rm', verdict, calls: [] };
    const judge: Judge = async (input) => {
      inputs.push(input);
      return judgement;
    };
    return { judge, inputs, judgement };
  };
  const diff = () => 'the diff';

  test('failing checks fail the review without the reviewer being asked', async () => {
    const { judge, inputs } = judging({ kind: 'pass' });
    const checked = reviewOutcome(
      [{ command: 'pnpm test', exitCode: 1, output: 'boom' }],
      'abc123'
    );
    const outcome = await judgedOutcome(checked, {
      jobText: 'job',
      diff: () => {
        throw new Error('no diff needed');
      },
      judge,
    });
    expect(outcome).toEqual(checked);
    expect(inputs).toEqual([]);
  });

  test('passing checks put the job, the diff and the results before the reviewer', async () => {
    const { judge, inputs } = judging({ kind: 'pass' });
    await judgedOutcome(passedChecks, { jobText: 'job', diff, judge });
    expect(inputs).toEqual([{ jobText: 'job', diff: 'the diff', results }]);
  });

  test('a pass verdict passes the review, with the judgement attached', async () => {
    const { judge, judgement } = judging({ kind: 'pass' });
    expect(
      await judgedOutcome(passedChecks, { jobText: 'job', diff, judge })
    ).toEqual({ ...passedChecks, judgement });
  });

  test('a fail verdict fails the review with the reviewer findings, with the judgement attached', async () => {
    const { judge, judgement } = judging({
      kind: 'fail',
      findings: '- wrong function',
    });
    const outcome = await judgedOutcome(passedChecks, {
      jobText: 'job',
      diff,
      judge,
    });
    expect(outcome.event.type).toBe('ReviewFailed');
    expect(outcome.event).toMatchObject({
      findings: expect.stringMatching(
        /does not do what the job asked[\s\S]*- wrong function/
      ),
    });
    expect(outcome.judgement).toBe(judgement);
    expect(outcome.results).toBe(results);
  });
});
