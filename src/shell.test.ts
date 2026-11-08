import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { runDir } from './clone.ts';
import type { Job } from './ledger.ts';
import { makeJob } from './job.ts';
import { CollectRefused } from './sandbox.ts';
import { buildShell, type SandboxPort } from './shell.ts';
import { git } from './test-git.ts';
import { fakeSandbox } from './test-sandbox.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const recorder = (events: string[], network: boolean[] = []) => {
  const { sandbox } = fakeSandbox();
  const ports: SandboxPort = {
    open: async (opts) => {
      events.push(`open ${opts.name}`);
      network.push(opts.network);
      return {
        ...sandbox,
        name: opts.name,
        close: async () => {
          events.push(`close ${opts.name}`);
        },
      };
    },
    removeAll: (runId, withVolume) => {
      events.push(`remove ${runId} ${String(withVolume)}`);
    },
    seed: async () => {
      events.push('seed');
    },
    collect: async () => {
      events.push('collect');
      return { oid: 'a'.repeat(40), dirty: '' };
    },
    review: async () => {
      events.push('review');
      return {
        event: { type: 'ReviewPassed' as const, oid: 'a'.repeat(40) },
        results: [],
      };
    },
  };
  return ports;
};

const makeTempRepo = () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'ktchn-shell-repo-')));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  return repo;
};

const world = (policy: Job['policy']) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ktchn-shell-')));
  dirs.push(home);
  const repo = makeTempRepo();
  dirs.push(repo);
  const { runId, job } = makeJob({
    repo,
    text: 't',
    checks: [],
    allowPaths: [],
    policy,
    model: 'm',
  });
  return { home, repo, runId, job, base: git(repo, 'rev-parse', 'HEAD') };
};

describe('buildShell', () => {
  test('a round clears stale containers, makes the clone, then opens, seeds and runs the agent', async () => {
    const w = world({ network: false });
    const events: string[] = [];
    const network: boolean[] = [];
    const { shell } = buildShell({
      ...w,
      image: 'img',
      openAgent: async () => ({
        run: async () => {
          events.push('agent');
          return { type: 'AgentFinished' } as never;
        },
        close: async () => {},
      }),
      report: () => {},
      sandboxes: recorder(events, network),
    });
    await shell.runAgent({ input: { kind: 'job' } as never, number: 1 });
    expect(events).toEqual([
      `remove ${w.runId} false`,
      `open ktchn-${w.runId}-r1`,
      'seed',
      'agent',
    ]);
    expect(existsSync(runDir(w.home, w.runId))).toBe(true);
    expect(network).toEqual([false]);
  });

  test('a clone that fails opens no sandbox, so no volume is made', async () => {
    const w = world({ network: false });
    const events: string[] = [];
    const { shell } = buildShell({
      ...w,
      base: 'f'.repeat(40),
      image: 'img',
      openAgent: async () => ({
        run: async () => ({}) as never,
        close: async () => {},
      }),
      report: () => {},
      sandboxes: recorder(events),
    });
    await expect(
      shell.runAgent({ input: { kind: 'job' } as never, number: 1 })
    ).rejects.toThrow();
    expect(events.filter((e) => e.startsWith('open'))).toEqual([]);
  });

  test('review collects in the sandbox, closes it, then reviews in a separate one', async () => {
    const w = world({ network: true });
    const events: string[] = [];
    const { shell } = buildShell({
      ...w,
      image: 'img',
      openAgent: async () => ({
        run: async () => ({}) as never,
        close: async () => {},
      }),
      report: () => {},
      sandboxes: recorder(events),
    });
    await shell.runReview();
    expect(events).toEqual([
      `remove ${w.runId} false`,
      `open ktchn-${w.runId}-collect`,
      'seed',
      'collect',
      `close ktchn-${w.runId}-collect`,
      'review',
    ]);
  });

  test("review after a round closes the agent's session and sandbox and collects in a fresh one", async () => {
    const w = world({ network: true });
    const events: string[] = [];
    const network: boolean[] = [];
    const { shell } = buildShell({
      ...w,
      image: 'img',
      openAgent: async () => ({
        run: async () => {
          events.push('agent');
          return {} as never;
        },
        close: async () => {
          events.push('agent closed');
        },
      }),
      report: () => {},
      sandboxes: recorder(events, network),
    });
    await shell.runAgent({ input: { kind: 'job' } as never, number: 1 });
    events.length = 0;
    await shell.runReview();
    expect(events).toEqual([
      'agent closed',
      `close ktchn-${w.runId}-r1`,
      `remove ${w.runId} false`,
      `open ktchn-${w.runId}-collect`,
      'seed',
      'collect',
      `close ktchn-${w.runId}-collect`,
      'review',
    ]);
    expect(network).toEqual([true, false]);
  });

  test('a refused collect becomes a failed review, not a crash', async () => {
    const w = world({ network: false });
    const ports = recorder([]);
    ports.collect = async () => {
      throw new CollectRefused('Packing was stopped in the sandbox.');
    };
    const { shell } = buildShell({
      ...w,
      image: 'img',
      openAgent: async () => ({
        run: async () => ({}) as never,
        close: async () => {},
      }),
      report: () => {},
      sandboxes: ports,
    });
    const outcome = await shell.runReview();
    expect(outcome.event).toEqual({
      type: 'ReviewFailed',
      findings: 'Packing was stopped in the sandbox.',
    });
  });

  test('any other collect failure crashes the run, so it can resume', async () => {
    const w = world({ network: false });
    const events: string[] = [];
    const ports = recorder(events);
    ports.collect = async () => {
      throw new Error('Cannot connect to the Docker daemon');
    };
    const { shell } = buildShell({
      ...w,
      image: 'img',
      openAgent: async () => ({
        run: async () => ({}) as never,
        close: async () => {},
      }),
      report: () => {},
      sandboxes: ports,
    });
    await expect(shell.runReview()).rejects.toThrow(/Docker daemon/);
    expect(events).not.toContain('review');
  });

  test("opening the PR hands off the reviewed commit, removes the run's sandboxes and volume, and repeats safely", async () => {
    const w = world({ network: false });
    const origin = join(w.home, 'origin.git');
    git(w.home, 'init', '-q', '--bare', origin);
    git(w.repo, 'remote', 'add', 'origin', 'https://github.com/o/r');
    git(
      w.repo,
      'config',
      `url.${origin}.pushInsteadOf`,
      'https://github.com/o/r'
    );
    const gh = join(w.home, 'gh');
    writeFileSync(
      gh,
      '#!/bin/sh\n[ "$2" = list ] || echo https://github.com/o/r/pull/1\n'
    );
    chmodSync(gh, 0o755);
    const events: string[] = [];
    const { shell } = buildShell({
      ...w,
      image: 'img',
      gh,
      openAgent: async () => ({
        run: async () => ({}) as never,
        close: async () => {},
      }),
      report: () => {},
      sandboxes: recorder(events),
    });
    expect(await shell.openPr(w.base, [])).toBe(
      'https://github.com/o/r/pull/1'
    );
    expect(await shell.openPr(w.base, [])).toBe(
      'https://github.com/o/r/pull/1'
    );
    expect(events).toEqual([
      `remove ${w.runId} true`,
      `remove ${w.runId} true`,
    ]);
    expect(git(w.repo, 'rev-parse', w.job.branch)).toBe(w.base);
    expect(git(origin, 'rev-parse', w.job.branch)).toBe(w.base);
  });
});
