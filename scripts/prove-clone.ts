import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MODEL } from '../src/agent.ts';
import { runDir, sweepFinishedRuns, sweepOrphanVolumes } from '../src/clone.ts';
import { driveRun, type AgentOutcome } from '../src/driver.ts';
import { makeJob } from '../src/job.ts';
import { seedScript } from '../src/box-scripts.ts';
import { openLedger } from '../src/ledger.ts';
import { removeSandboxes, type Sandbox } from '../src/sandbox.ts';
import { buildShell } from '../src/shell.ts';
import { git, ktchnLeftovers, makeTempRepo } from './temp-repo.ts';

const image = process.env.KTCHN_IMAGE ?? 'ktchn-sandbox:latest';

// A logging git first on PATH. Every git the host runs in this process, and
// in the children it starts, is recorded with its directory and arguments.
const shimDir = mkdtempSync(join(tmpdir(), 'ktchn-shim-'));
const gitLog = join(shimDir, 'git.log');
const realGit = execFileSync('sh', ['-c', 'command -v git'], {
  encoding: 'utf8',
}).trim();
writeFileSync(
  join(shimDir, 'git'),
  `#!/bin/sh\nprintf '%s\\t%s\\n' "$PWD" "$*" >> ${JSON.stringify(gitLog)}\nexec ${JSON.stringify(realGit)} "$@"\n`
);
chmodSync(join(shimDir, 'git'), 0o755);
writeFileSync(gitLog, '');
process.env.PATH = `${shimDir}:${process.env.PATH}`;

type Round = (
  sandbox: Sandbox,
  detail: string
) => Promise<AgentOutcome['event']>;

const sh = async (sandbox: Sandbox, command: string) => {
  const r = await sandbox.exec(command);
  console.log(`  agent$ ${command.split('\n')[0]} -> exit ${r.exitCode}`);
  return r;
};

const finished: AgentOutcome['event'] = { type: 'AgentFinished' };
const giveUp: Round = async () => ({
  type: 'AgentEndedEarly',
  reason: 'scripted agent stops after seeing the findings',
});

const eventsOf = (ledger: ReturnType<typeof openLedger>, runId: string) =>
  ledger
    .records(runId)
    .flatMap((r) => (r.kind === 'run_event' ? [r.event] : []));

const fingerprint = (repo: string) => {
  const packed = join(repo, '.git', 'packed-refs');
  return {
    refs: git(
      repo,
      'for-each-ref',
      '--format=%(refname) %(objectname) %(symref)'
    ),
    head: readFileSync(join(repo, '.git', 'HEAD'), 'utf8'),
    packedRefs: existsSync(packed)
      ? createHash('sha256').update(readFileSync(packed)).digest('hex')
      : 'none',
  };
};

const runContainers = (runId: string) =>
  execFileSync('docker', ['ps', '-q', '--filter', `label=ktchn.run=${runId}`], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);

const world = (
  name: string,
  opts: {
    checks?: string[];
    allowPaths?: string[];
    network?: boolean;
  } = {}
) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ktchn-home-')));
  const repo = makeTempRepo();
  const { runId, job } = makeJob({
    repo,
    text: name,
    checks: opts.checks ?? [],
    allowPaths: opts.allowPaths ?? [],
    policy: { network: opts.network ?? false },
    model: DEFAULT_MODEL,
  });
  const ledger = openLedger(join(home, 'ledger.sqlite'));
  ledger.startRun(runId, job, git(repo, 'rev-parse', 'HEAD'));
  const base = ledger.base(runId);
  assert(base !== undefined);
  const info = { agentHostname: '', inputs: [] as string[] };
  const clone = join(runDir(home, runId), 'repo');

  const drive = async (rounds: Round[]) => {
    const { shell, close } = buildShell({
      home,
      runId,
      job,
      image,
      base,
      openAgent: async (sandbox) => ({
        run: async ({ input, number }) => {
          info.agentHostname = (await sandbox.exec('hostname')).stdout.trim();
          info.inputs.push(input.kind);
          const round = rounds[number - 1];
          assert(round, `scripted agent has no round ${number}`);
          const detail = input.kind === 'findings' ? input.findings : '';
          return { event: await round(sandbox, detail), calls: [] };
        },
        close: async () => {},
      }),
      report: () => {},
    });
    try {
      return await driveRun(ledger, runId, shell);
    } finally {
      await close();
    }
  };
  const cleanup = () => {
    removeSandboxes(runId, true);
    ledger.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  };
  return { home, repo, runId, job, base, ledger, info, clone, drive, cleanup };
};

const header = (name: string) => console.log(`\n=== ${name}`);
const names = (ledger: ReturnType<typeof openLedger>, runId: string) =>
  eventsOf(ledger, runId)
    .map((e) => e.type)
    .join(' > ');
const reviewFailed = (ledger: ReturnType<typeof openLedger>, runId: string) => {
  const failed = eventsOf(ledger, runId).find((e) => e.type === 'ReviewFailed');
  assert.equal(failed?.type, 'ReviewFailed');
  return failed.findings;
};

// (a)
{
  header('(a) edits package.json scripts and leaves a junk dir untracked');
  const w = world('(a)');
  await w.drive([
    async (s) => {
      await sh(
        s,
        `echo '{"scripts":{"test":"true"}}' > package.json && git add package.json && git commit -qm 'make tests pass'`
      );
      await sh(s, 'mkdir junk && echo x > junk/a && echo y > junk/b');
      return finished;
    },
    giveUp,
  ]);
  const findings = reviewFailed(w.ledger, w.runId);
  console.log('ReviewFailed findings:\n' + findings);
  assert.match(findings, /protected paths.*package\.json/);
  assert.match(findings, /uncommitted or untracked[\s\S]*junk\/a/);
  assert.deepEqual(w.info.inputs, ['job', 'findings']);
  assert.equal(
    git(w.repo, 'for-each-ref', '--format=%(refname)'),
    'refs/heads/main',
    'nothing was handed to the owner'
  );
  w.cleanup();
}

// (b)
{
  header('(b) a clean agent passes; only the run branch reaches the owner');
  const w = world('(b)', {
    checks: [
      'hostname',
      'git rev-parse HEAD',
      'git status --porcelain',
      'test -f feature.txt',
      'test ! -e state.cache',
    ],
  });
  const before = fingerprint(w.repo);
  const state = await w.drive([
    async (s) => {
      await sh(
        s,
        `echo '*.cache' > .gitignore && echo feature > feature.txt && git add .gitignore feature.txt && git commit -qm feature`
      );
      await sh(s, 'echo agent-state > state.cache');
      return finished;
    },
  ]);
  const passed = eventsOf(w.ledger, w.runId).find(
    (e) => e.type === 'ReviewPassed'
  );
  assert.equal(passed?.type, 'ReviewPassed');
  const checks = w.ledger.records(w.runId).find((x) => x.kind === 'checks_ran');
  assert(checks?.kind === 'checks_ran');
  for (const c of checks.results) {
    console.log(`  check ${c.command} -> exit ${c.exitCode}`);
    assert.equal(c.exitCode, 0);
  }
  assert.notEqual(checks.results[0]?.output.trim(), w.info.agentHostname);
  assert.equal(checks.results[1]?.output.trim(), passed.oid);
  const ref = `refs/heads/${w.job.branch}`;
  const after = fingerprint(w.repo);
  assert.equal(git(w.repo, 'rev-parse', ref), passed.oid);
  assert.deepEqual(
    after.refs.split('\n').sort(),
    [...before.refs.split('\n'), `${ref} ${passed.oid} `].sort(),
    `the only change to the owner's refs is ${ref}`
  );
  assert.equal(after.head, before.head);
  assert.equal(git(w.repo, 'rev-parse', 'main'), w.base);
  console.log('  owner refs after:\n' + after.refs.replace(/^/gm, '    '));
  assert.equal(state.status, 'in_review');
  console.log('events', names(w.ledger, w.runId));
  assert.equal(runContainers(w.runId).length, 0);
  w.cleanup();
}

// (c)
{
  header('(c) an agent wrecks the repository in its sandbox');
  const w = world('(c)');
  const before = fingerprint(w.repo);
  await w.drive([
    async (s) => {
      await sh(s, 'echo work > feature.txt && git add . && git commit -qm f');
      await sh(s, 'git branch -D main; echo garbage > .git/packed-refs');
      await sh(s, `echo garbage > .git/HEAD; rm -rf .git/refs/heads`);
      return finished;
    },
    giveUp,
  ]);
  const findings = reviewFailed(w.ledger, w.runId);
  console.log('ReviewFailed findings:\n' + findings);
  assert.match(findings, /could not be collected/);
  assert.deepEqual(fingerprint(w.repo), before);
  assert.equal(
    git(w.clone, 'rev-parse', `refs/heads/${w.job.branch}`),
    w.base,
    'the trusted clone did not move'
  );
  git(w.clone, 'fsck', '--no-dangling');
  console.log(
    "  the owner's refs, HEAD and packed-refs are identical; the clone is intact"
  );
  w.cleanup();
}

// (d)
{
  header('(d) an owner commit to main during the round is kept');
  const w = world('(d)');
  let ownerCommit = '';
  await w.drive([
    async (s) => {
      git(w.repo, 'config', 'user.email', 'owner@example.com');
      writeFileSync(join(w.repo, 'owner.txt'), 'owner work\n');
      git(w.repo, 'add', '.');
      git(w.repo, 'commit', '-qm', 'owner commits while the agent works');
      ownerCommit = git(w.repo, 'rev-parse', 'main');
      await sh(
        s,
        'echo f > feature.txt && git add . && git commit -qm feature'
      );
      return finished;
    },
  ]);
  assert(eventsOf(w.ledger, w.runId).some((e) => e.type === 'ReviewPassed'));
  assert.equal(git(w.repo, 'rev-parse', 'main'), ownerCommit);
  assert.equal(git(w.repo, 'rev-parse', `${w.job.branch}~1`), w.base);
  assert(existsSync(join(w.repo, 'owner.txt')), 'owner file still checked out');
  console.log('  owner main kept at', ownerCommit.slice(0, 10));
  w.cleanup();
}

// (u)
{
  header('(u) uncommitted work is a finding, then committed and passed');
  const w = world('(u)');
  await w.drive([
    async (s) => {
      await sh(s, 'echo one > a.txt && git add . && git commit -qm one');
      await sh(s, 'echo two > b.txt && echo changed >> README.md');
      return finished;
    },
    async (s, detail) => {
      assert.match(detail, /a\.txt|b\.txt|README\.md/);
      await sh(s, 'git add -A && git commit -qm two');
      return finished;
    },
  ]);
  const findings = reviewFailed(w.ledger, w.runId);
  console.log('ReviewFailed findings:\n' + findings);
  assert.match(findings, /uncommitted or untracked/);
  assert.match(findings, /b\.txt/);
  assert.match(findings, /README\.md/);
  assert(eventsOf(w.ledger, w.runId).some((e) => e.type === 'ReviewPassed'));
  console.log('events', names(w.ledger, w.runId));
  w.cleanup();
}

// (e)
{
  header(
    '(e) a real SIGKILL of the driver mid-round, with a commit and uncommitted work, then resume'
  );
  const w = world('(e)');
  const ready = join(w.home, 'ready');
  const child = spawn(
    'node',
    [
      'scripts/prove-clone-child.ts',
      JSON.stringify({
        home: w.home,
        runId: w.runId,
        job: w.job,
        image,
        base: w.base,
        ready,
      }),
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );
  const deadline = Date.now() + 120_000;
  while (!existsSync(ready)) {
    assert(Date.now() < deadline, 'the child never reached its round');
    assert.equal(child.exitCode, null, 'the child died early');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.log('  child pid', child.pid, 'is mid-round; sending SIGKILL');
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(child.signalCode, 'SIGKILL');
  const orphans = runContainers(w.runId);
  console.log('  containers still running for the run:', orphans.length);
  assert.equal(orphans.length, 1, 'the killed driver left its sandbox');
  assert.equal(
    git(w.clone, 'rev-parse', `refs/heads/${w.job.branch}`),
    w.base,
    'the commit made before the kill is only in the volume so far'
  );
  let seenInRound = '';
  const state = await w.drive([
    async (s) => {
      assert.equal(runContainers(w.runId).length, 1, 'the orphan is gone');
      assert(!orphans.some((id) => runContainers(w.runId).includes(id)));
      const found = await sh(
        s,
        'cat wip.txt && git log --format=%s -1 && git status --porcelain'
      );
      seenInRound = found.stdout;
      console.log(
        '  survived the kill:\n' + found.stdout.replace(/^/gm, '    ')
      );
      assert.match(found.stdout, /wip/);
      assert.match(found.stdout, /^c1$/m);
      await sh(s, 'git add -A && git commit -qm wip');
      return finished;
    },
  ]);
  assert(seenInRound.includes('?? wip.txt'));
  const events = eventsOf(w.ledger, w.runId);
  console.log('events', names(w.ledger, w.runId));
  assert(events.some((e) => e.type === 'Crashed'));
  assert(events.some((e) => e.type === 'ReviewPassed'));
  assert.equal(state.status, 'in_review');
  assert.equal(
    git(w.repo, 'rev-parse', `refs/heads/${w.job.branch}`),
    git(w.clone, 'rev-parse', `refs/heads/${w.job.branch}`)
  );
  assert.equal(git(w.repo, 'show', `${w.job.branch}:wip.txt`).trim(), 'wip');
  assert.equal(runContainers(w.runId).length, 0);
  console.log('  c1 and the uncommitted wip.txt both reached the handoff');
  w.cleanup();
}

// (f)
{
  header(
    '(f) a run driven to a terminal state loses its directory, volume and containers'
  );
  const w = world('(f)');
  const idle: Round = async () => finished;
  const parked = await w.drive([idle, idle, idle]);
  assert.equal(parked.status, 'parked');
  assert(existsSync(w.clone), 'a parked run keeps its clone');
  const volumes = () =>
    ktchnLeftovers().volumes.filter((v) => v === `ktchn-${w.runId}`);
  assert.equal(volumes().length, 1, 'a parked run keeps its volume');
  console.log('  parked after reviews ran out; clone and volume kept');

  w.ledger.appendEvent(w.runId, w.ledger.replay(w.runId).events, {
    type: 'OwnerFailed',
  });
  const failed = await w.drive([]);
  assert.equal(failed.status, 'failed');
  assert(!existsSync(runDir(w.home, w.runId)), 'runs directory is gone');
  assert.equal(volumes().length, 0, 'the volume is gone');
  console.log('  owner failed the run; its directory and volume are gone');

  mkdirSync(join(runDir(w.home, w.runId), 'repo'), { recursive: true });
  assert.deepEqual(sweepFinishedRuns(w.home, w.ledger).removed, [w.runId]);
  assert(!existsSync(runDir(w.home, w.runId)));
  console.log('  a leftover directory of a terminal run was swept by start');
  w.cleanup();
}

// (g)
{
  header('(g) a second start while the first is alive refuses');
  const home = mkdtempSync(join(tmpdir(), 'ktchn-home-'));
  const repo = makeTempRepo();
  const text = 'second start proof';
  const { runId, job } = makeJob({
    repo,
    text,
    checks: [],
    allowPaths: [],
    policy: { network: false },
    model: DEFAULT_MODEL,
  });
  const ledger = openLedger(join(home, 'ledger.sqlite'));
  const first = spawn('sleep', ['60']);
  assert(first.pid !== undefined);
  assert.deepEqual(ledger.acquireLease(runId, first.pid), { held: true });
  ledger.startRun(runId, job, git(repo, 'rev-parse', 'HEAD'));
  ledger.close();

  const second = spawnSync('node', ['src/start.ts', repo, text], {
    env: { ...process.env, KTCHN_HOME: home, KTCHN_IMAGE: image },
    encoding: 'utf8',
  });
  console.log('second start exit', second.status);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /already being carried out by pid/);
  assert(!existsSync(join(home, 'runs', runId)), 'no clone was made');
  first.kill();
  await new Promise((resolve) => first.once('exit', resolve));
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
}

// A benign fetch of a public page that succeeds only with a network.
const FETCH =
  'node -e "fetch(\'https://example.com\',{signal:AbortSignal.timeout(8000)}).then(()=>process.exit(0),()=>process.exit(1))"';
const inspect = (name: string, format: string) =>
  execFileSync('docker', ['inspect', '--format', format, name], {
    encoding: 'utf8',
  }).trim();

// (h)
{
  header('(h) a command printing without end is cut off, and the round fails');
  const w = world('(h)');
  await w.drive([
    async (s) => {
      const r = await s.exec('yes | head -c 6000000');
      console.log(
        `  agent$ yes | head -c 6000000 -> limit ${String(r.limit)}, kept ${r.stdout.length} bytes`
      );
      assert.equal(r.limit, 'output');
      assert(r.stdout.length <= 1024 * 1024, 'output is capped');
      await sh(s, 'echo ok > after.txt');
      return finished;
    },
    giveUp,
  ]);
  assert.equal(runContainers(w.runId).length, 0);
  w.cleanup();
}

// (i)
{
  header('(i) a command that never returns is killed at its timeout');
  const w = world('(i)');
  await w.drive([
    async (s) => {
      const started = Date.now();
      const r = await s.exec('sleep 300', { timeoutMs: 2000 });
      const took = Date.now() - started;
      console.log(
        `  agent$ sleep 300 (2s timeout) -> limit ${String(r.limit)} after ${took} ms`
      );
      assert.equal(r.limit, 'timeout');
      assert(took < 20_000, 'it did not wait for the sleep');
      const left = await s.exec(
        "for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline; echo; done | grep -c 'slee[p] 300'; true"
      );
      console.log(
        `  sleeping processes left in the container: ${left.stdout.trim()}`
      );
      assert.equal(left.stdout.trim(), '0');
      await sh(s, 'echo alive');
      return finished;
    },
    giveUp,
  ]);
  w.cleanup();
}

// (j)
{
  header('(j) a commit that is not a descendant of the base is refused');
  const w = world('(j)');
  await w.drive([
    async (s) => {
      await sh(
        s,
        `git update-ref refs/heads/${w.job.branch} $(git commit-tree -m unrelated $(git mktree < /dev/null))`
      );
      return finished;
    },
    giveUp,
  ]);
  const findings = reviewFailed(w.ledger, w.runId);
  console.log('ReviewFailed findings:\n' + findings);
  assert.match(findings, /descend|ancestor|base/i);
  assert.equal(git(w.clone, 'rev-parse', `refs/heads/${w.job.branch}`), w.base);
  assert.equal(
    git(w.repo, 'for-each-ref', '--format=%(refname)'),
    'refs/heads/main'
  );
  w.cleanup();
}

// (k)
{
  header('(k) the network is off by default, and review never has one');
  const w = world('(k)', { checks: [`! ${FETCH}`] });
  await w.drive([
    async (s) => {
      const name = `ktchn-${w.runId}-r1`;
      const mode = inspect(name, '{{.HostConfig.NetworkMode}}');
      const caps = inspect(name, '{{.HostConfig.CapDrop}}');
      const opt = inspect(name, '{{.HostConfig.SecurityOpt}}');
      const pids = inspect(name, '{{.HostConfig.PidsLimit}}');
      const mem = inspect(name, '{{.HostConfig.Memory}}');
      console.log(
        `  container: network ${mode}, cap-drop ${caps}, security-opt ${opt}, pids ${pids}, memory ${mem}`
      );
      assert.equal(mode, 'none');
      assert.match(caps, /ALL/);
      assert.match(opt, /no-new-privileges/);
      const r = await sh(s, FETCH);
      assert.notEqual(r.exitCode, 0, 'the fetch failed with no network');
      await sh(s, 'echo f > f.txt && git add f.txt && git commit -qm f');
      return finished;
    },
  ]);
  const passed = eventsOf(w.ledger, w.runId).find(
    (e) => e.type === 'ReviewPassed'
  );
  assert.equal(
    passed?.type,
    'ReviewPassed',
    'the check that expects no network passed'
  );
  w.cleanup();
}

// (l)
{
  header(
    '(l) a job started with the network has it, and review still does not'
  );
  const w = world('(l)', { network: true, checks: [`! ${FETCH}`] });
  await w.drive([
    async (s) => {
      const mode = inspect(
        `ktchn-${w.runId}-r1`,
        '{{.HostConfig.NetworkMode}}'
      );
      console.log(`  container network mode: ${mode}`);
      assert.notEqual(mode, 'none');
      const r = await sh(s, FETCH);
      assert.equal(r.exitCode, 0, 'the fetch worked with the network');
      await sh(s, 'echo l > l.txt && git add l.txt && git commit -qm l');
      return finished;
    },
  ]);
  const passed = eventsOf(w.ledger, w.runId).find(
    (e) => e.type === 'ReviewPassed'
  );
  assert.equal(passed?.type, 'ReviewPassed', 'review had no network');
  w.cleanup();
}

// (m)
{
  header('(m) the seed script refuses to delete outside a ktchn sandbox');
  // A container from a plain node image: no sentinel file, no mounts and no
  // network. The script is only ever run inside it.
  const script = seedScript({
    ref: 'refs/heads/x',
    branch: 'x',
    identity: [['user.name', 'x']],
  });
  const wrapper =
    'mkdir -p /home/agent/copy && cd /home/agent/copy && echo keep > keep.txt && (sh -c "$0" </dev/null; echo "exit=$?"); ls /home/agent/copy';
  const base = ['run', '--rm', '--network', 'none', '--cap-drop', 'ALL'];
  const run = (extra: string[]) =>
    spawnSync(
      'docker',
      [...base, ...extra, 'node:22-bookworm-slim', 'sh', '-c', wrapper, script],
      { encoding: 'utf8' }
    );
  const plain = run([]);
  console.log('  no sentinel:', plain.stdout.trim().replace(/\n/g, ' | '));
  assert.match(plain.stdout, /exit=97/);
  assert.match(plain.stdout, /keep\.txt/);
  // The right directory is not enough, and neither is a wrong directory
  // with the sentinel.
  const elsewhere = spawnSync(
    'docker',
    [
      ...base,
      'ktchn-sandbox:latest',
      'sh',
      '-c',
      'mkdir -p /tmp/other && cd /tmp/other && echo keep > keep.txt && (sh -c "$0" </dev/null; echo "exit=$?"); ls /tmp/other',
      script,
    ],
    { encoding: 'utf8' }
  );
  console.log(
    '  wrong directory:',
    elsewhere.stdout.trim().replace(/\n/g, ' | ')
  );
  assert.match(elsewhere.stdout, /exit=97/);
  assert.match(elsewhere.stdout, /keep\.txt/);
}

// (n)
{
  header('(n) a volume with no run directory is swept by its label');
  const home = mkdtempSync(join(tmpdir(), 'ktchn-home-'));
  const ledger = openLedger(join(home, 'ledger.sqlite'));
  execFileSync('docker', [
    'volume',
    'create',
    '--label',
    'ktchn.run=orphanproof',
    '--label',
    `ktchn.home=${home}`,
    'ktchn-orphanproof',
  ]);
  const has = () => ktchnLeftovers().volumes.includes('ktchn-orphanproof');
  assert(has(), 'the orphan exists');
  const swept = sweepOrphanVolumes(home, ledger);
  console.log('  swept:', JSON.stringify(swept));
  assert(swept.removed.includes('orphanproof'));
  assert(!has(), 'the orphan is gone');
  ledger.close();
  rmSync(home, { recursive: true, force: true });
}

// The invariant. Nothing the host ran git on was ever inside a sandbox.
{
  header('invariant: no host git call targets anything that was in a sandbox');
  const calls = readFileSync(gitLog, 'utf8').split('\n').filter(Boolean);
  const allowed = (dir: string) =>
    /\/ktchn-proof-[^/]+(\/|$)/.test(dir) || // an owner's project
    /\/ktchn-home-[^/]+\/runs\/[^/]+(\/repo(\.partial)?)?(\/|$)/.test(dir) || // a trusted run clone
    /\/ktchn-(pack|seed)-[^/]+(\/|$)/.test(dir); // scratch ktchn made
  let checked = 0;
  for (const line of calls) {
    const [dir = '', args = ''] = line.split('\t');
    if (dir.startsWith(shimDir)) continue;
    checked++;
    assert(allowed(dir), `a host git ran in ${dir}: git ${args}`);
    for (const word of args.split(' ')) {
      if (word.startsWith('/') && word !== '/dev/null') {
        assert(allowed(word), `a host git was handed ${word}: git ${args}`);
      }
    }
  }
  const kinds = new Set(
    calls.map((line) => (line.split('\t')[1] ?? '').split(' ')[0])
  );
  const dirs = new Set(
    calls.map((line) =>
      (line.split('\t')[0] ?? '')
        .replace(/ktchn-(proof|home|pack|seed)-[^/]+/, 'ktchn-$1-*')
        .replace(/runs\/[^/]+/, 'runs/<id>')
    )
  );
  console.log(`  ${checked} host git calls checked, all in:`);
  for (const d of [...dirs].sort()) console.log('    ' + d);
  console.log('  subcommands used:', [...kinds].sort().join(', '));
  assert(checked > 50, 'the shim saw the calls');
  const leftover = ktchnLeftovers();
  console.log(
    '\ncontainers left behind by this proof:',
    leftover.containers.length,
    'volumes:',
    leftover.volumes.length
  );
  assert.equal(leftover.containers.length, 0);
  assert.equal(leftover.volumes.length, 0);
}
rmSync(shimDir, { recursive: true, force: true });
console.log('ALL PROOFS PASSED');
