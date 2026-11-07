import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

const digest = (file: string) => {
  try {
    return createHash('sha256')
      .update(readFileSync(join(repo, file)))
      .digest('hex');
  } catch {
    return 'missing';
  }
};

const snapshot = () => {
  const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
  return {
    head: git('rev-parse', 'HEAD'),
    tracked,
    status: git('status', '--porcelain', '-z'),
    contents: new Map(tracked.map((file) => [file, digest(file)])),
  };
};

// A test that deletes or rewrites the repository it runs in has failed, however
// green it looks. This records HEAD, the tracked files, their contents and the
// working tree status before the suite, and fails the run if any moved once it
// ends.
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
    const changed = before.tracked.filter(
      (file) => after.contents.get(file) !== before.contents.get(file)
    );
    if (changed.length > 0) {
      problems.push(`changed or missing on disk: ${changed.join(', ')}`);
    }
    if (after.status !== before.status) {
      problems.push('the working tree status changed');
    }
    if (problems.length > 0) {
      throw new Error(`A test changed the repository:\n${problems.join('\n')}`);
    }
  };
}
