import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import type { RemoteExecutionEnv } from '@earendil-works/pi-env';
import type { ModelCall } from './ledger.ts';
import { boundAgentEnv } from './agent-env.ts';
import { COPY_PATH } from './box-scripts.ts';
import type { Job } from './job.ts';
import { openRouterModels, openSession } from './session.ts';
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

export const openAgent = async (opts: {
  runId: string;
  storePath: string;
  env: RemoteExecutionEnv;
  model: string;
  job: Job;
  apiKey: string;
}) => {
  const session = await openSession({
    storage: await openNodeSqliteStorage(opts.storePath),
    models: openRouterModels(opts.apiKey),
    model: opts.model,
    env: boundAgentEnv(opts.env),
    cwd: COPY_PATH,
    maxTurns: MAX_TURNS,
  });

  return {
    run: async ({ input, number }: AgentRequest): Promise<AgentOutcome> => {
      const { status, settled, calls } = await session.submit(
        prompt(input, opts.job),
        `${opts.runId}:${number}`
      );
      if (status !== 'done') {
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
    close: session.close,
  };
};
