import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { checkRefName, copyCommit, git, tryGit } from './git.ts';
import { runDir } from './run-resources.ts';

const ZERO_OID = '0'.repeat(40);

export const ensureClone = (opts: {
  home: string;
  runId: string;
  source: string;
  base: string;
  branch: string;
}): string => {
  checkRefName(opts.branch);
  const dir = join(runDir(opts.home, opts.runId), 'repo');
  if (existsSync(dir)) return dir;
  const partial = `${dir}.partial`;
  rmSync(partial, { recursive: true, force: true });
  const parent = runDir(opts.home, opts.runId);
  mkdirSync(parent, { recursive: true });
  try {
    git(parent, [
      'clone',
      '--quiet',
      '--bare',
      '--no-hardlinks',
      opts.source,
      partial,
    ]);
    if (
      tryGit(partial, ['cat-file', '-e', `${opts.base}^{commit}`]) === undefined
    ) {
      git(partial, ['fetch', '--quiet', '--no-tags', opts.source, opts.base]);
    }
    git(partial, [
      'update-ref',
      '--end-of-options',
      `refs/heads/${opts.branch}`,
      opts.base,
    ]);
    git(partial, ['remote', 'remove', 'origin']);
    for (const key of ['user.name', 'user.email']) {
      const value = tryGit(opts.source, ['config', '--get', key], {
        scope: 'owner',
      });
      if (value !== undefined) git(partial, ['config', key, value]);
    }
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
  renameSync(partial, dir);
  return dir;
};

export const handOff = (opts: {
  owner: string;
  clone: string;
  branch: string;
  oid: string;
  base: string;
}) => {
  checkRefName(opts.branch);
  const ref = `refs/heads/${opts.branch}`;
  const current = tryGit(
    opts.owner,
    ['rev-parse', '--verify', '-q', '--end-of-options', ref],
    {
      scope: 'owner',
    }
  );
  if (current === opts.oid) return;
  if (current !== undefined) {
    throw new Error(
      `Refusing to hand off: ${ref} in ${opts.owner} is at ${current}, not the reviewed ${opts.oid}.`
    );
  }
  copyCommit({
    from: opts.clone,
    to: opts.owner,
    oid: opts.oid,
    excluding: opts.base,
    toScope: 'owner',
  });
  git(opts.owner, ['update-ref', '--end-of-options', ref, opts.oid, ZERO_OID], {
    scope: 'owner',
  });
};
