import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(fileURLToPath(import.meta.url));

const git = (...args: string[]) => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith('GIT_')) env[name] = value;
  }
  return execFileSync('git', args, {
    cwd: repo,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
};

const snapshot = () => {
  const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
  return {
    head: git('rev-parse', 'HEAD'),
    tracked,
    missing: tracked.filter((file) => !existsSync(join(repo, file))),
  };
};

// A test that deletes or rewrites the repository it runs in has failed, however
// green it looks. This records HEAD and the tracked files before the suite and
// fails the run if either moved, or a tracked file is gone, once it ends.
export default function setup() {
  const before = snapshot();
  return () => {
    let after;
    try {
      after = snapshot();
    } catch (error) {
      throw new Error(`The repository at ${repo} is gone or broken`, {
        cause: error,
      });
    }
    const problems: string[] = [];
    if (after.head !== before.head) {
      problems.push(`HEAD moved from ${before.head} to ${after.head}`);
    }
    const was = new Set(before.tracked);
    const now = new Set(after.tracked);
    const lost = before.tracked.filter((file) => !now.has(file));
    const gained = after.tracked.filter((file) => !was.has(file));
    if (lost.length > 0) problems.push(`no longer tracked: ${lost.join(', ')}`);
    if (gained.length > 0) problems.push(`newly tracked: ${gained.join(', ')}`);
    if (after.missing.length > 0) {
      problems.push(`missing from disk: ${after.missing.join(', ')}`);
    }
    if (problems.length > 0) {
      throw new Error(`A test changed the repository:\n${problems.join('\n')}`);
    }
  };
}
