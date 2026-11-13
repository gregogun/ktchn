import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels, type Models } from '@earendil-works/pi-ai/models';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import {
  createRegistry,
  Harness,
  type Storage,
} from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import type { ModelCall } from './ledger.ts';

export const openRouterModels = (apiKey: string): Models => {
  const models = createModels({
    credentials: {
      read: async () => ({ type: 'api_key', key: apiKey }),
      list: async () => [{ providerId: 'openrouter', type: 'api_key' }],
      modify: async () => ({ type: 'api_key', key: apiKey }),
      delete: async () => {},
    },
  });
  models.setProvider(openrouterProvider());
  return models;
};

type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
};

type AssistantMessage = {
  model?: string;
  usage?: Usage;
  content?: unknown;
};

type EntryView = { id: number; kind: string; model?: readonly unknown[] };

const assistantMessage = (entry: EntryView) =>
  entry.kind === 'pi.assistant'
    ? (entry.model?.[0] as AssistantMessage | undefined)
    : undefined;

const modelCall = (entry: EntryView): ModelCall | undefined => {
  const message = assistantMessage(entry);
  if (message?.usage === undefined) return undefined;
  return {
    entryId: entry.id,
    model: message.model ?? 'unknown',
    inputTokens: message.usage.input,
    outputTokens: message.usage.output,
    cacheReadTokens: message.usage.cacheRead,
    cacheWriteTokens: message.usage.cacheWrite,
    cost: message.usage.cost.total,
  };
};

const textOf = (message: AssistantMessage): string | undefined => {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const text = (message.content as { type?: string; text?: string }[])
    .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
    .join('');
  return text === '' ? undefined : text;
};

export type SessionResult = {
  status: 'done' | 'unanswered';
  settled: unknown;
  reply: string | undefined;
  calls: readonly ModelCall[];
};

export const openSession = async (opts: {
  storage: Storage;
  models: Models;
  model: string;
  provider?: string;
  instructions?: string;
  tools?: 'coding' | 'none';
  env?: ExecutionEnv;
  cwd?: string;
  maxTurns?: number;
}) => {
  const registry = createRegistry();
  if (opts.tools !== 'none') registry.install(CodingTools);
  const { env } = opts;

  const harness = await Harness.open(
    opts.storage,
    {
      models: opts.models,
      registry,
      env: env && (() => env),
    },
    ctx
  );
  const root = await harness.root(ctx, {
    agent: {
      model: {
        provider: opts.provider ?? 'openrouter',
        modelId: opts.model,
      },
      instructions: opts.instructions,
      cwd: opts.cwd,
      maxTurns: opts.maxTurns,
    },
  });
  harness.resume();

  const readEntries = async () => {
    const calls: ModelCall[] = [];
    let reply: string | undefined;
    let cursor: Parameters<typeof root.entries>[2];
    do {
      const page = await root.entries({ order: 'ascending' }, 100, cursor, ctx);
      for (const entry of page.items) {
        const call = modelCall(entry);
        if (call) calls.push(call);
        const message = assistantMessage(entry);
        if (message !== undefined) reply = textOf(message);
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return { calls, reply };
  };

  return {
    submit: async (
      content: string,
      requestId: string
    ): Promise<SessionResult> => {
      const submission = await root.submit(
        { type: 'input', content, requestId },
        ctx
      );
      const settled = await submission.wait(ctx);
      const { calls, reply } = await readEntries();
      return {
        status: settled.status === 'done' ? 'done' : 'unanswered',
        settled,
        reply,
        calls,
      };
    },
    close: () => harness.close(ctx),
  };
};
