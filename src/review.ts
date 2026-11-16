import { git } from './git.ts';
import { hostFindings } from './host-review.ts';
import type { Judge, Judgement } from './reviewer.ts';
import type { RunEvent } from './run-machine.ts';
import { EXEC_TIMEOUT_MS, openReviewSandbox, type Sandbox } from './sandbox.ts';

const OUTPUT_TAIL = 4000;

export type CheckResult = {
  command: string;
  exitCode: number;
  output: string;
};

export type ReviewOutcome = {
  event: Extract<RunEvent, { type: 'ReviewPassed' | 'ReviewFailed' }>;
  results: readonly CheckResult[];
  judgement?: Judgement;
};

export const reviewOutcome = (
  results: readonly CheckResult[],
  oid: string
): ReviewOutcome => {
  const failures = results.filter((r) => r.exitCode !== 0);
  if (failures.length === 0)
    return { event: { type: 'ReviewPassed', oid }, results };
  return {
    event: {
      type: 'ReviewFailed',
      findings: failures
        .map((r) => `\`${r.command}\` exited ${r.exitCode}:\n${r.output}`)
        .join('\n\n'),
    },
    results,
  };
};

export const runChecks = async (
  sandbox: Sandbox,
  checks: readonly string[],
  oid: string,
  opts: { timeoutMs?: number } = {}
): Promise<ReviewOutcome> => {
  const timeoutMs = opts.timeoutMs ?? EXEC_TIMEOUT_MS;
  const results: CheckResult[] = [];
  for (const command of checks) {
    const { exitCode, stdout, stderr, limit } = await sandbox.exec(command, {
      timeoutMs,
    });
    const note =
      limit === 'timeout'
        ? `\n[ktchn stopped this check after ${Math.round(timeoutMs / 1000)}s]`
        : limit === 'output'
          ? '\n[ktchn stopped this check: it printed more than the output limit]'
          : '';
    results.push({
      command,
      exitCode,
      output: `${`${stdout}${stderr}`.slice(-OUTPUT_TAIL)}${note}`,
    });
  }
  return reviewOutcome(results, oid);
};

export const judgedOutcome = async (
  checked: ReviewOutcome,
  opts: { jobText: string; diff: () => string; judge: Judge }
): Promise<ReviewOutcome> => {
  if (checked.event.type !== 'ReviewPassed') return checked;
  const judgement = await opts.judge({
    jobText: opts.jobText,
    diff: opts.diff(),
    results: checked.results,
  });
  const { verdict } = judgement;
  if (verdict.kind === 'pass') return { ...checked, judgement };
  return {
    event: {
      type: 'ReviewFailed',
      findings: `The reviewer judged that the work does not do what the job asked:\n\n${verdict.findings}`,
    },
    results: checked.results,
    judgement,
  };
};

export const reviewRun = async (opts: {
  runId: string;
  repo: string;
  branch: string;
  oid: string;
  base: string;
  dirty: string;
  image: string;
  checks: readonly string[];
  allowPaths: readonly string[];
  jobText: string;
  judge: Judge;
}): Promise<ReviewOutcome> => {
  const findings = hostFindings(opts);
  if (findings.length > 0) {
    return {
      event: { type: 'ReviewFailed', findings: findings.join('\n\n') },
      results: [],
    };
  }
  const fresh = await openReviewSandbox(opts);
  let checked: ReviewOutcome;
  try {
    checked = await runChecks(fresh, opts.checks, opts.oid);
  } finally {
    await fresh.close();
  }
  return judgedOutcome(checked, {
    jobText: opts.jobText,
    diff: () => git(opts.repo, ['diff', opts.base, opts.oid]),
    judge: opts.judge,
  });
};
