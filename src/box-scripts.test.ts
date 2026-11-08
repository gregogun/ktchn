import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { COPY_PATH, GUARD_EXIT, seedScript, SENTINEL } from './box-scripts.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('seedScript', () => {
  /* This runs the script text on the host on purpose, in a directory made
     here, to prove it deletes nothing outside a sandbox. It is the one test
     that does, so it checks where it is before it runs anything.
  */
  test('refuses and deletes nothing when run outside a sandbox', () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ktchn-guard-')));
    dirs.push(cwd);
    expect(cwd.startsWith(realpathSync(tmpdir()) + sep)).toBe(true);
    expect(cwd).not.toBe(COPY_PATH);
    expect(existsSync(SENTINEL)).toBe(false);
    writeFileSync(join(cwd, 'keep.txt'), 'keep\n');
    mkdirSync(join(cwd, '.git'));
    writeFileSync(join(cwd, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const before = readdirSync(cwd, { recursive: true }).sort();

    const ran = spawnSync(
      'sh',
      ['-c', seedScript({ ref: 'refs/heads/main', identity: [] })],
      { cwd, input: '', encoding: 'utf8' }
    );

    expect(ran.status).toBe(GUARD_EXIT);
    expect(ran.stderr).toMatch(/not in a ktchn sandbox copy/);
    expect(readdirSync(cwd, { recursive: true }).sort()).toEqual(before);
  });
});
