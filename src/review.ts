import type { ReviewOutcome } from './driver.ts';
import { hostFindings } from './host-review.ts';
import type { CheckResult } from './ledger.ts';
import { EXEC_TIMEOUT_MS, openReviewSandbox, type Sandbox } from './sandbox.ts';

const OUTPUT_TAIL = 4000;

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
}): Promise<ReviewOutcome> => {
  const findings = hostFindings(opts);
  if (findings.length > 0) {
    return {
      event: { type: 'ReviewFailed', findings: findings.join('\n\n') },
      results: [],
    };
  }
  const fresh = await openReviewSandbox(opts);
  try {
    return await runChecks(fresh, opts.checks, opts.oid);
  } finally {
    await fresh.close();
  }
};
