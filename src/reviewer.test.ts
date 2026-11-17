import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux';
import type { TranscriptContext } from '@earendil-works/pi-ai';
import { describe, expect, test } from 'vitest';
import { prompt } from './agent.ts';
import type { Job } from './job.ts';
import { MAX_DIFF_CHARS, openJudge, type JudgeInput } from './reviewer.ts';

const job: Job = {
  repo: '/repo',
  branch: 'ktchn/r1',
  text: 'Rename parseToken to readToken',
  policy: { network: true },
  checks: ['pnpm test'],
  allowPaths: [],
  model: 'agent-model',
  reviewerProvider: 'openrouter',
  reviewerModel: 'reviewer-model',
};

const input: JudgeInput = {
  jobText: job.text,
  diff: 'diff --git a/src/token.ts b/src/token.ts\n-parseToken\n+readToken',
  results: [{ command: 'pnpm test', exitCode: 0, output: 'ok' }],
};

const setup = (responses: FauxResponseStep[], provider = 'faux') => {
  const faux = fauxProvider({
    provider,
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
    judge: openJudge({ models, model: 'faux-reviewer', provider }),
  };
};

const submits = (verdict: 'pass' | 'fail', findings: string[] = []) =>
  fauxAssistantMessage(fauxToolCall('submit_verdict', { verdict, findings }), {
    stopReason: 'toolUse',
  });

const capturing = () => {
  const seen: TranscriptContext[] = [];
  const step: FauxResponseStep = (context) => {
    seen.push(context);
    return submits('pass');
  };
  return { seen, step };
};

describe('the reviewer judging a diff', () => {
  test('sees one user message with the job, the diff and the checks, and only submit_verdict', async () => {
    const { seen, step } = capturing();
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
    expect(offered?.map((tool) => tool.name)).toEqual(['submit_verdict']);
    expect(offered?.[0]?.constrainedSampling).toEqual({
      type: 'json_schema',
      strict: 'require',
    });
  });

  test('sees nothing of the agent briefing', async () => {
    const { seen, step } = capturing();
    await setup([step]).judge(input);
    const seenText = JSON.stringify(seen[0]);
    const briefing = [
      ...prompt({ kind: 'job' }, job, []).split('\n'),
      ...prompt({ kind: 'findings', findings: 'lint failed' }, job, []).split(
        '\n'
      ),
    ].filter(
      (line) =>
        line.trim() !== '' && line !== job.text && !line.startsWith('- ')
    );
    expect(briefing.some((line) => line.includes('--no-verify'))).toBe(true);
    for (const line of briefing) {
      expect(seenText).not.toContain(JSON.stringify(line).slice(1, -1));
    }
  });

  test('a pass submitted through the tool is a pass verdict', async () => {
    const { verdict } = await setup([submits('pass')]).judge(input);
    expect(verdict).toEqual({ kind: 'pass' });
  });

  test('a fail submitted through the tool carries each finding', async () => {
    const { verdict } = await setup([
      submits('fail', ['wrong function', 'no test for readToken']),
    ]).judge(input);
    expect(verdict).toEqual({
      kind: 'fail',
      findings: '- wrong function\n- no test for readToken',
    });
  });

  test('a fail with no findings still gives the agent a finding', async () => {
    const { verdict } = await setup([submits('fail')]).judge(input);
    expect(verdict).toEqual({
      kind: 'fail',
      findings: 'The reviewer gave no findings.',
    });
  });

  test('a reply without the tool call rejects, even one that says PASS', async () => {
    await expect(
      setup([fauxAssistantMessage('PASS')]).judge(input)
    ).rejects.toThrow(/did not call submit_verdict.*PASS/);
  });

  test('arguments outside the verdict schema give no verdict', async () => {
    await expect(
      setup([
        fauxAssistantMessage(
          fauxToolCall('submit_verdict', { verdict: 'maybe', findings: [] }),
          { stopReason: 'toolUse' }
        ),
      ]).judge(input)
    ).rejects.toThrow(/ended without an answer.*turn_limit/);
  });

  test('two verdicts in one reply reject instead of the last one winning', async () => {
    await expect(
      setup([
        fauxAssistantMessage(
          [
            fauxToolCall('submit_verdict', {
              verdict: 'fail',
              findings: ['wrong function'],
            }),
            fauxToolCall('submit_verdict', { verdict: 'pass', findings: [] }),
          ],
          { stopReason: 'toolUse' }
        ),
      ]).judge(input)
    ).rejects.toThrow(/called submit_verdict 2 times/);
  });

  test('a diff over the cap is cut and the prompt says so', async () => {
    const { seen, step } = capturing();
    const diff = `${'a'.repeat(MAX_DIFF_CHARS)}TAIL`;
    await setup([step]).judge({ ...input, diff });
    const text = JSON.stringify(seen[0]);
    expect(text).toContain(`${MAX_DIFF_CHARS + 4} characters`);
    expect(text).not.toContain('TAIL');
  });

  test('a diff under the cap is sent whole without a cut note', async () => {
    const { seen, step } = capturing();
    await setup([step]).judge(input);
    expect(JSON.stringify(seen[0])).not.toContain('cut to');
  });

  test('returns the model calls with the usage the model reported', async () => {
    const { model, calls } = await setup([submits('pass')]).judge(input);
    expect(model).toBe('faux-reviewer');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.billing).toBe('api');
    expect(calls[0]?.outputTokens).toBeGreaterThan(0);
    expect(
      (calls[0]?.inputTokens ?? 0) + (calls[0]?.cacheWriteTokens ?? 0)
    ).toBeGreaterThan(0);
  });

  test('a reviewer on the claude-code provider records its calls as subscription calls', async () => {
    const { calls } = await setup([submits('pass')], 'claude-code').judge(
      input
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.billing).toBe('subscription');
    expect(calls[0]?.outputTokens).toBeGreaterThan(0);
  });
});
