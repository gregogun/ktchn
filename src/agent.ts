import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import type { RemoteExecutionEnv } from '@earendil-works/pi-env';
import type { ModelCall } from './ledger.ts';
import { boundAgentEnv } from './agent-env.ts';
import { COPY_PATH } from './box-scripts.ts';
import type { Job } from './job.ts';
import { modelsFor, openSession } from './session.ts';
import type { AgentRequest, FreshAgentInput, RunEvent } from './run-machine.ts';
import type { Skill } from './workflow.ts';

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

type PromptJob = Pick<Job, 'text' | 'policy' | 'checks' | 'workflow'>;

const skillBlocks = (skills: readonly Skill[]) =>
  skills.map(({ name, text }) => `<skill name="${name}">\n${text}\n</skill>`);

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

export const prompt = (
  input: FreshAgentInput,
  job: PromptJob,
  skills: readonly Skill[]
) => {
  const blocks = skillBlocks(skills);
  const lead = blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n\n`;
  switch (input.kind) {
    case 'job':
      return [
        `${job.workflow ? `${job.workflow.method}\n\n${lead}` : ''}${job.text}`,
        '',
        ...sandboxBriefing(job),
        '',
        'Work in the current directory. Commit your work on the current branch when you are done. Do not push, and do not move or switch branches.',
      ].join('\n');
    case 'findings':
      return `${lead}Review found problems with your work:\n\n${input.findings}\n\nFix the problems and commit on the current branch.`;
    case 'answer':
      return `${lead}${input.answer}`;
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
    models: modelsFor('openrouter', opts.apiKey),
    provider: 'openrouter',
    model: opts.model,
    tools: 'coding',
    env: boundAgentEnv(opts.env),
    cwd: COPY_PATH,
    maxTurns: MAX_TURNS,
  });

  return {
    run: async (
      { input, number }: AgentRequest,
      skills: readonly Skill[]
    ): Promise<AgentOutcome> => {
      const { status, settled, calls } = await session.submit(
        prompt(input, opts.job, skills),
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
