import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { copyCommit } from './git.ts';
import { hostFindings, protectedChanges } from './host-review.ts';
import { git } from './test-git.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A bare clone with a run branch, and a scratch repository standing in for
// the agent's copy that its commits are brought in from.
const makeRun = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ktchn-hr-')));
  dirs.push(root);
  const work = join(root, 'work');
  mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'config', 'user.email', 't@example.com');
  git(work, 'config', 'user.name', 't');
  writeFileSync(join(work, 'package.json'), '{"scripts":{"test":"vitest"}}\n');
  writeFileSync(join(work, 'a.ts'), 'a\n');
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'init');
  const base = git(work, 'rev-parse', 'HEAD');
  const repo = join(root, 'repo.git');
  git(root, 'clone', '-q', '--bare', work, repo);
  git(repo, 'update-ref', 'refs/heads/ktchn/r', base);
  git(work, 'checkout', '-q', '-b', 'ktchn/r');
  const commit = (file: string, content: string) => {
    mkdirSync(join(work, file, '..'), { recursive: true });
    writeFileSync(join(work, file), content);
    git(work, 'add', '.');
    git(work, 'commit', '-qm', `edit ${file}`);
    const oid = git(work, 'rev-parse', 'HEAD');
    copyCommit({ from: work, to: repo, oid });
    git(repo, 'update-ref', 'refs/heads/ktchn/r', oid);
  };
  return { repo, work, commit, base };
};

const find = (
  run: { repo: string; base: string },
  allowPaths: string[] = [],
  dirty = ''
) =>
  hostFindings({
    repo: run.repo,
    branch: 'ktchn/r',
    oid: git(run.repo, 'rev-parse', 'refs/heads/ktchn/r'),
    base: run.base,
    dirty,
    allowPaths,
  });

describe('protectedChanges', () => {
  test.each([
    'package.json',
    'packages/web/package.json',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'tsconfig.json',
    'tsconfig.build.json',
    'eslint.config.mjs',
    '.oxlintrc.json',
    '.prettierrc',
    'prettier.config.js',
    'lefthook.yml',
    '.lefthook-local.yml',
    'lefthook-local.yml',
    'lefthook-local.yaml',
    'vitest.workspace.ts',
    'vitest.workspace.json',
    'vitest.config.ts',
    'vitest.config.mts',
    'packages/web/vite.config.js',
    'knip.json',
    'knip.ts',
    'knip.jsonc',
    'knip.config.ts',
    'knip.config.mjs',
    '.knip.json',
    '.knip.jsonc',
    '.npmrc',
    '.pnpmfile.cjs',
    '.pnpmfile.mjs',
    '.yarnrc.yml',
    'packages/web/.yarnrc.yml',
    'pnpm-workspace.yaml',
    '.config/package.json',
    '.github/.hidden/tsconfig.json',
    'a/.b/c/.npmrc',
    '.github/workflows/ci.yml',
  ])('%s is protected', (file) => {
    expect(protectedChanges([file], [])).toEqual([file]);
  });

  test('a glob the job allows matches inside dot directories too', () => {
    expect(protectedChanges(['.config/package.json'], ['.config/**'])).toEqual(
      []
    );
    expect(protectedChanges(['.config/package.json'], ['src/**'])).toEqual([
      '.config/package.json',
    ]);
  });

  test('ordinary files are not protected', () => {
    expect(
      protectedChanges(['src/a.ts', 'README.md', '.github/CODEOWNERS'], [])
    ).toEqual([]);
  });

  test('an allowed glob exempts only what it matches', () => {
    expect(
      protectedChanges(['package.json', 'pnpm-lock.yaml'], ['package.json'])
    ).toEqual(['pnpm-lock.yaml']);
  });
});

describe('hostFindings', () => {
  test('one clean commit has no findings', () => {
    const run = makeRun();
    run.commit('a.ts', 'b\n');
    expect(find(run)).toEqual([]);
  });

  test('uncommitted and untracked changes in the reported status are a finding', () => {
    const run = makeRun();
    run.commit('a.ts', 'b\n');
    const [finding] = find(run, [], ' M a.ts\0?? junk/x\0');
    expect(finding).toContain('uncommitted or untracked');
    expect(finding).toContain('a.ts');
    expect(finding).toContain('junk/x');
  });

  test('a long status is cut short', () => {
    const run = makeRun();
    run.commit('a.ts', 'b\n');
    const dirty = Array.from({ length: 100 }, (_, i) => `?? f${i}\0`).join('');
    expect(find(run, [], dirty)[0]).toContain('and 60 more');
  });

  test('a branch with no new commit is a finding', () => {
    const run = makeRun();
    expect(find(run)).toEqual([
      expect.stringContaining('no new commit on branch ktchn/r'),
    ]);
  });

  test('a protected path in the diff from the base is a finding', () => {
    const run = makeRun();
    run.commit('a.ts', 'b\n');
    run.commit('package.json', '{"scripts":{"test":"true"}}\n');
    const [finding] = find(run);
    expect(finding).toContain('protected paths');
    expect(finding).toContain('package.json');
    expect(finding).not.toContain('a.ts');
  });

  test('the job can allow a protected path', () => {
    const run = makeRun();
    run.commit('package.json', '{"scripts":{"test":"true"}}\n');
    expect(find(run, ['package.json'])).toEqual([]);
  });

  test('a protected change reverted by a later commit is not in the diff', () => {
    const run = makeRun();
    run.commit('package.json', '{}\n');
    run.commit('package.json', '{"scripts":{"test":"vitest"}}\n');
    run.commit('a.ts', 'b\n');
    expect(find(run)).toEqual([]);
  });

  test('every problem is reported together', () => {
    const run = makeRun();
    run.commit('package.json', '{}\n');
    expect(find(run, [], '?? junk\0')).toHaveLength(2);
  });
});
