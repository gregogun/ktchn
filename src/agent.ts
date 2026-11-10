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
import type { ModelCall } from './ledger.ts';
import { boundAgentEnv } from './agent-env.ts';
import { COPY_PATH } from './box-scripts.ts';
import type { Job } from './job.ts';
import type { AgentRequest, FreshAgentInput, RunEvent } from './run-machine.ts';

export type AgentOutcome = {
  event: Extract<
    RunEvent,
    { type: 'AgentFinished' | 'AgentAsked' | 'AgentEndedEarly' }
  >;
  calls: readonly ModelCall[];
};

export const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash-0731';
const MAX_TURNS = 40;

export const readOpenRouterKey = (): string => {
  const fromEnv = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  if (fromEnv) return fromEnv;
  const authPath = join(homedir(), '.pi/agent/auth.json');
  let auth: { openrouter?: { key?: unknown } };
  try {
    auth = JSON.parse(readFileSync(authPath, 'utf8')) as {
      openrouter?: { key?: unknown };
    };
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      throw new Error(
        `no OpenRouter key found in ${authPath}; sign in with pi first`,
        { cause: error }
      );
    }
    throw error;
  }
  const key = auth.openrouter?.key;
  if (typeof key !== 'string' || key === '') {
    throw new Error(
      'No OpenRouter key: set OPENROUTER_API_KEY or add openrouter.key to ~/.pi/agent/auth.json'
    );
  }
  return key;
};

type PromptJob = Pick<Job, 'text' | 'policy' | 'checks'>;

const sandboxBriefing = (job: PromptJob) => [
  job.policy.network
    ? 'This sandbox has network access.'
    : 'This sandbox has no network, so nothing can be downloaded.',
  ...(job.checks.length === 0
    ? []
    : [
        'After your work, the kitchen runs these checks. They work in this sandbox as it is, so run them yourself first:',
        ...job.checks.map((command) => `- ${command}`),
      ]),
  'The project commit hooks may run when you commit. If a hook refuses the commit, fix what it reports and commit again. Never use --no-verify.',
  'Commit once your own check of the goal passes.',
];

export const prompt = (input: FreshAgentInput, job: PromptJob) => {
  switch (input.kind) {
    case 'job':
      return [
        job.text,
        '',
        ...sandboxBriefing(job),
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
  job: Job;
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
  const env = boundAgentEnv(opts.env);
  const registry = createRegistry();
  registry.install(CodingTools);

  const harness = await Harness.open(
    await openNodeSqliteStorage(opts.storePath),
    { models, registry, env: () => env },
    ctx
  );
  const root = await harness.root(ctx, {
    agent: {
      model: { provider: 'openrouter', modelId: opts.model },
      cwd: COPY_PATH,
      maxTurns: MAX_TURNS,
    },
  });
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
          content: prompt(input, opts.job),
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
