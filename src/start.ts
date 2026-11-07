import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { sweepFinishedRuns, sweepOrphanVolumes } from './clone.ts';
import { DEFAULT_MODEL, openAgent, readOpenRouterKey } from './agent.ts';
import { driveRun } from './driver.ts';
import { makeJob } from './job.ts';
import { openLedger } from './ledger.ts';
import { git } from './git.ts';
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
// Read before any sandbox opens, and removed from the environment as it is read.
const apiKey = readOpenRouterKey();

const startHead = git(job.repo, ['rev-parse', '--verify', 'HEAD^{commit}'], {
  scope: 'owner',
});
console.log(
  ledger.startRun(runId, job, startHead)
    ? `run ${runId} started`
    : `run ${runId} resumed`
);
const base = ledger.base(runId);
if (base === undefined) throw new Error(`Run ${runId} has no recorded base`);

const { shell, close } = buildShell({
  home,
  runId,
  job,
  image,
  base,
  openAgent: async ({ env }) => {
    if (env === undefined) throw new Error('The agent sandbox has no pi-env');
    return openAgent({
      runId,
      storePath: join(home, 'sessions', `${runId}.sqlite`),
      env,
      model: job.model,
      jobText: job.text,
      apiKey,
    });
  },
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
} finally {
  await close();
  ledger.releaseLease(runId);
  ledger.close();
}
