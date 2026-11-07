import { describe, expect, test } from 'vitest';
import { reviewOutcome } from './review.ts';

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
