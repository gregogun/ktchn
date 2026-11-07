import { strict as assert } from 'node:assert';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { COPY_PATH } from '../src/box-scripts.ts';
import { driveRun } from '../src/driver.ts';
import { makeJob } from '../src/job.ts';
import { openLedger } from '../src/ledger.ts';
import { removeSandboxes, type Sandbox } from '../src/sandbox.ts';
import { buildShell } from '../src/shell.ts';
import { DEFAULT_MODEL } from '../src/agent.ts';
import { git, ktchnLeftovers, makeTempRepo } from './temp-repo.ts';

const image = process.env.KTCHN_IMAGE ?? 'ktchn-sandbox:latest';
const deadlineMs = Number(process.env.PROOF_DEADLINE_MS ?? 15_000);

const agentEnv = (env: ExecutionEnv): ExecutionEnv => env;

const bash = async (env: ExecutionEnv, command: string) => {
  let seen = 0;
  let omitted = 0;
  let tail = '';
  const started = Date.now();
  const result = await env.exec(
    command,
    {
      cwd: COPY_PATH,
      onOutput: (text, _context, info) => {
        seen += Buffer.byteLength(text);
        omitted += info.skipped?.bytes ?? 0;
        tail = (tail + text).slice(-300);
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
  if (tail.includes('[ktchn')) console.log(`    note: ${tail.trim()}`);
  return { result, produced: seen + omitted, seconds: Number(seconds) };
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
});
const ledger = openLedger(join(home, 'ledger.sqlite'));
ledger.startRun(runId, job, git(repo, 'rev-parse', 'HEAD'));
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

const outcome: { big?: number; seconds?: number } = {};
const script = async (sandbox: Sandbox) => {
  assert(sandbox.env !== undefined, 'the agent sandbox has pi-env');
  const env = agentEnv(sandbox.env);
  const big = await bash(env, "head -c 20000000 /dev/zero | tr '\\0' x");
  outcome.big = big.produced;
  check(!big.result.ok, 'huge output was stopped');
  check(big.produced < 5_000_000, 'huge output was capped near 1 MiB');
  const hang = await bash(env, 'sleep 100000');
  outcome.seconds = hang.seconds;
  check(
    !hang.result.ok && hang.result.error.code === 'timeout',
    'hanging command timed out'
  );
  await bash(env, 'echo done > done.txt && git add . && git commit -qm done');
};

const { shell, close } = buildShell({
  home,
  runId,
  job,
  image,
  base,
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
    `RED: the round was still running after ${deadlineMs / 1000}s (huge output produced ${outcome.big ?? 'n/a'} bytes)`
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
    `GREEN: huge output stopped at ${outcome.big} bytes, hanging command timed out after ${outcome.seconds}s, round reached review`
  );
  await finish(0);
}
