import type { ReviewOutcome } from './driver.ts';
import { hostFindings } from './host-review.ts';
import type { CheckResult } from './ledger.ts';
import {
  CollectRefused,
  EXEC_TIMEOUT_MS,
  openReviewSandbox,
  type Sandbox,
} from './sandbox.ts';

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

// Checks run inside a sandbox, never on the host (ADR 0012).
// A check that runs past `timeoutMs` or prints past the sandbox's output limit
// is killed and fails with a note saying so, and only the tail of its output
// is kept, so no check can stall review or fill the ledger.
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

// A sandbox the host could not collect from is a finding for the agent, not
// a crash of the run.
export const unreadable = (error: unknown) =>
  error instanceof CollectRefused
    ? error.message
    : `The work could not be collected from the sandbox: ${String(
        (error as { stderr?: string }).stderr ?? error
      )
        .trim()
        .split('\n')[0]
        ?.slice(0, 300)}. Check that .git in the sandbox's copy is intact.`;

// Review of a finished round. The host looks at the commit first; only a
// commit that passes that is checked, in a sandbox built from the commit alone.
// `oid` and `base` are fixed by the caller, so the branch moving mid-review
// cannot change what is judged.
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
  let findings: string[];
  try {
    findings = hostFindings(opts);
  } catch (error) {
    findings = [unreadable(error)];
  }
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
