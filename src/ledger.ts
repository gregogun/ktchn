import { DatabaseSync } from 'node:sqlite';
import {
  newRun,
  type AgentInput,
  transition,
  type Effect,
  type RunEvent,
  type RunState,
} from './run-machine.ts';

// What a job lets its sandbox do. The agent's sandbox has no network unless
// the job says so; review's never has one (ADR 0015).
export type Policy = { network: boolean };

export type Job = {
  policy: Policy;
  repo: string;
  branch: string;
  text: string;
  checks: readonly string[];
  allowPaths: readonly string[];
  model: string;
};

export type ModelCall = {
  entryId: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
};

export type CheckResult = {
  command: string;
  exitCode: number;
  output: string;
};

export type LedgerRecord =
  | { kind: 'run_started'; job: Job; base: string }
  | { kind: 'run_event'; event: RunEvent }
  | { kind: 'model_call'; call: ModelCall }
  | { kind: 'checks_ran'; results: readonly CheckResult[] };

export type FreshAgentInput = Exclude<AgentInput, { kind: 'resume' }>;

// The newest input the agent was given, numbered among all fresh inputs. A
// crash resume carries on this same request rather than making a new one.
export type AgentRequest = { input: FreshAgentInput; number: number };

type Replay = {
  state: RunState;
  effects: readonly Effect[];
  events: number;
  agentRequest: AgentRequest | undefined;
};

const replay = (events: readonly RunEvent[]): Replay => {
  let state = newRun;
  let effects: readonly Effect[] = [];
  let agentRequest: AgentRequest | undefined;
  for (const event of events) {
    ({ state, effects } = transition(state, event));
    for (const effect of effects) {
      if (effect.type === 'RunAgent' && effect.input.kind !== 'resume') {
        agentRequest = {
          input: effect.input,
          number: (agentRequest?.number ?? 0) + 1,
        };
      }
    }
  }
  return { state, effects, events: events.length, agentRequest };
};

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export type Lease = { held: true } | { held: false; pid: number };

export type Ledger = ReturnType<typeof openLedger>;

export const openLedger = (path: string) => {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS ledger (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      key TEXT NOT NULL,
      record TEXT NOT NULL,
      at TEXT NOT NULL,
      UNIQUE (run_id, key)
    );
    CREATE TABLE IF NOT EXISTS lease (
      run_id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      started_at TEXT NOT NULL
    )`);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO ledger (run_id, key, record, at) VALUES (?, ?, ?, ?)'
  );
  const select = db.prepare(
    'SELECT record FROM ledger WHERE run_id = ? ORDER BY seq'
  );

  const leaseOf = db.prepare('SELECT pid FROM lease WHERE run_id = ?');
  const takeLease = db.prepare(
    'INSERT OR REPLACE INTO lease (run_id, pid, started_at) VALUES (?, ?, ?)'
  );
  const dropLease = db.prepare(
    'DELETE FROM lease WHERE run_id = ? AND pid = ?'
  );

  const append = (runId: string, key: string, record: LedgerRecord) =>
    insert.run(runId, key, JSON.stringify(record), new Date().toISOString())
      .changes === 1;

  const records = (runId: string): LedgerRecord[] =>
    select
      .all(runId)
      .map((row) => JSON.parse(String(row.record)) as LedgerRecord);

  return {
    records,
    // `base` is the commit the run starts from. A resume keeps the first one.
    startRun: (runId: string, job: Job, base: string) =>
      append(runId, 'run', { kind: 'run_started', job, base }),
    base: (runId: string) =>
      records(runId).find((r) => r.kind === 'run_started')?.base,
    job: (runId: string) =>
      records(runId).find((r) => r.kind === 'run_started')?.job,
    // `at` is how many events the caller decided from, so a repeat of the
    // same decision after a crash lands on the same key and is ignored.
    appendEvent: (runId: string, at: number, event: RunEvent) =>
      append(runId, `event:${at}`, { kind: 'run_event', event }),
    recordModelCall: (runId: string, call: ModelCall) =>
      append(runId, `model_call:${call.entryId}`, { kind: 'model_call', call }),
    recordChecks: (
      runId: string,
      at: number,
      results: readonly CheckResult[]
    ) => append(runId, `checks:${at}`, { kind: 'checks_ran', results }),
    // One driver per run: the lease names the process carrying the run out.
    // A lease whose process is gone is taken over.
    acquireLease: (
      runId: string,
      pid: number = process.pid,
      isAlive: (pid: number) => boolean = pidAlive
    ): Lease => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const held = leaseOf.get(runId);
        if (held !== undefined && isAlive(Number(held.pid))) {
          db.exec('COMMIT');
          return { held: false, pid: Number(held.pid) };
        }
        takeLease.run(runId, pid, new Date().toISOString());
        db.exec('COMMIT');
        return { held: true };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    releaseLease: (runId: string, pid: number = process.pid) => {
      dropLease.run(runId, pid);
    },
    replay: (runId: string) =>
      replay(
        records(runId).flatMap((r) => (r.kind === 'run_event' ? [r.event] : []))
      ),
    close: () => db.close(),
  };
};
