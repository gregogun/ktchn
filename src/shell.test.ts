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
import type { AgentRequest, Job } from './ledger.ts';
import { makeJob } from './job.ts';
import type { reviewRun } from './review.ts';
import {
  type AgentSandbox,
  CollectRefused,
  type Sandbox,
  type SandboxOpts,
} from './sandbox.ts';
import { type AgentSession, buildShell, type SandboxPort } from './shell.ts';
import { git } from './test-git.ts';
import { fakeAgentSandbox, fakeSandbox } from './test-sandbox.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Opened = { kind: SandboxOpts['kind']; network?: boolean };

/* What the run did with sandboxes, in order, and the settings it asked each
   kind for.
*/
const recorder = (events: string[], opened: Opened[] = []) => {
  const track = (opts: SandboxOpts): Opened => {
    const settings =
      opts.kind === 'agent'
        ? { kind: opts.kind, network: opts.network }
        : { kind: opts.kind };
    opened.push(settings);
    events.push(`open ${opts.kind}`);
    return settings;
  };
  const close = (kind: Opened['kind']) => async () => {
    events.push(`close ${kind}`);
  };
  async function open(
    opts: Extract<SandboxOpts, { kind: 'agent' }>
  ): Promise<AgentSandbox>;
  async function open(opts: SandboxOpts): Promise<Sandbox>;
  async function open(opts: SandboxOpts): Promise<Sandbox | AgentSandbox> {
    track(opts);
    return opts.kind === 'agent'
      ? { ...fakeAgentSandbox(), close: close(opts.kind) }
      : { ...fakeSandbox().sandbox, close: close(opts.kind) };
  }
  const ports: SandboxPort = {
    open,
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
  };
  return ports;
};

const reviewer =
  (events: string[]): typeof reviewRun =>
  async () => {
    events.push('review');
    return {
      event: { type: 'ReviewPassed', oid: 'a'.repeat(40) },
      results: [],
    };
  };

const agentSession = (events: string[]): AgentSession => ({
  run: async () => {
    events.push('agent');
    return { event: { type: 'AgentFinished' }, calls: [] };
  },
  close: async () => {
    events.push('agent closed');
  },
});

const FIRST_ROUND: AgentRequest = { input: { kind: 'job' }, number: 1 };

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
  return {
    home,
    repo,
    runId,
    job,
    base: git(repo, 'rev-parse', 'HEAD'),
    baseBranch: 'main',
  };
};

describe('buildShell', () => {
  test.each([false, true])(
    'a round clears stale containers, makes the clone, then opens an agent sandbox with network %s, seeds and runs the agent',
    async (network) => {
      const w = world({ network });
      const events: string[] = [];
      const opened: Opened[] = [];
      const { shell } = buildShell({
        ...w,
        image: 'img',
        openAgent: async () => agentSession(events),
        report: () => {},
        sandboxes: recorder(events, opened),
      });
      await shell.runAgent(FIRST_ROUND);
      expect(events).toEqual([
        `remove ${w.runId} false`,
        'open agent',
        'seed',
        'agent',
      ]);
      expect(opened).toEqual([{ kind: 'agent', network }]);
      expect(existsSync(runDir(w.home, w.runId))).toBe(true);
    }
  );

  test('a clone that fails opens no sandbox, so no volume is made', async () => {
    const w = world({ network: false });
    const events: string[] = [];
    const { shell } = buildShell({
      ...w,
      base: 'f'.repeat(40),
      image: 'img',
      openAgent: async () => agentSession(events),
      report: () => {},
      sandboxes: recorder(events),
    });
    await expect(shell.runAgent(FIRST_ROUND)).rejects.toThrow();
    expect(events).toEqual([`remove ${w.runId} false`]);
  });

  test('review collects in the sandbox, closes it, then reviews in a separate one', async () => {
    const w = world({ network: true });
    const events: string[] = [];
    const opened: Opened[] = [];
    const { shell } = buildShell({
      ...w,
      image: 'img',
      openAgent: async () => agentSession(events),
      report: () => {},
      sandboxes: recorder(events, opened),
      review: reviewer(events),
    });
    await shell.runReview();
    expect(events).toEqual([
      `remove ${w.runId} false`,
      'open collect',
      'seed',
      'collect',
      'close collect',
      'review',
    ]);
    expect(opened).toEqual([{ kind: 'collect' }]);
  });

  test("review after a round closes the agent's session and sandbox and collects in a fresh one", async () => {
    const w = world({ network: true });
    const events: string[] = [];
    const opened: Opened[] = [];
    const { shell } = buildShell({
      ...w,
      image: 'img',
      openAgent: async () => agentSession(events),
      report: () => {},
      sandboxes: recorder(events, opened),
      review: reviewer(events),
    });
    await shell.runAgent(FIRST_ROUND);
    events.length = 0;
    await shell.runReview();
    expect(events).toEqual([
      'agent closed',
      'close agent',
      `remove ${w.runId} false`,
      'open collect',
      'seed',
      'collect',
      'close collect',
      'review',
    ]);
    expect(opened).toEqual([
      { kind: 'agent', network: true },
      { kind: 'collect' },
    ]);
  });

  test('a refused collect becomes a failed review, not a crash', async () => {
    const w = world({ network: false });
    const events: string[] = [];
    const ports = recorder(events);
    ports.collect = async () => {
      throw new CollectRefused('Packing was stopped in the sandbox.');
    };
    const { shell } = buildShell({
      ...w,
      image: 'img',
      openAgent: async () => agentSession(events),
      report: () => {},
      sandboxes: ports,
    });
    const outcome = await shell.runReview();
    expect(outcome.event).toEqual({
      type: 'ReviewFailed',
      findings: 'Packing was stopped in the sandbox.',
    });
    expect(events).toContain('close collect');
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
      openAgent: async () => agentSession(events),
      report: () => {},
      sandboxes: ports,
      review: reviewer(events),
    });
    await expect(shell.runReview()).rejects.toThrow(/Docker daemon/);
    expect(events).toContain('close collect');
    expect(events).not.toContain('review');
  });

  test("opening the PR hands off the reviewed commit, removes the run's sandboxes and volume, and repeats safely", async () => {
    const w = world({ network: false });
    const origin = join(w.home, 'origin.git');
    git(w.home, 'init', '-q', '--bare', origin);
    const ssh = join(w.home, 'ssh');
    writeFileSync(ssh, `#!/bin/sh\nexec git receive-pack "${origin}"\n`);
    chmodSync(ssh, 0o755);
    git(w.repo, 'remote', 'add', 'origin', 'git@github.com:o/r.git');
    git(w.repo, 'config', 'core.sshCommand', ssh);
    const gh = join(w.home, 'gh');
    writeFileSync(
      gh,
      '#!/bin/sh\nif [ "$2" = list ]; then echo "[]"; else echo https://github.com/o/r/pull/1; fi\n'
    );
    chmodSync(gh, 0o755);
    const events: string[] = [];
    const { shell } = buildShell({
      ...w,
      image: 'img',
      baseBranch: 'main',
      gh,
      openAgent: async () => agentSession(events),
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
