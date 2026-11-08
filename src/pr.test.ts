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
import { afterEach, describe, expect, test, vi } from 'vitest';
import { checkCanOpenPr, openPr, originBase, prText } from './pr.ts';
import type { CheckResult, Job } from './ledger.ts';
import { git } from './test-git.ts';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
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
env | grep -E '^(GH_HOST|GH_REPO|GIT_)' >> "$dir/gh.env"
case "$*" in *"-R github.com/"*) ;; *) echo "missing -R github.com/<slug>" >&2; exit 1 ;; esac
case "$1 $2" in
  "pr create"|"pr list") case "$*" in *"--head ktchn/r1"*) ;; *) echo "missing --head" >&2; exit 1 ;; esac ;;
esac
case "$1 $2" in
  "pr create") case "$*" in *"--base main "*) ;; *) echo "missing --base" >&2; exit 1 ;; esac ;;
esac
case "$1 $2" in
  "repo view") [ -f "$dir/gh.fail" ] && { echo "not logged in" >&2; exit 1; }; echo '{"defaultBranchRef":{"name":"main"}}' ;;
  "pr list") if [ -f "$dir/pr.list" ]; then cat "$dir/pr.list"; else echo '[]'; fi ;;
  "pr create") cat > "$dir/pr.body"; echo '[{"url":"${URL}","isCrossRepository":false}]' > "$dir/pr.list"; echo "Creating..."; echo "${URL}" ;;
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

const addGithubOrigin = (root: string, repo: string, origin: string) => {
  const ssh = join(root, 'ssh');
  writeFileSync(
    ssh,
    `#!/bin/sh\ncase "$*" in *upload-pack*) exec git upload-pack "${origin}" ;; *) exec git receive-pack "${origin}" ;; esac\n`
  );
  chmodSync(ssh, 0o755);
  git(repo, 'remote', 'add', 'origin', 'git@github.com:o/r.git');
  git(repo, 'config', 'core.sshCommand', ssh);
};

describe('openPr', () => {
  test("pushes the run branch without the owner's hooks, opens one PR, and finds it again", () => {
    const { root, repo, origin, gh } = setup();
    writeFileSync(
      join(repo, '.git', 'hooks', 'pre-push'),
      `#!/bin/sh\ntouch "${root}/hook-ran"\n`
    );
    chmodSync(join(repo, '.git', 'hooks', 'pre-push'), 0o755);
    addGithubOrigin(root, repo, origin);
    const pr = {
      repo,
      branch: 'ktchn/r1',
      baseBranch: 'main',
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

describe('openPr targets', () => {
  test("asks gh about origin's push URL, with the host, and gives gh no GH_HOST, GH_REPO or GIT_*", () => {
    const { root, repo, origin, gh } = setup();
    addGithubOrigin(root, repo, origin);
    git(
      repo,
      'remote',
      'set-url',
      '--push',
      'origin',
      'git@github.com:p/q.git'
    );
    vi.stubEnv('GH_HOST', 'example.com');
    vi.stubEnv('GH_REPO', 'x/y');
    vi.stubEnv('GIT_DIR', '/nowhere');

    openPr({
      repo,
      branch: 'ktchn/r1',
      baseBranch: 'main',
      title: 't',
      body: 'b',
      gh,
    });

    const log = readFileSync(join(root, 'gh.log'), 'utf8');
    expect(log).toContain('pr list -R github.com/p/q ');
    expect(log).toContain('pr create -R github.com/p/q ');
    expect(readFileSync(join(root, 'gh.env'), 'utf8')).toBe('');
  });

  test("ignores a PR from a fork with the run's branch name", () => {
    const { root, repo, origin, gh } = setup();
    addGithubOrigin(root, repo, origin);
    writeFileSync(
      join(root, 'pr.list'),
      JSON.stringify([
        { url: 'https://github.com/fork/r/pull/1', isCrossRepository: true },
      ])
    );

    expect(
      openPr({
        repo,
        branch: 'ktchn/r1',
        baseBranch: 'main',
        title: 't',
        body: 'b',
        gh,
      })
    ).toBe(URL);
    expect(git(origin, 'rev-parse', 'refs/heads/ktchn/r1')).toBe(
      git(repo, 'rev-parse', 'ktchn/r1')
    );
  });
});

describe('originBase', () => {
  test("bases on origin's default branch, not the owner's unpushed commits", () => {
    const { root, repo, origin, gh } = setup();
    addGithubOrigin(root, repo, origin);
    git(repo, 'push', '-q', origin, 'main:refs/heads/main');
    const pushed = git(repo, 'rev-parse', 'main');
    git(repo, 'checkout', '-q', '-b', 'mine');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'unpushed');
    const head = git(repo, 'rev-parse', 'HEAD');

    expect(originBase(repo, gh)).toEqual({
      base: pushed,
      baseBranch: 'main',
    });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'branch', '--show-current')).toBe('mine');
  });
});

describe('prText', () => {
  test('quotes a check command that contains backticks', () => {
    const job = { text: 'job' } as Job;
    const { body } = prText('r1', job, [
      { command: 'echo `date` ``x``', exitCode: 0 },
    ] as CheckResult[]);
    expect(body).toContain('- ``` echo `date` ``x`` ``` passed');
  });
});

describe('openPr with a PR already open', () => {
  test('returns it without pushing, so a branch moved on origin does not block it', () => {
    const { root, repo, origin, gh } = setup();
    addGithubOrigin(root, repo, origin);
    writeFileSync(
      join(root, 'pr.list'),
      JSON.stringify([{ url: URL, isCrossRepository: false }])
    );
    git(repo, 'checkout', '-q', '--orphan', 'other');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'moved');
    git(repo, 'push', '-q', origin, 'other:refs/heads/ktchn/r1');
    git(repo, 'checkout', '-q', 'main');

    const pr = {
      repo,
      branch: 'ktchn/r1',
      baseBranch: 'main',
      title: 't',
      body: 'b',
      gh,
    };
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
    addGithubOrigin(root, repo, origin);
    expect(() => checkCanOpenPr(repo, gh)).not.toThrow();
    writeFileSync(join(root, 'gh.fail'), '');
    expect(() => checkCanOpenPr(repo, gh)).toThrow(
      /gh auth login.*not logged in/
    );
  });
});
