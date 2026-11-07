import { afterEach, describe, expect, test } from 'vitest';
import { readOpenRouterKey } from './agent.ts';

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
});
