import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux';
import type { TranscriptContext } from '@earendil-works/pi-ai';
import { describe, expect, test } from 'vitest';
import { prompt } from './agent.ts';
import type { Job } from './job.ts';
import {
  MAX_DIFF_CHARS,
  openJudge,
  parseVerdict,
  type JudgeInput,
} from './reviewer.ts';

const job: Job = {
  repo: '/repo',
  branch: 'ktchn/r1',
  text: 'Rename parseToken to readToken',
  policy: { network: true },
  checks: ['pnpm test'],
  allowPaths: [],
  model: 'agent-model',
  reviewerModel: 'reviewer-model',
};

const input: JudgeInput = {
  jobText: job.text,
  diff: 'diff --git a/src/token.ts b/src/token.ts\n-parseToken\n+readToken',
  results: [{ command: 'pnpm test', exitCode: 0, output: 'ok' }],
};

const setup = (responses: FauxResponseStep[]) => {
  const faux = fauxProvider({
    provider: 'faux',
    models: [
      {
        id: 'faux-reviewer',
        cost: {
          input: 1_000_000,
          output: 1_000_000,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return {
    judge: openJudge({ models, model: 'faux-reviewer', provider: 'faux' }),
  };
};

const capturing = (reply: string) => {
  const seen: TranscriptContext[] = [];
  const step: FauxResponseStep = (context) => {
    seen.push(context);
    return fauxAssistantMessage(reply);
  };
  return { seen, step };
};

describe('the reviewer judging a diff', () => {
  test('sees one user message with the job, the diff and the checks, and no tools', async () => {
    const { seen, step } = capturing('PASS');
    await setup([step]).judge(input);
    const [context] = seen;
    expect(context?.messages.filter((m) => m.role !== 'system')).toHaveLength(
      1
    );
    expect(context?.messages.at(-1)?.role).toBe('user');
    const text = JSON.stringify(context);
    expect(text).toContain('Rename parseToken to readToken');
    expect(text).toContain('+readToken');
    expect(text).toContain('pnpm test');
    const offered = context?.messages.flatMap((m) =>
      m.role === 'system' ? (m.toolsAdded ?? []) : []
    );
    expect(offered).toEqual([]);
  });

  test('sees nothing of the agent briefing', async () => {
    const { seen, step } = capturing('PASS');
    await setup([step]).judge(input);
    const seenText = JSON.stringify(seen[0]);
    const briefing = [
      ...prompt({ kind: 'job' }, job).split('\n'),
      ...prompt({ kind: 'findings', findings: 'lint failed' }, job).split('\n'),
    ].filter(
      (line) =>
        line.trim() !== '' && line !== job.text && !line.startsWith('- ')
    );
    expect(briefing.some((line) => line.includes('--no-verify'))).toBe(true);
    for (const line of briefing) {
      expect(seenText).not.toContain(JSON.stringify(line).slice(1, -1));
    }
  });

  test('a PASS reply is a pass verdict', async () => {
    const { verdict } = await setup([fauxAssistantMessage('PASS')]).judge(
      input
    );
    expect(verdict).toEqual({ kind: 'pass' });
  });

  test('a FAIL reply is a fail verdict carrying its findings', async () => {
    const { verdict } = await setup([
      fauxAssistantMessage('FAIL\n- wrong function'),
    ]).judge(input);
    expect(verdict).toEqual({ kind: 'fail', findings: '- wrong function' });
  });

  test('a reply that is neither rejects', async () => {
    await expect(
      setup([fauxAssistantMessage('Looks fine to me')]).judge(input)
    ).rejects.toThrow(/did not answer PASS or FAIL.*Looks fine/);
  });

  test('a diff over the cap is cut and the prompt says so', async () => {
    const { seen, step } = capturing('PASS');
    const diff = `${'a'.repeat(MAX_DIFF_CHARS)}TAIL`;
    await setup([step]).judge({ ...input, diff });
    const text = JSON.stringify(seen[0]);
    expect(text).toContain(`${MAX_DIFF_CHARS + 4} characters`);
    expect(text).not.toContain('TAIL');
  });

  test('a diff under the cap is sent whole without a cut note', async () => {
    const { seen, step } = capturing('PASS');
    await setup([step]).judge(input);
    expect(JSON.stringify(seen[0])).not.toContain('cut to');
  });

  test('returns the model calls with the usage the model reported', async () => {
    const { model, calls } = await setup([fauxAssistantMessage('PASS')]).judge(
      input
    );
    expect(model).toBe('faux-reviewer');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.outputTokens).toBe(1);
    expect(
      (calls[0]?.inputTokens ?? 0) + (calls[0]?.cacheWriteTokens ?? 0)
    ).toBeGreaterThan(0);
  });
});

describe('parseVerdict', () => {
  test('reads the first non-empty line, ignoring case and padding', () => {
    expect(parseVerdict('\n  pass  \nbecause')).toEqual({ kind: 'pass' });
    expect(parseVerdict('Fail\n\n- a\n- b\n')).toEqual({
      kind: 'fail',
      findings: '- a\n- b',
    });
  });

  test('a FAIL with nothing after it still gives a finding', () => {
    expect(parseVerdict('FAIL')).toMatchObject({ kind: 'fail' });
    expect(parseVerdict('FAIL')).not.toEqual({ kind: 'fail', findings: '' });
  });

  test('no reply rejects', () => {
    expect(() => parseVerdict(undefined)).toThrow(/did not answer/);
  });
});
