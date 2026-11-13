import { strict as assert } from 'node:assert';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { boundAgentEnv } from '../src/agent-env.ts';
import { COPY_PATH } from '../src/box-scripts.ts';
import { driveRun } from '../src/driver.ts';
import { makeJob } from '../src/job.ts';
import { openLedger } from '../src/ledger.ts';
import { removeSandboxes } from '../src/run-resources.ts';
import { type AgentSandbox, SANDBOX_IMAGE } from '../src/sandbox.ts';
import { buildShell } from '../src/shell.ts';
import { DEFAULT_MODEL } from '../src/agent.ts';
import { DEFAULT_REVIEWER_MODEL } from '../src/reviewer.ts';
import { git, ktchnLeftovers, makeTempRepo } from './temp-repo.ts';

const image = SANDBOX_IMAGE;
const deadlineMs = Number(process.env.PROOF_DEADLINE_MS ?? 60_000);

const defaultTimeoutMs = Number(process.env.PROOF_DEFAULT_TIMEOUT_MS ?? 8000);
const agentEnv = (env: ExecutionEnv): ExecutionEnv =>
  boundAgentEnv(env, {
    defaultTimeoutMs,
    maxTimeoutMs: defaultTimeoutMs + 3000,
    maxOutputBytes: 1024 * 1024,
  });

const bash = async (env: ExecutionEnv, command: string, timeout?: number) => {
  let seen = 0;
  let omitted = 0;
  let noted = '';
  let tail = '';
  const started = Date.now();
  const result = await env.exec(
    command,
    {
      cwd: COPY_PATH,
      ...(timeout === undefined ? {} : { timeout }),
      onOutput: (text, _context, info) => {
        seen += Buffer.byteLength(text);
        omitted += info.skipped?.bytes ?? 0;
        if (text.includes('[ktchn:')) noted += text;
        tail = (tail + text).slice(-50 * 1024);
      },
      spill: { afterBytes: 50 * 1024, afterLines: 2000 },
      window: {
        maxBytes: 50 * 1024,
        maxLines: 2000,
        minIntervalMs: 50,
        bytesPerSecond: 1_000_000,
      },
    },
    ctx
  );
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const how = result.ok
    ? `exit ${result.value.exitCode}`
    : `error ${result.error.code}`;
  console.log(
    `  agent$ ${command.slice(0, 40)} -> ${how} after ${seconds}s; produced ${seen + omitted} bytes`
  );
  if (noted !== '') console.log(`    note: ${noted.trim()}`);
  const spillPath = result.ok ? result.value.spillPath : result.error.spillPath;
  return {
    result,
    noted,
    tail,
    spillPath,
    produced: seen + omitted,
    seconds: Number(seconds),
  };
};

const repo = makeTempRepo();
const home = realpathSync(mkdtempSync(join(tmpdir(), 'ktchn-home-')));
const { runId, job } = makeJob({
  repo,
  text: 'bounded agent proof',
  checks: [],
  allowPaths: [],
  policy: { network: false },
  model: DEFAULT_MODEL,
  reviewerModel: DEFAULT_REVIEWER_MODEL,
});
const ledger = openLedger(join(home, 'ledger.sqlite'));
ledger.startRun(runId, job, git(repo, 'rev-parse', 'HEAD'), 'main');
const base = ledger.base(runId);
assert(base !== undefined);

const cleanup = () => {
  removeSandboxes(runId, true);
  ledger.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
};

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

const outcome: { big?: number; seconds?: number; spill?: number } = {};
const script = async (sandbox: AgentSandbox) => {
  const env = agentEnv(sandbox.env);
  const [big, hang] = await Promise.all([
    bash(env, 'yes x'),
    bash(env, 'sleep 100000'),
  ]);
  outcome.big = big.produced;
  outcome.seconds = hang.seconds;
  check(
    !big.result.ok && big.result.error.code === 'aborted',
    'endless output was killed by the output limit'
  );
  check(big.noted.includes('printed more than'), 'and the agent was told');
  check(big.produced < 5_000_000, 'endless output was capped near 1 MiB');
  const stat =
    big.spillPath === undefined
      ? undefined
      : await sandbox.exec(`stat -c %s ${big.spillPath}`);
  outcome.spill = stat === undefined ? 0 : Number(stat.stdout.trim());
  console.log(
    `  spill file ${big.spillPath ?? '(none)'}: ${outcome.spill} bytes`
  );
  check(outcome.spill < 2 * 1024 * 1024, 'the spill file stayed near 1 MiB');
  check(
    !hang.result.ok && hang.result.error.code === 'timeout',
    'hanging command timed out'
  );
  check(
    hang.seconds >= defaultTimeoutMs / 1000 &&
      hang.seconds < defaultTimeoutMs / 1000 + 5,
    `timed out in about the default of ${defaultTimeoutMs / 1000}s`
  );
  const asked = await bash(env, 'sleep 100000', 1000);
  check(
    asked.noted.includes('above the ceiling'),
    'a request above the ceiling was clamped and said so'
  );
  const clamped = await bash(
    env,
    'head -c 200000 /dev/zero | tr "\\0" y; echo; echo END',
    1000
  );
  check(
    clamped.tail.includes('above the ceiling') && clamped.tail.includes('END'),
    'the clamp note survives in the last 50 KB of a long output'
  );
  const left = await sandbox.exec('pgrep -f "sleep 10000[0]" | wc -l');
  check(
    left.stdout.trim() === '0',
    'the killed command left no process behind'
  );
  await bash(env, 'echo done > done.txt && git add . && git commit -qm done');
};

const { shell, close } = buildShell({
  home,
  runId,
  job,
  image,
  base,
  baseBranch: 'main',
  openAgent: async (sandbox) => ({
    run: async () => {
      await script(sandbox);
      return { event: { type: 'AgentFinished' as const }, calls: [] };
    },
    close: async () => {},
  }),
  report: () => {},
});

const finish = async (code: number) => {
  await close().catch(() => {});
  cleanup();
  const left = ktchnLeftovers();
  console.log(
    `leftover containers: ${left.containers.length}, volumes: ${left.volumes.length}`
  );
  process.exit(code);
};

const deadline = new Promise<'deadline'>((resolve) =>
  setTimeout(() => resolve('deadline'), deadlineMs).unref()
);
const settled = await Promise.race([
  driveRun(ledger, runId, shell).then(
    (state) => ({ state }),
    (error: unknown) => ({ error })
  ),
  deadline,
]);

if (settled === 'deadline') {
  console.log(
    `RED: the round was still running after ${deadlineMs / 1000}s (endless output produced ${outcome.big ?? 'n/a'} bytes)`
  );
  await finish(1);
} else if ('error' in settled) {
  console.log(`RED: ${String(settled.error)}`);
  await finish(1);
} else {
  const types = ledger
    .records(runId)
    .flatMap((r) => (r.kind === 'run_event' ? [r.event.type] : []));
  console.log(`events: ${types.join(' > ')}`);
  check(types.includes('ReviewPassed'), 'the round continued to review');
  if (failures.length > 0) {
    console.log(`RED: ${failures.join('; ')}`);
    await finish(1);
  }
  console.log(
    `GREEN: endless output stopped at ${outcome.big} bytes with a ${outcome.spill} byte spill file, hanging command timed out after ${outcome.seconds}s, round reached review`
  );
  await finish(0);
}
