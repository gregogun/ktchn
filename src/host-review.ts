import { git } from './git.ts';

// Files whose change alters what the checks run or how they judge, so the
// agent may not touch them unless the job names them with --allow-path.
const PROTECTED: readonly string[] = [
  '**/package.json',
  '**/pnpm-lock.yaml',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/tsconfig*.json',
  '**/eslint.config.*',
  '**/.eslintrc*',
  '**/.oxlintrc*',
  '**/oxlint.config.*',
  '**/.prettierrc*',
  '**/prettier.config.*',
  '**/vitest.config.*',
  '**/vitest.workspace.*',
  '**/vite.config.*',
  '**/knip.json',
  '**/knip.jsonc',
  '**/knip.config.*',
  '**/knip.ts',
  '**/.knip.json*',
  '**/.npmrc',
  '**/.pnpmfile.*',
  '**/.yarnrc.yml',
  '**/pnpm-workspace.yaml',
  '**/lefthook.yml',
  '**/lefthook.yaml',
  '**/lefthook-local.yml',
  '**/lefthook-local.yaml',
  '**/.lefthook*',
  '**/.lefthook*/**',
  '**/.lefthook-local*',
  '.github/workflows/**',
];

// node:path's matchesGlob skips dot directories under `**`, so
// `.config/package.json` would slip past `**/package.json`. This matcher treats
// every path segment alike.
const globToRegExp = (glob: string): RegExp => {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (glob.startsWith('**/', i)) {
      source += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      source += '.*';
      i += 1;
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += c.replace(/[\\^$.|+(){}[\]]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
};

const matchesGlob = (file: string, glob: string) =>
  globToRegExp(glob).test(file);

export const protectedChanges = (
  changed: readonly string[],
  allowPaths: readonly string[]
): string[] =>
  changed.filter(
    (file) =>
      PROTECTED.some((glob) => matchesGlob(file, glob)) &&
      !allowPaths.some((glob) => matchesGlob(file, glob))
  );

const LISTED = 40;
const ENTRY_CHARS = 200;

// What review checks on the host before any check runs: the run's branch must
// hold the agent's whole change, as a commit, touching nothing protected. It
// reads objects only, from the run's clone. `dirty` is the status the sandbox
// reported when the round ended (`git status --porcelain -z`).
export const hostFindings = (opts: {
  repo: string;
  branch: string;
  // The commit review judges and the commit the run started from, both fixed
  // by the caller. Nothing here reads a branch or HEAD again.
  oid: string;
  base: string;
  dirty: string;
  allowPaths: readonly string[];
}): string[] => {
  const { repo, branch, oid, base, dirty, allowPaths } = opts;
  const findings: string[] = [];

  const entries = dirty.split('\0').filter(Boolean);
  if (entries.length > 0) {
    const shown = entries
      .slice(0, LISTED)
      .map((entry) => entry.slice(0, ENTRY_CHARS))
      .join('\n');
    const more =
      entries.length > LISTED
        ? `\n... and ${entries.length - LISTED} more`
        : '';
    findings.push(
      `The worktree has uncommitted or untracked changes. Commit what belongs to the change and delete the rest:\n${shown}${more}`
    );
  }

  if (git(repo, ['rev-list', '--count', `${base}..${oid}`]) === '0') {
    findings.push(
      `There is no new commit on branch ${branch}. Commit your work on the current branch.`
    );
    return findings;
  }

  const changed = git(repo, [
    'diff-tree',
    '-r',
    '--name-only',
    '--no-renames',
    '-z',
    base,
    oid,
  ])
    .split('\0')
    .filter(Boolean);
  const touched = protectedChanges(changed, allowPaths);
  if (touched.length > 0) {
    findings.push(
      `The commit changes protected paths the job does not allow: ${touched.join(', ')}. Restore them to how they were at the base.`
    );
  }
  return findings;
};
