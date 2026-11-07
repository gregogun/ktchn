import { execFileSync } from 'node:child_process';
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
import { SEEDED } from './box-scripts.ts';
import { importPack } from './git.ts';
import {
  collect,
  CollectRefused,
  containerArgs,
  MEMORY_LIMIT,
  PIDS_LIMIT,
  MAX_PACK_BYTES,
  openReviewSandbox,
  seed,
  type Sandbox,
} from './sandbox.ts';
import { git } from './test-git.ts';
import { fakeSandbox, type Reply } from './test-sandbox.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const commit = (repo: string, file: string, message: string) => {
  writeFileSync(join(repo, file), `${message}\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', message);
  return git(repo, 'rev-parse', 'HEAD');
};

const pack = (repo: string, input: string) =>
  execFileSync('git', ['pack-objects', '--revs', '--stdout', '--quiet'], {
    cwd: repo,
    input,
    maxBuffer: 1 << 26,
  });

// A trusted clone at `base`, and a second repository standing in for what the
// agent made in its sandbox. Packs are made here ahead of time, so the fake
// sandbox only has canned bytes to hand back.
const world = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ktchn-sandbox-')));
  dirs.push(root);
  const owner = join(root, 'owner');
  mkdirSync(owner);
  git(owner, 'init', '-q', '-b', 'main');
  git(owner, 'config', 'user.email', 't@example.com');
  git(owner, 'config', 'user.name', 't');
  const base = commit(owner, 'a.txt', 'base');
  const repo = join(root, 'clone.git');
  git(root, 'clone', '-q', '--bare', owner, repo);
  git(repo, 'update-ref', 'refs/heads/ktchn/r1', base);
  const boxRepo = join(root, 'box');
  git(root, 'clone', '-q', owner, boxRepo);
  git(boxRepo, 'config', 'user.email', 't@example.com');
  git(boxRepo, 'config', 'user.name', 't');
  const work = commit(boxRepo, 'work.txt', 'work');
  return {
    root,
    repo,
    base,
    work,
    boxRepo,
    incremental: pack(boxRepo, `${work}\n^${base}\n`),
    full: pack(boxRepo, `${work}\n`),
    tip: () => git(repo, 'rev-parse', 'refs/heads/ktchn/r1'),
  };
};

const box = (
  w: ReturnType<typeof world>,
  over: (command: string, stdin: unknown) => Reply | undefined = () =>
    undefined,
  answer = w.work
) =>
  fakeSandbox(({ command, opts }) => {
    const special = over(command, opts.stdin);
    if (special !== undefined) return special;
    if (command.includes('rev-parse')) return { stdout: `${answer}\n` };
    if (command.includes('status')) return { stdout: '?? junk\0' };
    if (command.includes('pack-objects')) return { file: w.incremental };
    return {};
  });

describe('collect', () => {
  test('moves the run branch to the agent commit and reports the status', async () => {
    const w = world();
    const { sandbox, calls } = box(w);

    const got = await collect({
      sandbox,
      repo: w.repo,
      branch: 'ktchn/r1',
      base: w.base,
    });

    expect(got).toEqual({ oid: w.work, dirty: '?? junk\0' });
    expect(w.tip()).toBe(w.work);
    for (const { command, opts } of calls) {
      expect(opts.timeoutMs).toBeGreaterThan(0);
      expect(command).toContain('-c core.hooksPath=/dev/null');
      expect(command).toContain('-c core.fsmonitor=false');
    }
  });

  test('rejects an answer that is not a commit id and fetches nothing', async () => {
    const w = world();
    const { sandbox, calls } = box(w, undefined, 'not-an-oid; rm -rf x');

    await expect(
      collect({ sandbox, repo: w.repo, branch: 'ktchn/r1', base: w.base })
    ).rejects.toThrow(/not a commit id/);

    expect(w.tip()).toBe(w.base);
    expect(calls.some((c) => c.command.includes('pack-objects'))).toBe(false);
  });

  test('leaves the branch alone when it moved while the pack was imported', async () => {
    const w = world();
    const other = git(w.repo, 'commit-tree', `${w.base}^{tree}`, '-m', 'owner');
    const { sandbox } = box(w, (command) => {
      if (!command.includes('pack-objects')) return undefined;
      git(w.repo, 'update-ref', 'refs/heads/ktchn/r1', other);
      return { file: w.incremental };
    });

    await expect(
      collect({ sandbox, repo: w.repo, branch: 'ktchn/r1', base: w.base })
    ).rejects.toThrow();

    expect(w.tip()).toBe(other);
  });

  test('sends a full pack when the sandbox lacks the clone tip', async () => {
    const w = world();
    const { sandbox, calls } = box(w, (command, stdin) => {
      if (!command.includes('pack-objects')) return undefined;
      return String(stdin).includes('^')
        ? { exitCode: 128, stderr: 'fatal: bad object' }
        : { file: w.full };
    });

    await collect({ sandbox, repo: w.repo, branch: 'ktchn/r1', base: w.base });

    const packs = calls.filter((c) => c.command.includes('pack-objects'));
    expect(packs.map((c) => String(c.opts.stdin).includes('^'))).toEqual([
      true,
      false,
    ]);
    expect(w.tip()).toBe(w.work);
  });

  test('refuses a commit that does not descend from the base', async () => {
    const w = world();
    git(w.boxRepo, 'checkout', '-q', '--orphan', 'unrelated');
    const stranger = commit(w.boxRepo, 'z.txt', 'unrelated history');
    const { sandbox } = box(
      w,
      (command) =>
        command.includes('pack-objects')
          ? { file: pack(w.boxRepo, `${stranger}\n`) }
          : undefined,
      stranger
    );

    const refused = collect({
      sandbox,
      repo: w.repo,
      branch: 'ktchn/r1',
      base: w.base,
    });

    await expect(refused).rejects.toBeInstanceOf(CollectRefused);
    await expect(refused).rejects.toThrow(/does not descend from/);
    expect(w.tip()).toBe(w.base);
  });

  test.each([
    ['output', /printing more than the limit/],
    ['timeout', /taking too long/],
  ] as const)(
    'fails the round when a sandbox command hits its %s limit',
    async (limit, message) => {
      const w = world();
      const { sandbox, calls } = box(w, (command) =>
        command.includes('status') ? { exitCode: 125, limit } : undefined
      );

      await expect(
        collect({ sandbox, repo: w.repo, branch: 'ktchn/r1', base: w.base })
      ).rejects.toThrow(message);
      expect(calls.some((c) => c.command.includes('pack-objects'))).toBe(false);
      expect(w.tip()).toBe(w.base);
    }
  );

  test('a copy whose git fails is refused with a finding', async () => {
    const w = world();
    const { sandbox } = box(w, (command) =>
      command.includes('rev-parse')
        ? { exitCode: 128, stderr: 'fatal: not a git repository\n' }
        : undefined
    );

    const refused = collect({
      sandbox,
      repo: w.repo,
      branch: 'ktchn/r1',
      base: w.base,
    });

    await expect(refused).rejects.toBeInstanceOf(CollectRefused);
    await expect(refused).rejects.toThrow(/not a git repository/);
  });

  test('a sandbox that does not answer at all is not a finding', async () => {
    const w = world();
    const { sandbox } = box(w, () => ({
      exitCode: 1,
      stderr: 'Cannot connect to the Docker daemon\n',
    }));

    const failed = collect({
      sandbox,
      repo: w.repo,
      branch: 'ktchn/r1',
      base: w.base,
    });

    await expect(failed).rejects.toThrow(/Docker daemon/);
    await expect(failed).rejects.not.toBeInstanceOf(CollectRefused);
  });

  test('a pack git will not take is refused with a finding', async () => {
    const w = world();
    const { sandbox } = box(w, (command) =>
      command.includes('pack-objects')
        ? { file: Buffer.from('PACK\0\0\0\x02\0\0\0\x01\xff\xff') }
        : undefined
    );

    await expect(
      collect({ sandbox, repo: w.repo, branch: 'ktchn/r1', base: w.base })
    ).rejects.toBeInstanceOf(CollectRefused);
    expect(w.tip()).toBe(w.base);
  });

  test('caps the pack the sandbox may send, and does not retry a capped one', async () => {
    const w = world();
    const { sandbox, calls } = box(w, (command) =>
      command.includes('pack-objects')
        ? { exitCode: 125, limit: 'output' }
        : undefined
    );

    await expect(
      collect({ sandbox, repo: w.repo, branch: 'ktchn/r1', base: w.base })
    ).rejects.toBeInstanceOf(CollectRefused);

    const packs = calls.filter((c) => c.command.includes('pack-objects'));
    expect(packs).toHaveLength(1);
    expect(packs[0]?.opts.maxBytes).toBe(MAX_PACK_BYTES);
    expect(w.tip()).toBe(w.base);
  });
});

describe('importPack', () => {
  test('refuses a pack larger than the cap and imports nothing', () => {
    const w = world();
    const file = join(w.root, 'objects.pack');
    writeFileSync(file, w.incremental);

    expect(() => importPack(file, w.repo, w.work, { maxBytes: 100 })).toThrow();
    expect(() => git(w.repo, 'cat-file', '-e', w.work)).toThrow();

    importPack(file, w.repo, w.work, { maxBytes: MAX_PACK_BYTES });
    expect(git(w.repo, 'cat-file', '-t', w.work)).toBe('commit');
  });
});

describe('seed', () => {
  test('leaves a copy that already holds a seed alone', async () => {
    const w = world();
    const { sandbox, calls } = fakeSandbox(({ command }) =>
      command === `test -e ${SEEDED}` ? { exitCode: 0 } : { exitCode: 1 }
    );

    await seed(sandbox, {
      repo: w.repo,
      ref: 'refs/heads/ktchn/r1',
      branch: 'ktchn/r1',
    });

    expect(calls.map((c) => c.command)).toEqual([`test -e ${SEEDED}`]);
  });

  test('streams a bundle into an unseeded copy with a bounded guarded script', async () => {
    const w = world();
    const { sandbox, calls } = fakeSandbox(({ command }) =>
      command.startsWith('test -e') ? { exitCode: 1 } : { exitCode: 0 }
    );

    await seed(sandbox, {
      repo: w.repo,
      ref: 'refs/heads/ktchn/r1',
      branch: 'ktchn/r1',
    });

    const script = calls[1];
    expect(script?.command.startsWith('if [ "$(pwd -P)"')).toBe(true);
    expect(typeof script?.opts.stdin).toBe('number');
    expect(script?.opts.timeoutMs).toBeGreaterThan(0);
  });

  test('fails when the script fails', async () => {
    const w = world();
    const { sandbox } = fakeSandbox(({ command }) =>
      command.startsWith('test -e')
        ? { exitCode: 1 }
        : { exitCode: 97, stderr: 'refusing' }
    );

    await expect(
      seed(sandbox, { repo: w.repo, ref: 'refs/heads/ktchn/r1' })
    ).rejects.toThrow(/Seeding failed in the sandbox: refusing/);
  });
});

describe('openReviewSandbox', () => {
  test('opens a sandbox with no volume and no pi-env', async () => {
    const w = world();
    const { sandbox, calls } = fakeSandbox(({ command }) =>
      command.startsWith('test -e') ? { exitCode: 1 } : { exitCode: 0 }
    );
    const opened: unknown[] = [];

    const got = await openReviewSandbox(
      { runId: 'r', repo: w.repo, oid: w.base, image: 'img' },
      async (opts): Promise<Sandbox> => {
        opened.push(opts);
        return sandbox;
      }
    );

    expect(got).toBe(sandbox);
    expect(opened).toEqual([
      expect.objectContaining({
        volume: false,
        piEnv: false,
        network: false,
        image: 'img',
      }),
    ]);
    expect(calls.some((c) => typeof c.opts.stdin === 'number')).toBe(true);
    expect(git(w.repo, 'for-each-ref', 'refs/ktchn')).toBe('');
  });
});

describe('containerArgs', () => {
  const args = (network: boolean) =>
    containerArgs({
      name: 'n',
      runId: 'r',
      image: 'img',
      network,
      mounts: ['-v', 'v:/home/agent/copy'],
    });
  const pair = (list: string[], flag: string) => list[list.indexOf(flag) + 1];

  test('drops capabilities and limits processes and memory', () => {
    const list = args(false);
    expect(pair(list, '--cap-drop')).toBe('ALL');
    expect(pair(list, '--security-opt')).toBe('no-new-privileges');
    expect(pair(list, '--pids-limit')).toBe(String(PIDS_LIMIT));
    expect(pair(list, '--memory')).toBe(MEMORY_LIMIT);
  });

  test('has no network unless the Policy allows it', () => {
    expect(pair(args(false), '--network')).toBe('none');
    expect(args(true)).not.toContain('--network');
  });

  test('keeps the image and command after every flag', () => {
    expect(args(false).slice(-4)).toEqual([
      '--entrypoint',
      'sleep',
      'img',
      'infinity',
    ]);
  });
});
