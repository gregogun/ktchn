import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_MODEL } from './agent.ts';
import { makeJob, runIdOf } from './job.ts';
import { openLedger } from './ledger.ts';
import { prepareRun } from './run-start.ts';
import { loadWorkflow } from './workflow.ts';

const usage =
  'usage: node src/start.ts <repo> <job text> [--check "<command>"]... [--allow-path "<glob>"]... [--model <id>] [--network] [--workflow <name>]';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    check: { type: 'string', multiple: true, default: [] },
    'allow-path': { type: 'string', multiple: true, default: [] },
    model: { type: 'string', default: DEFAULT_MODEL },
    network: { type: 'boolean', default: false },
    workflow: { type: 'string' },
  },
});
const [repoArg, text] = positionals;
if (repoArg === undefined || text === undefined || positionals.length > 2) {
  console.error(usage);
  process.exit(2);
}

const spec = {
  repo: realpathSync(repoArg),
  text,
  checks: values.check,
  allowPaths: values['allow-path'],
  model: values.model,
  policy: { network: values.network },
};
const runId = runIdOf(spec, values.workflow);
const home = process.env.KTCHN_HOME ?? join(homedir(), '.ktchn');

const recordedJob = () => {
  const path = join(home, 'ledger.sqlite');
  if (!existsSync(path)) return undefined;
  const ledger = openLedger(path);
  try {
    return ledger.job(runId);
  } finally {
    ledger.close();
  }
};

/* A run already started keeps the workflow text in its ledger, so resuming it
   must not depend on the workflow file or the catalogue as they are now.
*/
let job = values.workflow === undefined ? undefined : recordedJob();
if (job === undefined) {
  let workflow;
  if (values.workflow !== undefined) {
    try {
      workflow = loadWorkflow(values.workflow, {
        dir: fileURLToPath(new URL('../workflows/', import.meta.url)),
        catalogue: (process.env.KTCHN_SKILL_CATALOGUE ?? '')
          .split(delimiter)
          .filter((folder) => folder !== ''),
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }
  job = makeJob({ ...spec, workflow }).job;
}

const run = await prepareRun({
  home,
  runId,
  job,
  report: ({ state, cost }) => {
    console.log(
      `run ${runId} is ${JSON.stringify(state)}; model cost $${cost.toFixed(4)}`
    );
  },
});

const leftovers =
  run.status === 'orphan_sweep_failed' ? run.leftovers : run.sweeps.leftovers;
for (const { runId: id, error } of leftovers) {
  console.error(`could not clear the leftovers of run ${id}: ${error}`);
}
if (run.status === 'orphan_sweep_failed') {
  console.error(run.message);
  process.exit(1);
}
for (const { runId: id, reason } of run.sweeps.orphans.skipped) {
  console.error(`left the volume of run ${id}: ${reason}`);
}
for (const { runId: id, error } of run.sweeps.orphans.failed) {
  console.error(`could not remove the volume of run ${id}: ${error}`);
}
if (run.status === 'error') throw run.error;
if (run.status === 'held') {
  console.error(`run ${runId} is already being carried out by pid ${run.pid}`);
  process.exit(1);
}
if (run.status === 'already_done') {
  console.log(`run ${runId} is already done: ${run.pr}`);
  process.exit(0);
}
if (run.status === 'cannot_open_pr') {
  console.error(run.message);
  process.exit(1);
}

console.log(`run ${runId} ${run.start}`);
const end = await run.drive();
if (end.status === 'pr_not_opened') {
  console.error(
    `run ${runId} passed review but its PR was not opened: ${end.error.replace(/\s+/g, ' ')}. Run start again to retry.`
  );
  process.exitCode = 1;
}
