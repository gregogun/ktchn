import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { openLedger, type Ledger } from './ledger.ts';
import {
  removeRun,
  runDir,
  sandboxName,
  sweepFinishedRuns,
  sweepOrphanVolumes,
  volumeName,
} from './run-resources.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const setup = () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ktchn-resources-')));
  dirs.push(home);
  const makeRunDir = (runId: string) =>
    mkdirSync(join(runDir(home, runId), 'repo'), { recursive: true });
  return { home, makeRunDir };
};

test('names a run directory, its volume and each kind of sandbox from the run id', () => {
  expect(runDir('/h', 'r1')).toBe('/h/runs/r1');
  expect(volumeName('r1')).toBe('ktchn-r1');
  expect(sandboxName('r1', { kind: 'agent', round: 2 })).toBe('ktchn-r1-r2');
  expect(sandboxName('r1', { kind: 'collect' })).toBe('ktchn-r1-collect');
  expect(sandboxName('r1', { kind: 'review' })).toBe('ktchn-r1-review');
});

test('removing a run takes its directory, and a run with none is fine', () => {
  const { home, makeRunDir } = setup();
  makeRunDir('r1');
  removeRun(home, 'r1');
  expect(existsSync(runDir(home, 'r1'))).toBe(false);
  expect(() => removeRun(home, 'r1')).not.toThrow();
});

describe.each([
  {
    name: 'sweepFinishedRuns',
    due: (home: string, ledger: Ledger, runId: string) => {
      mkdirSync(join(runDir(home, runId), 'repo'), { recursive: true });
      ledger.appendEvent(runId, 0, { type: 'OwnerCancelled' });
    },
    sweep: (
      home: string,
      ledger: Ledger,
      ids: string[],
      removeSandboxesOf: (runId: string) => unknown
    ) => sweepFinishedRuns(home, ledger, removeSandboxesOf),
  },
  {
    name: 'sweepOrphanVolumes',
    due: () => undefined,
    sweep: (
      home: string,
      ledger: Ledger,
      ids: string[],
      removeSandboxesOf: (runId: string) => unknown
    ) =>
      sweepOrphanVolumes(
        home,
        ledger,
        () => ids.map((runId) => ({ runId, home })),
        removeSandboxesOf
      ),
  },
])('$name under the run lease', ({ due, sweep }) => {
  const noContainers = () => [];

  test('leaves a run whose driver is still alive for a later start', () => {
    const { home } = setup();
    const ledger = openLedger(':memory:');
    due(home, ledger, 'busy');
    ledger.acquireLease('busy', process.ppid);
    const removed: string[] = [];
    const swept = sweep(home, ledger, ['busy'], (id) => removed.push(id));
    expect(swept.skipped.map((s) => s.runId)).toEqual(['busy']);
    expect(swept.removed).toEqual([]);
    expect(removed).toEqual([]);
    expect(ledger.acquireLease('busy')).toEqual({
      held: false,
      pid: process.ppid,
    });
  });

  test('releases the lease it took', () => {
    const { home } = setup();
    const ledger = openLedger(':memory:');
    due(home, ledger, 'dead');
    expect(sweep(home, ledger, ['dead'], noContainers).removed).toEqual([
      'dead',
    ]);
    expect(ledger.acquireLease('dead', process.ppid)).toEqual({ held: true });
  });

  test('reports a run that will not go, releases its lease, and carries on', () => {
    const { home } = setup();
    const ledger = openLedger(':memory:');
    for (const id of ['a', 'b', 'c']) due(home, ledger, id);
    const swept = sweep(home, ledger, ['a', 'b', 'c'], (runId) => {
      if (runId === 'b') throw new Error('docker is not answering');
    });
    expect(swept.removed.sort()).toEqual(['a', 'c']);
    expect(swept.failed).toEqual([
      { runId: 'b', error: expect.stringContaining('docker is not answering') },
    ]);
    expect(ledger.acquireLease('b', process.ppid)).toEqual({ held: true });
  });
});

describe('sweepFinishedRuns', () => {
  const noContainers = () => [];

  test('sweeps only the runs whose ledger state is terminal', () => {
    const { home, makeRunDir } = setup();
    const ledger = openLedger(':memory:');
    for (const id of ['live', 'dead', 'unknown']) makeRunDir(id);
    ledger.appendEvent('live', 0, { type: 'Dequeued' });
    ledger.appendEvent('dead', 0, { type: 'OwnerCancelled' });
    expect(sweepFinishedRuns(home, ledger, noContainers).removed).toEqual([
      'dead',
    ]);
    expect(existsSync(runDir(home, 'dead'))).toBe(false);
    expect(existsSync(runDir(home, 'live'))).toBe(true);
    expect(existsSync(runDir(home, 'unknown'))).toBe(true);
  });

  test('sweeping with no runs directory does nothing', () => {
    const { home } = setup();
    expect(
      sweepFinishedRuns(home, openLedger(':memory:'), noContainers)
    ).toEqual({ removed: [], skipped: [], failed: [] });
  });

  test('a run that will not go keeps its directory', () => {
    const { home, makeRunDir } = setup();
    const ledger = openLedger(':memory:');
    makeRunDir('b');
    ledger.appendEvent('b', 0, { type: 'OwnerCancelled' });
    sweepFinishedRuns(home, ledger, () => {
      throw new Error('docker is not answering');
    });
    expect(existsSync(runDir(home, 'b'))).toBe(true);
  });
});

describe('sweepOrphanVolumes', () => {
  const volumes =
    (home: string, ...ids: string[]) =>
    () =>
      ids.map((runId) => ({ runId, home }));

  test('removes volumes whose run has no directory, known to the ledger or not', () => {
    const { home, makeRunDir } = setup();
    makeRunDir('kept');
    const ledger = openLedger(':memory:');
    const removed: string[] = [];
    const sweep = sweepOrphanVolumes(
      home,
      ledger,
      volumes(home, 'kept', 'gone', 'gone', 'stranger'),
      (id) => removed.push(id)
    );
    expect(sweep.removed).toEqual(['gone', 'stranger']);
    expect(removed).toEqual(['gone', 'stranger']);
  });

  test("leaves another home's volumes alone", () => {
    const { home } = setup();
    const removed: string[] = [];
    const sweep = sweepOrphanVolumes(
      home,
      openLedger(':memory:'),
      volumes('/somewhere/else', 'theirs'),
      (id) => removed.push(id)
    );
    expect(sweep.removed).toEqual([]);
    expect(removed).toEqual([]);
  });

  test('reports a volume with no home label, and does not remove it', () => {
    const { home } = setup();
    const removed: string[] = [];
    const sweep = sweepOrphanVolumes(
      home,
      openLedger(':memory:'),
      volumes('', 'old'),
      (id) => removed.push(id)
    );
    expect(removed).toEqual([]);
    expect(sweep.removed).toEqual([]);
    expect(sweep.skipped).toEqual([
      { runId: 'old', reason: expect.stringContaining('ktchn.home') },
    ]);
  });
});
