import { expect, test } from 'vitest';
import { runDir, sandboxName, volumeName } from './run-resources.ts';

test('names a run directory, its volume and each kind of sandbox from the run id', () => {
  expect(runDir('/h', 'r1')).toBe('/h/runs/r1');
  expect(volumeName('r1')).toBe('ktchn-r1');
  expect(sandboxName('r1', { kind: 'agent', round: 2 })).toBe('ktchn-r1-r2');
  expect(sandboxName('r1', { kind: 'collect' })).toBe('ktchn-r1-collect');
  expect(sandboxName('r1', { kind: 'review' })).toBe('ktchn-r1-review');
});
