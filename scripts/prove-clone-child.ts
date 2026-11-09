import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { driveRun } from '../src/driver.ts';
import { openLedger, type Job } from '../src/ledger.ts';
import { buildShell } from '../src/shell.ts';

const { home, runId, job, image, base, ready } = JSON.parse(
  process.argv[2] ?? '{}'
) as {
  home: string;
  runId: string;
  job: Job;
  image: string;
  base: string;
  ready: string;
};

const ledger = openLedger(join(home, 'ledger.sqlite'));
if (!ledger.acquireLease(runId).held) throw new Error('lease is taken');
const { shell } = buildShell({
  home,
  runId,
  job,
  image,
  base,
  baseBranch: 'main',
  openAgent: async (sandbox) => ({
    run: async () => {
      const made = await sandbox.exec(
        'echo c1 > c1.txt && git add c1.txt && git commit -qm c1 && echo wip > wip.txt'
      );
      if (made.exitCode !== 0) throw new Error(made.stderr);
      writeFileSync(ready, String(process.pid));
      await new Promise(() => {
        setInterval(() => {}, 1000);
      });
      throw new Error('unreachable');
    },
    close: async () => {},
  }),
  report: () => {},
});
await driveRun(ledger, runId, shell);
