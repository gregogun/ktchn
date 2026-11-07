import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  checkRefName,
  copyCommit,
  git,
  importPack,
  isAncestor,
  tryGit,
} from './git.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const setup = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ktchn-git-')));
  dirs.push(root);
  const from = join(root, 'from');
  mkdirSync(from);
  git(from, ['init', '-q', '-b', 'main']);
  git(from, ['config', 'user.email', 't@example.com']);
  git(from, ['config', 'user.name', 't']);
  writeFileSync(join(from, 'a.txt'), 'a\n');
  git(from, ['add', '.']);
  git(from, ['commit', '-qm', 'init']);
  const base = git(from, ['rev-parse', 'HEAD']);
  const to = join(root, 'to.git');
  git(root, ['clone', '-q', '--bare', from, to]);
  writeFileSync(join(from, 'b.txt'), 'b\n');
  git(from, ['add', '.']);
  git(from, ['commit', '-qm', 'work']);
  return { root, from, to, base, oid: git(from, ['rev-parse', 'HEAD']) };
};

describe('git', () => {
  test('does not see the GIT_ variables a hook leaves behind', () => {
    const { from } = setup();
    process.env.GIT_DIR = '/nowhere';
    try {
      expect(git(from, ['rev-parse', '--git-dir'])).toBe('.git');
    } finally {
      delete process.env.GIT_DIR;
    }
  });

  test('tryGit answers undefined for a failure', () => {
    const { from } = setup();
    expect(tryGit(from, ['cat-file', '-e', 'deadbeef'.repeat(5)])).toBe(
      undefined
    );
  });
});

describe('copyCommit', () => {
  test('brings a commit and what it needs, sending only what is new', () => {
    const { from, to, base, oid } = setup();
    copyCommit({ from, to, oid, excluding: base });
    expect(git(to, ['cat-file', '-t', oid])).toBe('commit');
    expect(
      git(to, ['rev-list', '--objects', '--quiet', oid, '--not', '--all'])
    ).toBe('');
  });

  test('leaves no ref and no FETCH_HEAD in the destination', () => {
    const { from, to, oid } = setup();
    const before = git(to, ['for-each-ref']);
    copyCommit({ from, to, oid });
    expect(git(to, ['for-each-ref'])).toBe(before);
  });

  test('falls back to a full pack when the destination lacks the excluded commit', () => {
    const { from, root, oid } = setup();
    const empty = join(root, 'empty.git');
    git(root, ['init', '-q', '--bare', empty]);
    copyCommit({ from, to: empty, oid, excluding: oid });
    expect(git(empty, ['cat-file', '-t', oid])).toBe('commit');
  });

  test('refuses something that is not an object id', () => {
    const { from, to } = setup();
    expect(() => copyCommit({ from, to, oid: '--upload-pack=x' })).toThrow(
      /Not an object id/
    );
  });
});

describe('importPack', () => {
  test('imports a complete pack', () => {
    const { from, to, oid, root } = setup();
    const full = join(root, 'full.pack');
    execFileSync('sh', ['-c', `git pack-objects --revs --stdout > ${full}`], {
      cwd: from,
      input: `${oid}\n`,
    });
    importPack(full, to, oid);
    expect(git(to, ['cat-file', '-t', oid])).toBe('commit');
  });

  test('refuses a pack with a damaged object', () => {
    const { from, to, oid, root } = setup();
    const pack = join(root, 'bad.pack');
    execFileSync('sh', ['-c', `git pack-objects --revs --stdout > ${pack}`], {
      cwd: from,
      input: `${oid}\n`,
    });
    writeFileSync(
      pack,
      Buffer.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 1, 0xff, 0xff])
    );
    expect(() => importPack(pack, to, oid)).toThrow();
  });

  test('refuses a commit whose parents the repository lacks', () => {
    const { from, root, oid } = setup();
    const empty = join(root, 'empty.git');
    git(root, ['init', '-q', '--bare', empty]);
    const pack = join(root, 'thin.pack');
    execFileSync('sh', ['-c', `git pack-objects --revs --stdout > ${pack}`], {
      cwd: from,
      input: `${oid}\n^${oid}~1\n`,
    });
    expect(() => importPack(pack, empty, oid)).toThrow();
  });
});

describe('isAncestor', () => {
  test('answers whether one commit is reachable from another', () => {
    const { from, base, oid } = setup();
    expect(isAncestor(from, base, oid)).toBe(true);
    expect(isAncestor(from, oid, base)).toBe(false);
  });

  test('throws when git cannot answer, rather than saying no', () => {
    const { to, base, oid } = setup();
    expect(() => isAncestor(to, base, oid)).toThrow();
  });
});

describe('checkRefName', () => {
  test.each(['ktchn/abc123', 'refs/heads/ktchn/abc123', 'refs/ktchn/review'])(
    'accepts %s',
    (name) => {
      expect(() => checkRefName(name)).not.toThrow();
    }
  );

  test.each([
    '-x',
    '--upload-pack=touch',
    'a..b',
    'refs/heads/a.lock',
    'a//b',
    'a/',
    'a;b',
    'a b',
    '',
  ])('refuses %j', (name) => {
    expect(() => checkRefName(name)).toThrow(/Not a ref name/);
  });
});
