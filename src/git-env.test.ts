import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { git, tryGit } from './git.ts';

let home = '';
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ktchn-env-')));
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Owner\n');
  for (const name of ['HOME', 'XDG_CONFIG_HOME'])
    saved[name] = process.env[name];
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, 'xdg');
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('the git environment of the host', () => {
  test("reads the owner's user configuration only in the owner's project", () => {
    const read = ['config', '--get', 'user.name'];
    expect(tryGit(home, read, { scope: 'owner' })).toBe('Owner');
    expect(tryGit(home, read)).toBeUndefined();
    expect(tryGit(home, read, { scope: 'trusted' })).toBeUndefined();
  });

  test('ignores GIT_* variables an outer process left behind', () => {
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'user.name';
    process.env.GIT_CONFIG_VALUE_0 = 'Smuggled';
    try {
      expect(
        tryGit(home, ['config', '--get', 'user.name'], { scope: 'owner' })
      ).toBe('Owner');
      expect(
        git(home, ['config', '--get-all', 'user.name'], { scope: 'owner' })
      ).toBe('Owner');
    } finally {
      delete process.env.GIT_CONFIG_COUNT;
      delete process.env.GIT_CONFIG_KEY_0;
      delete process.env.GIT_CONFIG_VALUE_0;
    }
  });
});
