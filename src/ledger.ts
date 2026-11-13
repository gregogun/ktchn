import { DatabaseSync } from 'node:sqlite';
import type { Job } from './job.ts';
import type { CheckResult } from './review.ts';
import type { RunEvent } from './run-machine.ts';

export type ModelCall = {
  entryId: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
};

export type LedgerRecord =
  | { kind: 'run_started'; job: Job; base: string; baseBranch: string }
  | { kind: 'run_event'; event: RunEvent }
  | { kind: 'model_call'; session: string; call: ModelCall }
  | { kind: 'checks_ran'; results: readonly CheckResult[] };

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
    startRun: (runId: string, job: Job, base: string, baseBranch: string) =>
      append(runId, 'run', { kind: 'run_started', job, base, baseBranch }),
    baseBranch: (runId: string) =>
      records(runId).find((r) => r.kind === 'run_started')?.baseBranch,
    base: (runId: string) =>
      records(runId).find((r) => r.kind === 'run_started')?.base,
    job: (runId: string) =>
      records(runId).find((r) => r.kind === 'run_started')?.job,
    appendEvent: (runId: string, at: number, event: RunEvent) =>
      append(runId, `event:${at}`, { kind: 'run_event', event }),
    recordModelCall: (runId: string, session: string, call: ModelCall) =>
      append(runId, `model_call:${session}:${call.entryId}`, {
        kind: 'model_call',
        session,
        call,
      }),
    recordChecks: (
      runId: string,
      at: number,
      results: readonly CheckResult[]
    ) => append(runId, `checks:${at}`, { kind: 'checks_ran', results }),
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
    events: (runId: string): RunEvent[] =>
      records(runId).flatMap((r) => (r.kind === 'run_event' ? [r.event] : [])),
    close: () => db.close(),
  };
};
