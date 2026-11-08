import { execFileSync } from 'node:child_process';
import { checkRefName, git, tryGit } from './git.ts';
import type { CheckResult, Job } from './ledger.ts';

const GH_TIMEOUT_MS = 2 * 60_000;

const gh = (bin: string, cwd: string, args: string[], input?: string) =>
  execFileSync(bin, args, {
    cwd,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    input,
    encoding: 'utf8',
    timeout: GH_TIMEOUT_MS,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }).trim();

const stderrOf = (error: unknown) =>
  String((error as { stderr?: unknown }).stderr ?? error).trim();

export const checkCanOpenPr = (repo: string, bin = 'gh') => {
  if (
    tryGit(repo, ['remote', 'get-url', 'origin'], { scope: 'owner' }) ===
    undefined
  ) {
    throw new Error(
      `${repo} has no origin, so a run could not open its PR. Add a GitHub origin first.`
    );
  }
  try {
    gh(bin, repo, ['repo', 'view', '--json', 'url']);
  } catch (error) {
    throw new Error(
      `gh cannot reach ${repo}'s GitHub repository, so a run could not open its PR (try \`gh auth login\`): ${stderrOf(error)}`,
      { cause: error }
    );
  }
};

export const prText = (
  runId: string,
  job: Job,
  checks: readonly CheckResult[]
) => {
  const firstLine = job.text.trim().split('\n')[0] ?? '';
  const title =
    firstLine.length > 72 ? `${firstLine.slice(0, 71).trimEnd()}…` : firstLine;
  const checkLines = checks.length
    ? checks.map(
        (c) =>
          `- \`${c.command}\` ${c.exitCode === 0 ? 'passed' : `exited ${c.exitCode}`}`
      )
    : ['- none configured'];
  const body = [
    job.text.trim(),
    '',
    '## Checks',
    '',
    ...checkLines,
    '',
    `ktchn run \`${runId}\``,
  ].join('\n');
  return { title, body };
};

export const openPr = (opts: {
  repo: string;
  branch: string;
  title: string;
  body: string;
  gh?: string;
}) => {
  checkRefName(opts.branch);
  const bin = opts.gh ?? 'gh';
  const ref = `refs/heads/${opts.branch}`;
  /* The owner's pre-push hooks would run their tooling over files the agent
     wrote, which ADR 0015 keeps off the host.
  */
  git(
    opts.repo,
    [
      '-c',
      'core.hooksPath=/dev/null',
      'push',
      '--quiet',
      'origin',
      `${ref}:${ref}`,
    ],
    { scope: 'owner' }
  );
  const existing = gh(bin, opts.repo, [
    'pr',
    'list',
    '--head',
    opts.branch,
    '--state',
    'all',
    '--json',
    'url',
    '--jq',
    '.[0].url // empty',
  ]);
  if (existing !== '') return existing;
  const created = gh(
    bin,
    opts.repo,
    [
      'pr',
      'create',
      '--head',
      opts.branch,
      '--title',
      opts.title,
      '--body-file',
      '-',
    ],
    opts.body
  );
  const url = created.split('\n').at(-1) ?? '';
  if (!/^https:\/\/\S+$/.test(url)) {
    throw new Error(`gh pr create printed no PR URL: ${created.slice(0, 500)}`);
  }
  return url;
};
