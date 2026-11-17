import { describe, expect, test } from 'vitest';
import { modelCallOf } from './session.ts';

const assistantEntry = (provider: string) => ({
  id: 4,
  kind: 'pi.assistant',
  model: [
    {
      model: 'claude-opus-5-5',
      provider,
      usage: {
        input: 2,
        output: 145,
        cacheRead: 10,
        cacheWrite: 1177,
        cost: { total: 0.0123 },
      },
    },
  ],
});

describe('a model call read from the session', () => {
  test('a call through the Claude subscription keeps its tokens and costs 0', () => {
    expect(modelCallOf(assistantEntry('claude-code'))).toEqual({
      entryId: 4,
      model: 'claude-opus-5-5',
      billing: 'subscription',
      inputTokens: 2,
      outputTokens: 145,
      cacheReadTokens: 10,
      cacheWriteTokens: 1177,
      cost: 0,
    });
  });

  test('a call through OpenRouter keeps the price it reported', () => {
    expect(modelCallOf(assistantEntry('openrouter'))).toMatchObject({
      billing: 'api',
      cost: 0.0123,
    });
  });

  test('an entry that is not a model reply is not a call', () => {
    expect(modelCallOf({ id: 1, kind: 'pi.user' })).toBeUndefined();
  });
});
