import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_MODEL } from './agent.ts';
import { makeJob } from './job.ts';
import { prepareRun } from './run-start.ts';

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

const home = process.env.KTCHN_HOME ?? join(homedir(), '.ktchn');

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
