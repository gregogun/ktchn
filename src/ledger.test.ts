import { describe, expect, test } from 'vitest';
import type { Job } from './job.ts';
import { openLedger } from './ledger.ts';

const job: Job = {
  repo: '/repo',
  branch: 'ktchn/run-1',
  text: 'Add a README',
  checks: ['pnpm test'],
  allowPaths: [],
  policy: { network: false },
  model: 'anthropic/claude-haiku-4.5',
};

describe('ledger', () => {
  test('a run with no events is queued with its job', () => {
    const ledger = openLedger(':memory:');
    ledger.startRun('run-1', job, 'abc', 'main');
    expect(ledger.job('run-1')).toEqual(job);
    expect(ledger.base('run-1')).toBe('abc');
    expect(ledger.replay('run-1').state.status).toBe('queued');
  });

  test('a resumed run keeps the base it started from', () => {
    const ledger = openLedger(':memory:');
    expect(ledger.startRun('run-1', job, 'abc', 'main')).toBe(true);
    expect(ledger.startRun('run-1', job, 'def', 'dev')).toBe(false);
    expect(ledger.base('run-1')).toBe('abc');
    expect(ledger.baseBranch('run-1')).toBe('main');
  });

  test('run state is the events replayed through the run machine', () => {
    const ledger = openLedger(':memory:');
    ledger.appendEvent('run-1', 0, { type: 'Dequeued' });
    ledger.appendEvent('run-1', 1, { type: 'AgentFinished' });
    ledger.appendEvent('run-1', 2, {
      type: 'ReviewFailed',
      findings: 'tests fail',
    });
    const { state, effects, events, agentRequest } = ledger.replay('run-1');
    expect(state).toMatchObject({ status: 'running', reviewsLeft: 2 });
    expect(effects).toEqual([
      { type: 'RunAgent', input: { kind: 'findings', findings: 'tests fail' } },
    ]);
    expect(events).toBe(3);
    expect(agentRequest).toEqual({
      input: { kind: 'findings', findings: 'tests fail' },
      number: 2,
    });
  });

  test('a second event decided from the same position is ignored', () => {
    const ledger = openLedger(':memory:');
    expect(ledger.appendEvent('run-1', 0, { type: 'Dequeued' })).toBe(true);
    expect(ledger.appendEvent('run-1', 0, { type: 'Dequeued' })).toBe(false);
    expect(ledger.appendEvent('run-1', 0, { type: 'OwnerCancelled' })).toBe(
      false
    );
    expect(ledger.replay('run-1').state.status).toBe('running');
  });

  test('runs keep separate records and model calls are kept once', () => {
    const ledger = openLedger(':memory:');
    const call = {
      entryId: 11,
      model: 'anthropic/claude-haiku-4.5',
      inputTokens: 1313,
      outputTokens: 86,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.001743,
    };
    ledger.recordModelCall('run-1', call);
    ledger.recordModelCall('run-1', call);
    ledger.appendEvent('run-2', 0, { type: 'Dequeued' });
    expect(ledger.records('run-1')).toEqual([{ kind: 'model_call', call }]);
    expect(ledger.replay('run-1').state.status).toBe('queued');
  });

  test('the record survives reopening the file', () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/ktchn-ledger-${process.pid}-${Date.now()}.sqlite`;
    const first = openLedger(path);
    first.appendEvent('run-1', 0, { type: 'Dequeued' });
    first.close();
    expect(openLedger(path).replay('run-1').state.status).toBe('running');
  });
});

describe('lease', () => {
  const alive = () => true;
  const dead = () => false;

  test('a run has one driver while its process is alive', () => {
    const ledger = openLedger(':memory:');
    expect(ledger.acquireLease('run-1', 111, alive)).toEqual({ held: true });
    expect(ledger.acquireLease('run-1', 222, alive)).toEqual({
      held: false,
      pid: 111,
    });
  });

  test('a lease whose process is dead is taken over', () => {
    const ledger = openLedger(':memory:');
    ledger.acquireLease('run-1', 111, alive);
    expect(ledger.acquireLease('run-1', 222, dead)).toEqual({ held: true });
    expect(ledger.acquireLease('run-1', 333, alive)).toEqual({
      held: false,
      pid: 222,
    });
  });

  test('leases are per run, and a released lease is free', () => {
    const ledger = openLedger(':memory:');
    ledger.acquireLease('run-1', 111, alive);
    expect(ledger.acquireLease('run-2', 222, alive)).toEqual({ held: true });
    ledger.releaseLease('run-1', 111);
    expect(ledger.acquireLease('run-1', 333, alive)).toEqual({ held: true });
  });

  test('a release by a process that lost the lease leaves it alone', () => {
    const ledger = openLedger(':memory:');
    ledger.acquireLease('run-1', 111, alive);
    ledger.acquireLease('run-1', 222, dead);
    ledger.releaseLease('run-1', 111);
    expect(ledger.acquireLease('run-1', 333, alive)).toEqual({
      held: false,
      pid: 222,
    });
  });

  test('the real process check sees this process alive and a gone one dead', () => {
    const ledger = openLedger(':memory:');
    ledger.acquireLease('run-1', process.pid);
    expect(ledger.acquireLease('run-1', 1)).toEqual({
      held: false,
      pid: process.pid,
    });
    ledger.acquireLease('run-2', 2 ** 22 + 12345);
    expect(ledger.acquireLease('run-2', process.pid)).toEqual({ held: true });
  });
});
