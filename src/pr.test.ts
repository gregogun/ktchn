import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { checkCanOpenPr, openPr } from './pr.ts';
import { git } from './test-git.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const URL = 'https://github.com/o/r/pull/7';

const fakeGh = (root: string) => {
  const bin = join(root, 'gh');
  writeFileSync(
    bin,
    `#!/bin/sh
dir="${root}"
echo "$*" >> "$dir/gh.log"
case "$*" in *"-R o/r"*) ;; *) echo "missing -R o/r" >&2; exit 1 ;; esac
case "$1 $2" in
  "pr create"|"pr list") case "$*" in *"--head ktchn/r1"*) ;; *) echo "missing --head" >&2; exit 1 ;; esac ;;
esac
case "$1 $2" in
  "repo view") [ -f "$dir/gh.fail" ] && { echo "not logged in" >&2; exit 1; }; echo '{}' ;;
  "pr list") if [ -f "$dir/pr.url" ]; then cat "$dir/pr.url"; fi ;;
  "pr create") cat > "$dir/pr.body"; echo "${URL}" > "$dir/pr.url"; echo "Creating..."; echo "${URL}" ;;
esac
`
  );
  chmodSync(bin, 0o755);
  return bin;
};

const setup = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ktchn-pr-')));
  dirs.push(root);
  const repo = join(root, 'repo');
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', origin);
  git(root, 'init', '-q', '-b', 'main', repo);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'branch', 'ktchn/r1');
  return { root, repo, origin, gh: fakeGh(root) };
};

const addGithubOrigin = (repo: string, origin: string) => {
  git(repo, 'remote', 'add', 'origin', 'git@github.com:o/r.git');
  git(repo, 'config', `url.${origin}.pushInsteadOf`, 'git@github.com:o/r.git');
};

describe('openPr', () => {
  test("pushes the run branch without the owner's hooks, opens one PR, and finds it again", () => {
    const { root, repo, origin, gh } = setup();
    writeFileSync(
      join(repo, '.git', 'hooks', 'pre-push'),
      `#!/bin/sh\ntouch "${root}/hook-ran"\n`
    );
    chmodSync(join(repo, '.git', 'hooks', 'pre-push'), 0o755);
    addGithubOrigin(repo, origin);
    const pr = {
      repo,
      branch: 'ktchn/r1',
      title: 'Fix it',
      body: 'the job',
      gh,
    };

    expect(openPr(pr)).toBe(URL);
    expect(openPr(pr)).toBe(URL);

    expect(git(origin, 'rev-parse', 'refs/heads/ktchn/r1')).toBe(
      git(repo, 'rev-parse', 'ktchn/r1')
    );
    expect(existsSync(join(root, 'hook-ran'))).toBe(false);
    expect(readFileSync(join(root, 'pr.body'), 'utf8')).toBe('the job');
    const creates = readFileSync(join(root, 'gh.log'), 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('pr create'));
    expect(creates).toHaveLength(1);
  });
});

describe('openPr with a PR already open', () => {
  test('returns it without pushing, so a branch moved on origin does not block it', () => {
    const { root, repo, origin, gh } = setup();
    addGithubOrigin(repo, origin);
    writeFileSync(join(root, 'pr.url'), URL);
    git(repo, 'checkout', '-q', '--orphan', 'other');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'moved');
    git(repo, 'push', '-q', origin, 'other:refs/heads/ktchn/r1');
    git(repo, 'checkout', '-q', 'main');

    const pr = { repo, branch: 'ktchn/r1', title: 't', body: 'b', gh };
    expect(openPr(pr)).toBe(URL);
  });
});

describe('checkCanOpenPr', () => {
  test('refuses a project with no origin', () => {
    const { repo, gh } = setup();
    expect(() => checkCanOpenPr(repo, gh)).toThrow(/has no origin/);
  });

  test('refuses an origin that is not a GitHub URL', () => {
    const { repo, origin, gh } = setup();
    git(repo, 'remote', 'add', 'origin', origin);
    expect(() => checkCanOpenPr(repo, gh)).toThrow(/not a GitHub URL/);
  });

  test("refuses when gh can't reach the repository, with gh's reason", () => {
    const { root, repo, origin, gh } = setup();
    addGithubOrigin(repo, origin);
    expect(() => checkCanOpenPr(repo, gh)).not.toThrow();
    writeFileSync(join(root, 'gh.fail'), '');
    expect(() => checkCanOpenPr(repo, gh)).toThrow(
      /gh auth login.*not logged in/
    );
  });
});
