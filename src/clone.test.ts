import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ensureClone, handOff } from './clone.ts';
import { copyCommit } from './git.ts';
import { runDir } from './run-resources.ts';
import { git } from './test-git.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const setup = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ktchn-clone-')));
  dirs.push(root);
  const owner = join(root, 'owner');
  const home = join(root, 'home');
  mkdirSync(owner);
  git(owner, 'init', '-q', '-b', 'main');
  git(owner, 'config', 'user.email', 't@example.com');
  git(owner, 'config', 'user.name', 't');
  writeFileSync(join(owner, 'a.txt'), 'a\n');
  git(owner, 'add', '.');
  git(owner, 'commit', '-qm', 'init');
  const base = git(owner, 'rev-parse', 'HEAD');
  return { root, owner, home, base };
};

describe('ensureClone', () => {
  test('clones at the base with no way back to the owner', () => {
    const { owner, home, base } = setup();
    writeFileSync(join(owner, 'b.txt'), 'b\n');
    git(owner, 'add', '.');
    git(owner, 'commit', '-qm', 'later');
    const clone = ensureClone({
      home,
      runId: 'r1',
      source: owner,
      base,
      branch: 'ktchn/r1',
    });
    expect(clone).toBe(join(runDir(home, 'r1'), 'repo'));
    expect(git(clone, 'rev-parse', 'refs/heads/ktchn/r1')).toBe(base);
    expect(git(clone, 'rev-parse', '--is-bare-repository')).toBe('true');
    expect(git(clone, 'remote')).toBe('');
    expect(existsSync(join(clone, 'b.txt'))).toBe(false);
  });

  test('refuses a branch that is not a ref name and makes nothing', () => {
    const { owner, home, base } = setup();
    expect(() =>
      ensureClone({ home, runId: 'r1', source: owner, base, branch: '-x' })
    ).toThrow(/Not a ref name/);
    expect(existsSync(runDir(home, 'r1'))).toBe(false);
  });

  test("commits as the owner does, and takes no other of the owner's config", () => {
    const { owner, home, base } = setup();
    git(owner, 'config', 'core.hooksPath', '/elsewhere');
    git(owner, 'config', 'alias.x', 'status');
    const clone = ensureClone({
      home,
      runId: 'r1',
      source: owner,
      base,
      branch: 'ktchn/r1',
    });
    expect(git(clone, 'config', 'user.email')).toBe('t@example.com');
    expect(git(clone, 'config', 'user.name')).toBe('t');
    expect(() => git(clone, 'config', '--local', 'core.hooksPath')).toThrow();
    expect(() => git(clone, 'config', '--local', 'alias.x')).toThrow();
  });

  test('clones a base no branch reaches', () => {
    const { owner, home } = setup();
    writeFileSync(join(owner, 'b.txt'), 'b\n');
    git(owner, 'add', '.');
    git(owner, 'commit', '-qm', 'detached work');
    const base = git(owner, 'rev-parse', 'HEAD');
    git(owner, 'checkout', '-q', '--detach', 'HEAD~1');
    git(owner, 'branch', '-D', 'main');
    git(owner, 'reflog', 'expire', '--expire=now', '--all');
    const clone = ensureClone({
      home,
      runId: 'r1',
      source: owner,
      base,
      branch: 'ktchn/r1',
    });
    expect(git(clone, 'rev-parse', 'refs/heads/ktchn/r1')).toBe(base);
  });

  test('a second call reuses the clone and its contents', () => {
    const { owner, home, base } = setup();
    const clone = ensureClone({
      home,
      runId: 'r1',
      source: owner,
      base,
      branch: 'ktchn/r1',
    });
    git(clone, 'config', 'ktchn.mark', 'kept');
    expect(
      ensureClone({
        home,
        runId: 'r1',
        source: owner,
        base,
        branch: 'ktchn/r1',
      })
    ).toBe(clone);
    expect(git(clone, 'config', 'ktchn.mark')).toBe('kept');
  });

  test('a clone left half built is replaced', () => {
    const { owner, home, base } = setup();
    mkdirSync(join(runDir(home, 'r1'), 'repo.partial'), { recursive: true });
    writeFileSync(join(runDir(home, 'r1'), 'repo.partial', 'junk'), 'x');
    const clone = ensureClone({
      home,
      runId: 'r1',
      source: owner,
      base,
      branch: 'ktchn/r1',
    });
    expect(git(clone, 'rev-parse', 'refs/heads/ktchn/r1')).toBe(base);
    expect(existsSync(join(runDir(home, 'r1'), 'repo.partial'))).toBe(false);
  });
});

describe('handOff', () => {
  const work = () => {
    const s = setup();
    const clone = ensureClone({
      home: s.home,
      runId: 'r1',
      source: s.owner,
      base: s.base,
      branch: 'ktchn/r1',
    });
    const sandbox = join(s.root, 'sandbox');
    git(s.root, 'clone', '-q', clone, sandbox);
    git(sandbox, 'checkout', '-q', 'ktchn/r1');
    writeFileSync(join(sandbox, 'new.txt'), 'n\n');
    git(sandbox, 'add', '.');
    git(sandbox, 'commit', '-qm', 'work', '--author', 'a <a@example.com>');
    const oid = git(sandbox, 'rev-parse', 'HEAD');
    copyCommit({ from: sandbox, to: clone, oid, excluding: s.base });
    return { ...s, clone, oid };
  };

  test('creates only the run branch, at the reviewed commit', () => {
    const { owner, clone, oid, base } = work();
    const refs = git(owner, 'for-each-ref');
    handOff({ owner, clone, branch: 'ktchn/r1', oid, base });
    expect(git(owner, 'rev-parse', 'refs/heads/ktchn/r1')).toBe(oid);
    expect(git(owner, 'for-each-ref').split('\n').sort()).toEqual(
      [...refs.split('\n'), `${oid} commit\trefs/heads/ktchn/r1`].sort()
    );
    expect(existsSync(join(owner, '.git', 'FETCH_HEAD'))).toBe(false);
  });

  test('doing it again changes nothing', () => {
    const { owner, clone, oid, base } = work();
    handOff({ owner, clone, branch: 'ktchn/r1', oid, base });
    handOff({ owner, clone, branch: 'ktchn/r1', oid, base });
    expect(git(owner, 'rev-parse', 'refs/heads/ktchn/r1')).toBe(oid);
  });

  test('refuses a branch that is somewhere else and leaves it', () => {
    const { owner, clone, oid, base } = work();
    git(owner, 'branch', 'ktchn/r1', base);
    expect(() =>
      handOff({ owner, clone, branch: 'ktchn/r1', oid, base })
    ).toThrow(/Refusing to hand off/);
    expect(git(owner, 'rev-parse', 'refs/heads/ktchn/r1')).toBe(base);
  });
});
