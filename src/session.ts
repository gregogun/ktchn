import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels, type Models } from '@earendil-works/pi-ai/models';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import {
  getClaudeStatus,
  LOGIN_HINT,
} from '@earendil-works/pi-claude-code/dist/claude-cli.js';
import { createClaudeCodeProvider } from '@earendil-works/pi-claude-code/dist/provider.js';
import {
  createRegistry,
  defineExtension,
  Harness,
  type Storage,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import type { ModelCall } from './ledger.ts';

const openRouterModels = (apiKey: string): Models => {
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

/* claude-code sends each request through the owner's own `claude` CLI, so it
   bills their Claude subscription and its login never leaves Claude Code.
*/
const claudeCodeModels = (): Models => {
  const models = createModels();
  models.setProvider(createClaudeCodeProvider());
  return models;
};

/* A Claude Code login by API key would bill each call while ktchn records it
   at cost 0, so only a subscription login counts as ready.
*/
const claudeCodeReady = async () => {
  const status = await getClaudeStatus(process.env);
  if (!status.available || !status.loggedIn) {
    throw new Error(status.detail ?? LOGIN_HINT);
  }
  if (!status.subscription) {
    throw new Error(
      'Claude Code is not signed in with a Claude subscription. Run `claude auth login` with a Pro or Max account.'
    );
  }
};

type Billing = 'api' | 'subscription';

const PROVIDERS = {
  openrouter: {
    billing: 'api',
    models: openRouterModels,
    ready: async () => {},
  },
  'claude-code': {
    billing: 'subscription',
    models: claudeCodeModels,
    ready: claudeCodeReady,
  },
} as const satisfies Record<
  string,
  {
    billing: Billing;
    models: (openRouterKey: string) => Models;
    ready: () => Promise<void>;
  }
>;

export type ProviderId = keyof typeof PROVIDERS;

export const isProviderId = (value: string): value is ProviderId =>
  Object.hasOwn(PROVIDERS, value);

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export const modelsFor = (provider: ProviderId, openRouterKey: string) =>
  PROVIDERS[provider].models(openRouterKey);

export const checkProviderReady = (provider: ProviderId) =>
  PROVIDERS[provider].ready();

const billingOf = (provider: string | undefined): Billing =>
  provider !== undefined && isProviderId(provider)
    ? PROVIDERS[provider].billing
    : 'api';

type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
};

type AssistantMessage = {
  model?: string;
  provider?: string;
  usage?: Usage;
  content?: unknown;
};

type EntryView = { id: number; kind: string; model?: readonly unknown[] };

const assistantMessage = (entry: EntryView) =>
  entry.kind === 'pi.assistant'
    ? (entry.model?.[0] as AssistantMessage | undefined)
    : undefined;

export const modelCallOf = (entry: EntryView): ModelCall | undefined => {
  const message = assistantMessage(entry);
  if (message?.usage === undefined) return undefined;
  const billing = billingOf(message.provider);
  return {
    entryId: entry.id,
    model: message.model ?? 'unknown',
    billing,
    inputTokens: message.usage.input,
    outputTokens: message.usage.output,
    cacheReadTokens: message.usage.cacheRead,
    cacheWriteTokens: message.usage.cacheWrite,
    cost: billing === 'subscription' ? 0 : message.usage.cost.total,
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
  provider: string;
  instructions?: string;
  tools: 'coding' | readonly ToolRegistration[];
  env?: ExecutionEnv;
  cwd?: string;
  maxTurns?: number;
}) => {
  const registry = createRegistry();
  registry.install(
    opts.tools === 'coding'
      ? CodingTools
      : defineExtension({ name: 'tools', tools: [...opts.tools] })
  );
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
        provider: opts.provider,
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
        const call = modelCallOf(entry);
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
