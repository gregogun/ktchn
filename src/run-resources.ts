import { join } from 'node:path';

export const RUN_LABEL = 'ktchn.run';
export const HOME_LABEL = 'ktchn.home';

export type SandboxKind =
  { kind: 'agent'; round: number } | { kind: 'collect' } | { kind: 'review' };

export const runDir = (home: string, runId: string) =>
  join(home, 'runs', runId);

export const volumeName = (runId: string) => `ktchn-${runId}`;

export const sandboxName = (runId: string, sandbox: SandboxKind) =>
  sandbox.kind === 'agent'
    ? `ktchn-${runId}-r${sandbox.round}`
    : `ktchn-${runId}-${sandbox.kind}`;
