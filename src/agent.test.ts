import { afterEach, describe, expect, test } from 'vitest';
import { prompt, readOpenRouterKey } from './agent.ts';
import type { Job } from './job.ts';
import { prText } from './pr.ts';

describe('readOpenRouterKey', () => {
  const saved = process.env.OPENROUTER_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved;
  });

  test('returns the key and leaves none in the process environment', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    expect(readOpenRouterKey()).toBe('sk-or-test');
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(Object.values(process.env)).not.toContain('sk-or-test');
  });

  test('tells the owner to sign in when no auth file exists, without a raw ENOENT', () => {
    expect(() => readOpenRouterKey()).toThrow(
      /no OpenRouter key found in .*sign in with pi first/i
    );
    try {
      readOpenRouterKey();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toMatch(/ENOENT/);
    }
  });
});

describe('the first prompt', () => {
  const job = (network: boolean): Job => ({
    repo: '/repo',
    branch: 'ktchn/r1',
    text: 'Fix the token bug',
    policy: { network },
    checks: ['pnpm test', 'pnpm lint'],
    allowPaths: [],
    model: 'm',
  });
  const first = (network: boolean) => prompt({ kind: 'job' }, job(network));

  test('says there is no network, lists the checks and gives the hook and commit instructions', () => {
    const text = first(false);
    expect(text.startsWith('Fix the token bug')).toBe(true);
    expect(text).toContain('no network, so nothing can be downloaded');
    expect(text).not.toContain('installed');
    expect(text).toContain('- pnpm test');
    expect(text).toContain('- pnpm lint');
    expect(text).toContain('so run them yourself first:');
    expect(text).toContain('hook');
    expect(text).toContain('--no-verify');
    expect(text).toContain('Commit once');
  });

  test('says network is available when the policy allows it', () => {
    expect(first(true)).toContain('has network access');
    expect(first(true)).not.toContain('no network');
  });

  test('stays out of the PR body, which carries the job text only', () => {
    const { body } = prText('r1', job(false), []);
    expect(body).toContain('Fix the token bug');
    expect(body).not.toContain('no network');
    expect(body).not.toContain('--no-verify');
  });
});
