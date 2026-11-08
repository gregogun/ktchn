import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { OUTPUT_EXIT, runBounded, TIMEOUT_EXIT } from './bounded.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const node = (script: string) => ({
  file: process.execPath,
  args: ['-e', script],
});
const endlessOut = (stream: 'stdout' | 'stderr') =>
  `setInterval(() => process.${stream}.write('x'.repeat(65536)), 1)`;

describe('runBounded', () => {
  test('returns the output and exit code of a command inside its limits', async () => {
    const r = await runBounded({
      ...node('console.log("hi"); console.error("oops"); process.exit(3)'),
      maxBytes: 1000,
      timeoutMs: 10_000,
    });
    expect(r).toEqual({ exitCode: 3, stdout: 'hi\n', stderr: 'oops\n' });
  });

  test.each(['stdout', 'stderr'] as const)(
    'kills a command that prints endlessly on %s and keeps only the cap',
    async (stream) => {
      const started = Date.now();
      const r = await runBounded({
        ...node(endlessOut(stream)),
        maxBytes: 100_000,
        timeoutMs: 20_000,
      });
      expect(r.limit).toBe('output');
      expect(r.exitCode).toBe(OUTPUT_EXIT);
      expect(r[stream].length).toBe(100_000);
      expect(Date.now() - started).toBeLessThan(10_000);
    }
  );

  test('kills a command that never exits and says it timed out', async () => {
    let killed = 0;
    const r = await runBounded({
      ...node('setTimeout(() => {}, 60000)'),
      maxBytes: 1000,
      timeoutMs: 300,
      onKill: async () => {
        killed++;
      },
    });
    expect(r.limit).toBe('timeout');
    expect(r.exitCode).toBe(TIMEOUT_EXIT);
    expect(killed).toBe(1);
  });

  test('does not answer until the cleanup after a kill has finished', async () => {
    let cleaned = false;
    const r = await runBounded({
      ...node('setTimeout(() => {}, 60000)'),
      maxBytes: 1000,
      timeoutMs: 200,
      onKill: () =>
        new Promise<void>((done) => {
          setTimeout(() => {
            cleaned = true;
            done();
          }, 300);
        }),
    });
    expect(r.limit).toBe('timeout');
    expect(cleaned).toBe(true);
  });

  test('stops writing a file at the cap when stdout goes to a file', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ktchn-bounded-')));
    dirs.push(dir);
    const file = join(dir, 'out.bin');
    const r = await runBounded({
      ...node(endlessOut('stdout')),
      stdoutFile: file,
      maxBytes: 200_000,
      timeoutMs: 20_000,
    });
    expect(r.limit).toBe('output');
    expect(statSync(file).size).toBe(200_000);

    const ok = join(dir, 'ok.bin');
    const fine = await runBounded({
      ...node('process.stdout.write("pack")'),
      stdoutFile: ok,
      maxBytes: 200_000,
      timeoutMs: 20_000,
    });
    expect(fine.limit).toBeUndefined();
    expect(readFileSync(ok, 'utf8')).toBe('pack');
  });

  test('a file that cannot be written stops the command and fails the run', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ktchn-bounded-')));
    dirs.push(dir);
    const started = Date.now();
    const r = await runBounded({
      ...node(endlessOut('stdout')),
      stdoutFile: join(dir, 'missing', 'out.bin'),
      maxBytes: 200_000,
      timeoutMs: 20_000,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.limit).toBeUndefined();
    expect(r.stderr).toContain('ENOENT');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test('reports a command that cannot start', async () => {
    const r = await runBounded({
      file: join(tmpdir(), 'ktchn-no-such-binary'),
      args: [],
      maxBytes: 1000,
      timeoutMs: 1000,
    });
    expect(r.exitCode).toBe(127);
    expect(r.limit).toBeUndefined();
  });
});
