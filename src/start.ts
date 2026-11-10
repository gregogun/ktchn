import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_MODEL, openAgent, readOpenRouterKey } from './agent.ts';
import { driveRun } from './driver.ts';
import { makeJob } from './job.ts';
import { openLedger } from './ledger.ts';
import { checkCanOpenPr, originBase } from './pr.ts';
import { isTerminal } from './run-machine.ts';
import { sweepFinishedRuns, sweepOrphanVolumes } from './run-resources.ts';
import { buildShell } from './shell.ts';

const usage =
  'usage: node src/start.ts <repo> <job text> [--check "<command>"]... [--allow-path "<glob>"]... [--model <id>] [--network]';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    check: { type: 'string', multiple: true, default: [] },
    'allow-path': { type: 'string', multiple: true, default: [] },
    model: { type: 'string', default: DEFAULT_MODEL },
    network: { type: 'boolean', default: false },
  },
});
const [repoArg, text] = positionals;
if (repoArg === undefined || text === undefined || positionals.length > 2) {
  console.error(usage);
  process.exit(2);
}

const { runId, job } = makeJob({
  repo: realpathSync(repoArg),
  text,
  checks: values.check,
  allowPaths: values['allow-path'],
  model: values.model,
  policy: { network: values.network },
});

const image = process.env.KTCHN_IMAGE ?? 'ktchn-sandbox:latest';
const home = process.env.KTCHN_HOME ?? join(homedir(), '.ktchn');
mkdirSync(join(home, 'sessions'), { recursive: true });
const ledger = openLedger(join(home, 'ledger.sqlite'));
const swept = sweepFinishedRuns(home, ledger);
for (const { runId: id, error } of swept.failed) {
  console.error(`could not clear the leftovers of run ${id}: ${error}`);
}
let orphans;
try {
  orphans = sweepOrphanVolumes(home, ledger);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  ledger.close();
  process.exit(1);
}
for (const { runId: id, reason } of orphans.skipped) {
  console.error(`left the volume of run ${id}: ${reason}`);
}
for (const { runId: id, error } of orphans.failed) {
  console.error(`could not remove the volume of run ${id}: ${error}`);
}
const lease = ledger.acquireLease(runId);
if (!lease.held) {
  console.error(
    `run ${runId} is already being carried out by pid ${lease.pid}`
  );
  ledger.close();
  process.exit(1);
}
const before = ledger.replay(runId).state;
if (before.status === 'done') {
  console.log(`run ${runId} is already done: ${before.pr}`);
  ledger.releaseLease(runId);
  ledger.close();
  process.exit(0);
}
if (!isTerminal(before)) {
  try {
    checkCanOpenPr(job.repo);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    ledger.releaseLease(runId);
    ledger.close();
    process.exit(1);
  }
}
const apiKey = readOpenRouterKey();

if (ledger.base(runId) === undefined) {
  const start = originBase(job.repo);
  ledger.startRun(runId, job, start.base, start.baseBranch);
  console.log(`run ${runId} started`);
} else {
  console.log(`run ${runId} resumed`);
}
const base = ledger.base(runId);
const baseBranch = ledger.baseBranch(runId);
if (base === undefined || baseBranch === undefined) {
  throw new Error(`Run ${runId} has no recorded base branch`);
}

const { shell, close } = buildShell({
  home,
  runId,
  job,
  image,
  base,
  baseBranch,
  openAgent: async ({ env }) =>
    openAgent({
      runId,
      storePath: join(home, 'sessions', `${runId}.sqlite`),
      env,
      model: job.model,
      job,
      apiKey,
    }),
  report: (state) => {
    const cost = ledger
      .records(runId)
      .reduce((sum, r) => sum + (r.kind === 'model_call' ? r.call.cost : 0), 0);
    console.log(
      `run ${runId} is ${JSON.stringify(state)}; model cost $${cost.toFixed(4)}`
    );
  },
});

try {
  await driveRun(ledger, runId, shell);
} catch (error) {
  const state = ledger.replay(runId).state;
  if (state.status !== 'in_review' || state.step !== 'opening_pr') throw error;
  console.error(
    `run ${runId} passed review but its PR was not opened: ${(error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ')}. Run start again to retry.`
  );
  process.exitCode = 1;
} finally {
  await close();
  ledger.releaseLease(runId);
  ledger.close();
}
