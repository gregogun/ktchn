import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import type { RemoteExecutionEnv } from '@earendil-works/pi-env';
import type { AgentOutcome } from './driver.ts';
import type { AgentRequest, FreshAgentInput, ModelCall } from './ledger.ts';
import { WORKSPACE } from './sandbox.ts';

export const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash-0731';
const MAX_TURNS = 40;

// Takes the key out of the process environment as it reads it, so nothing
// that copies the environment later can carry it into a sandbox.
export const readOpenRouterKey = (): string => {
  const fromEnv = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  if (fromEnv) return fromEnv;
  const auth = JSON.parse(
    readFileSync(join(homedir(), '.pi/agent/auth.json'), 'utf8')
  ) as { openrouter?: { key?: unknown } };
  const key = auth.openrouter?.key;
  if (typeof key !== 'string' || key === '') {
    throw new Error(
      'No OpenRouter key: set OPENROUTER_API_KEY or add openrouter.key to ~/.pi/agent/auth.json'
    );
  }
  return key;
};

const prompt = (input: FreshAgentInput, jobText: string) => {
  switch (input.kind) {
    case 'job':
      return [
        jobText,
        '',
        'Work in the current directory. Commit your work on the current branch when you are done. Do not push, and do not move or switch branches.',
      ].join('\n');
    case 'findings':
      return `Review's checks failed:\n\n${input.findings}\n\nFix the problems and commit on the current branch.`;
    case 'answer':
      return input.answer;
  }
};

type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
};

const modelCall = (entry: {
  id: number;
  kind: string;
  model?: readonly unknown[];
}): ModelCall | undefined => {
  if (entry.kind !== 'pi.assistant') return undefined;
  const message = entry.model?.[0] as
    { model?: string; usage?: Usage } | undefined;
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

export const openAgent = async (opts: {
  runId: string;
  storePath: string;
  env: RemoteExecutionEnv;
  model: string;
  jobText: string;
  apiKey: string;
}) => {
  const { apiKey } = opts;
  const models = createModels({
    credentials: {
      read: async () => ({ type: 'api_key', key: apiKey }),
      list: async () => [{ providerId: 'openrouter', type: 'api_key' }],
      modify: async () => ({ type: 'api_key', key: apiKey }),
      delete: async () => {},
    },
  });
  models.setProvider(openrouterProvider());
  const registry = createRegistry();
  registry.install(CodingTools);

  const harness = await Harness.open(
    await openNodeSqliteStorage(opts.storePath),
    { models, registry, env: () => opts.env },
    ctx
  );
  const root = await harness.root(ctx, {
    agent: {
      model: { provider: 'openrouter', modelId: opts.model },
      cwd: WORKSPACE,
      maxTurns: MAX_TURNS,
    },
  });
  // Carries on whatever the previous process left running.
  harness.resume();

  const modelCalls = async () => {
    const calls: ModelCall[] = [];
    let cursor: Parameters<typeof root.entries>[2];
    do {
      const page = await root.entries({ order: 'ascending' }, 100, cursor, ctx);
      for (const entry of page.items) {
        const call = modelCall(entry);
        if (call) calls.push(call);
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return calls;
  };

  return {
    run: async ({ input, number }: AgentRequest): Promise<AgentOutcome> => {
      const submission = await root.submit(
        {
          type: 'input',
          content: prompt(input, opts.jobText),
          requestId: `${opts.runId}:${number}`,
        },
        ctx
      );
      const settled = await submission.wait(ctx);
      const calls = await modelCalls();
      if (settled.status !== 'done') {
        return {
          event: {
            type: 'AgentEndedEarly',
            reason: `Agent run ended without an answer: ${JSON.stringify(settled)}`,
          },
          calls,
        };
      }
      return { event: { type: 'AgentFinished' }, calls };
    },
    close: () => harness.close(ctx),
  };
};
