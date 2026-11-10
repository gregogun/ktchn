import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { docker } from './docker.ts';
import type { Ledger } from './ledger.ts';
import { isTerminal } from './run-machine.ts';
import type { SandboxOpts } from './sandbox.ts';

export const RUN_LABEL = 'ktchn.run';
export const HOME_LABEL = 'ktchn.home';

type SandboxKind =
  | { kind: 'agent'; round: number }
  | { kind: Exclude<SandboxOpts['kind'], 'agent'> };

export const runDir = (home: string, runId: string) =>
  join(home, 'runs', runId);

export const volumeName = (runId: string) => `ktchn-${runId}`;

export const sandboxName = (runId: string, sandbox: SandboxKind) =>
  sandbox.kind === 'agent'
    ? `ktchn-${runId}-r${sandbox.round}`
    : `ktchn-${runId}-${sandbox.kind}`;

export const removeRun = (home: string, runId: string) =>
  rmSync(runDir(home, runId), { recursive: true, force: true });

const listVolumes = (): {
  runId: string;
  volume: string;
  home: string;
}[] =>
  docker([
    'volume',
    'ls',
    '--filter',
    `label=${RUN_LABEL}`,
    '--format',
    `{{.Name}}\t{{.Label "${RUN_LABEL}"}}\t{{.Label "${HOME_LABEL}"}}`,
  ])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [volume = '', runId = '', home = ''] = line.split('\t');
      return { runId, volume, home };
    });

export const removeSandboxes = (runId: string, withVolume: boolean) => {
  const ids = docker([
    'ps',
    '-aq',
    '--filter',
    `label=${RUN_LABEL}=${runId}`,
  ]).split('\n');
  const found = ids.filter(Boolean);
  if (found.length > 0) docker(['rm', '-f', ...found]);
  if (withVolume) docker(['volume', 'rm', '-f', volumeName(runId)]);
};

const HELD = 'another process is carrying it out';

type Sweep = {
  removed: string[];
  skipped: { runId: string; reason: string }[];
  failed: { runId: string; error: string }[];
};

const sweepUnderLease = (
  sweep: Sweep,
  ledger: Ledger,
  runId: string,
  remove: () => void,
  due: () => boolean = () => true
) => {
  try {
    if (!due()) return;
    if (!ledger.acquireLease(runId).held) {
      sweep.skipped.push({ runId, reason: HELD });
      return;
    }
    try {
      remove();
      sweep.removed.push(runId);
    } finally {
      ledger.releaseLease(runId);
    }
  } catch (error) {
    sweep.failed.push({ runId, error: String(error) });
  }
};

export const sweepFinishedRuns = (
  home: string,
  ledger: Ledger,
  removeSandboxesOf: (runId: string) => unknown = (runId) =>
    removeSandboxes(runId, true)
): Sweep => {
  const sweep: Sweep = { removed: [], skipped: [], failed: [] };
  const runs = join(home, 'runs');
  if (!existsSync(runs)) return sweep;
  for (const runId of readdirSync(runs)) {
    sweepUnderLease(
      sweep,
      ledger,
      runId,
      () => {
        removeSandboxesOf(runId);
        removeRun(home, runId);
      },
      () => isTerminal(ledger.replay(runId).state)
    );
  }
  return sweep;
};

export const sweepOrphanVolumes = (
  home: string,
  ledger: Ledger,
  volumes: () => { runId: string; home: string }[] = listVolumes,
  removeSandboxesOf: (runId: string) => unknown = (runId) =>
    removeSandboxes(runId, true)
): Sweep => {
  const sweep: Sweep = { removed: [], skipped: [], failed: [] };
  const seen = new Set<string>();
  let listed;
  try {
    listed = volumes();
  } catch (error) {
    throw new Error(
      `Cannot list the sandbox volumes, is docker running? ${String(error).slice(0, 300)}`,
      { cause: error }
    );
  }
  for (const { runId, home: owner } of listed) {
    if (seen.has(runId) || runId === '') continue;
    if (owner === '') {
      seen.add(runId);
      if (existsSync(runDir(home, runId))) continue;
      sweep.skipped.push({
        runId,
        reason:
          "its volume has no ktchn.home label, so it cannot be told from another home's; remove it by hand if it is yours",
      });
      continue;
    }
    if (owner !== home) continue;
    seen.add(runId);
    if (existsSync(runDir(home, runId))) continue;
    sweepUnderLease(sweep, ledger, runId, () => removeSandboxesOf(runId));
  }
  return sweep;
};
