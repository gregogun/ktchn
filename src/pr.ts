import { execFileSync } from 'node:child_process';
import { checkRefName, git, tryGit } from './git.ts';
import type { CheckResult, Job } from './ledger.ts';

const GH_TIMEOUT_MS = 2 * 60_000;

/* gh starts its own git processes, which ADR 0015 keeps from inheriting GIT_*,
   and GH_HOST or GH_REPO would point it at a different repository than the
   one passed with -R.
*/
const ghEnv = () => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      name !== 'GH_HOST' &&
      name !== 'GH_REPO' &&
      !name.startsWith('GIT_')
    ) {
      env[name] = value;
    }
  }
  return { ...env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
};

const gh = (bin: string, cwd: string, args: string[], input?: string) =>
  execFileSync(bin, args, {
    cwd,
    env: ghEnv(),
    input,
    encoding: 'utf8',
    timeout: GH_TIMEOUT_MS,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }).trim();

const stderrOf = (error: unknown) =>
  String((error as { stderr?: unknown }).stderr ?? error).trim();

const githubRepo = (repo: string) => {
  const url = tryGit(repo, ['remote', 'get-url', '--push', 'origin'], {
    scope: 'owner',
  });
  if (url === undefined) {
    throw new Error(
      `${repo} has no origin, so a run could not open its PR. Add a GitHub origin first.`
    );
  }
  const match =
    /^(?:https:\/\/(?:[^/@]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
      url
    );
  if (match?.[1] === undefined) {
    throw new Error(
      `${repo}'s origin (${url}) is not a GitHub URL, so a run could not open its PR.`
    );
  }
  return `github.com/${match[1]}`;
};

export const checkCanOpenPr = (repo: string, bin = 'gh') => {
  const slug = githubRepo(repo);
  try {
    gh(bin, repo, ['repo', 'view', '-R', slug, '--json', 'url']);
  } catch (error) {
    throw new Error(
      `gh cannot reach ${repo}'s GitHub repository, so a run could not open its PR (try \`gh auth login\`): ${stderrOf(error)}`,
      { cause: error }
    );
  }
};

const codeSpan = (text: string) => {
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length)
  );
  const fence = '`'.repeat(longest + 1);
  return `${fence} ${text} ${fence}`;
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
          `- ${codeSpan(c.command)} ${c.exitCode === 0 ? 'passed' : `exited ${c.exitCode}`}`
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
  const slug = githubRepo(opts.repo);
  const listed = JSON.parse(
    gh(bin, opts.repo, [
      'pr',
      'list',
      '-R',
      slug,
      '--head',
      opts.branch,
      '--state',
      'all',
      '--json',
      'url,isCrossRepository',
    ])
  ) as { url: string; isCrossRepository: boolean }[];
  const existing = listed.find((pr) => !pr.isCrossRepository);
  if (existing !== undefined) return existing.url;
  const ref = `refs/heads/${opts.branch}`;
  /* The owner's pre-push hooks would run their tooling over files the agent
     wrote, which ADR 0015 keeps off the host. Recursing into submodules would
     make git read .gitmodules from the agent's commits.
  */
  git(
    opts.repo,
    [
      '-c',
      'core.hooksPath=/dev/null',
      'push',
      '--quiet',
      '--no-recurse-submodules',
      'origin',
      `${ref}:${ref}`,
    ],
    { scope: 'owner' }
  );
  const created = gh(
    bin,
    opts.repo,
    [
      'pr',
      'create',
      '-R',
      slug,
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
