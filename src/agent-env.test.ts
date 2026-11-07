import { describe, expect, test } from 'vitest';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import type { Context } from '@earendil-works/chord';
import type {
  ExecutionEnv,
  ShellExecOptions,
} from '@earendil-works/pi-durable/env';
import { AGENT_LIMITS, boundAgentEnv } from './agent-env.ts';
import { EXEC_TIMEOUT_MS, MAX_OUTPUT_BYTES } from './sandbox.ts';

type Run = (options: ShellExecOptions, context: Context) => Promise<unknown>;

const recorder = (run: Run = async () => ({ ok: true, value: {} })) => {
  const seen: { options: ShellExecOptions; context: Context }[] = [];
  const env = {
    cwd: '/work',
    exec: async (
      _command: string,
      options: ShellExecOptions,
      context: Context
    ) => {
      seen.push({ options, context });
      return run(options, context);
    },
    name() {
      return `${this.cwd}!`;
    },
  };
  return { env: env as unknown as ExecutionEnv, seen, raw: env };
};

const limits = {
  defaultTimeoutMs: 10_000,
  maxTimeoutMs: 30_000,
  maxOutputBytes: 100,
};

const collect = () => {
  const text: string[] = [];
  return { text, onOutput: (chunk: string) => void text.push(chunk) };
};

describe('AGENT_LIMITS', () => {
  test('match the limits ktchn puts on its own commands, with a 30 minute ceiling', () => {
    expect(AGENT_LIMITS.defaultTimeoutMs).toBe(EXEC_TIMEOUT_MS);
    expect(AGENT_LIMITS.maxOutputBytes).toBe(MAX_OUTPUT_BYTES);
    expect(AGENT_LIMITS.maxTimeoutMs).toBe(30 * 60_000);
  });
});

describe('boundAgentEnv timeouts', () => {
  test('gives a command with no timeout the default, in seconds', async () => {
    const { env, seen } = recorder();
    await boundAgentEnv(env, limits).exec('x', { cwd: '/w' }, ctx);
    expect(seen[0]?.options.timeout).toBe(10);
    expect(seen[0]?.options.cwd).toBe('/w');
  });

  test('keeps a timeout up to the ceiling and says nothing', async () => {
    const { env, seen } = recorder();
    const out = collect();
    await boundAgentEnv(env, limits).exec(
      'x',
      { timeout: 30, onOutput: out.onOutput },
      ctx
    );
    expect(seen[0]?.options.timeout).toBe(30);
    expect(out.text).toEqual([]);
  });

  test('clamps a timeout above the ceiling and tells the agent', async () => {
    const { env, seen } = recorder();
    const out = collect();
    await boundAgentEnv(env, limits).exec(
      'x',
      { timeout: 3600, onOutput: out.onOutput },
      ctx
    );
    expect(seen[0]?.options.timeout).toBe(30);
    expect(out.text.join('')).toContain('3600s is above the ceiling');
    expect(out.text.join('')).toContain('30s applies');
  });

  test('reports a timeout in the output and returns the env result unchanged', async () => {
    const failure = { ok: false, error: { code: 'timeout' } };
    const { env } = recorder(async () => failure);
    const out = collect();
    const result = await boundAgentEnv(env, limits).exec(
      'x',
      { onOutput: out.onOutput },
      ctx
    );
    expect(result).toBe(failure);
    expect(out.text.join('')).toContain('longer than 10s and was killed');
  });
});

describe('boundAgentEnv output', () => {
  test('forwards output under the limit and says nothing', async () => {
    const { env } = recorder(async (options, context) => {
      options.onOutput?.('a'.repeat(60), context, { stream: 'stdout' });
      return { ok: true, value: {} };
    });
    const out = collect();
    await boundAgentEnv(env, limits).exec('x', { onOutput: out.onOutput }, ctx);
    expect(out.text).toEqual(['a'.repeat(60)]);
  });

  test('stops forwarding past the limit, cancels the command and says so', async () => {
    let cancelled: boolean | undefined;
    const { env } = recorder(async (options, context) => {
      for (let i = 0; i < 5; i++) {
        options.onOutput?.('a'.repeat(60), context, { stream: 'stdout' });
      }
      cancelled = context.abortSignal?.aborted;
      return { ok: false, error: { code: 'aborted' } };
    });
    const out = collect();
    await boundAgentEnv(env, limits).exec('x', { onOutput: out.onOutput }, ctx);
    expect(cancelled).toBe(true);
    expect(ctx.abortSignal?.aborted).not.toBe(true);
    expect(out.text.slice(0, 1)).toEqual(['a'.repeat(60)]);
    expect(out.text).toHaveLength(2);
    expect(out.text[1]).toContain('more than 100 bytes');
    expect(out.text[1]).toContain('killed');
  });

  test('counts bytes the environment omitted against the limit', async () => {
    let cancelled: boolean | undefined;
    const { env } = recorder(async (options, context) => {
      options.onOutput?.('tail', context, {
        stream: 'stdout',
        skipped: { bytes: 500, newlines: 0, endsWithNewline: false },
      });
      cancelled = context.abortSignal?.aborted;
      return { ok: false, error: { code: 'aborted' } };
    });
    await boundAgentEnv(env, limits).exec('x', undefined, ctx);
    expect(cancelled).toBe(true);
  });
});

describe('boundAgentEnv delegation', () => {
  test('passes every other member through to the wrapped env', () => {
    const { env, raw } = recorder();
    const bound = boundAgentEnv(env, limits);
    expect(bound.cwd).toBe('/work');
    raw.cwd = '/moved';
    expect(bound.cwd).toBe('/moved');
    expect((bound as unknown as typeof raw).name()).toBe('/moved!');
  });
});
