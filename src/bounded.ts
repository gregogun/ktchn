import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

export type Limit = 'output' | 'timeout';

export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  limit?: Limit;
};

export const TIMEOUT_EXIT = 124;
export const OUTPUT_EXIT = 125;
const SETTLE_MS = 3000;

export type BoundedRun = {
  file: string;
  args: readonly string[];
  stdin?: string | number;
  stdoutFile?: string;
  maxBytes: number;
  timeoutMs: number;
  onKill?: () => Promise<void>;
};

export const runBounded = (run: BoundedRun): Promise<ExecResult> =>
  new Promise((resolve) => {
    const { stdin, stdoutFile, maxBytes } = run;
    const child = spawn(run.file, [...run.args], {
      stdio: [typeof stdin === 'number' ? stdin : 'pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let limit: Limit | undefined;
    let done = false;
    let cleanup: Promise<void> = Promise.resolve();
    const sink =
      stdoutFile === undefined ? undefined : createWriteStream(stdoutFile);
    let writeFailed = false;
    sink?.on('error', (error) => {
      writeFailed = true;
      err.push(
        Buffer.from(`ktchn could not write the output: ${String(error)}`)
      );
      child.kill('SIGKILL');
    });

    const trip = (which: Limit) => {
      if (limit !== undefined) return;
      limit = which;
      child.kill('SIGKILL');
      cleanup = run.onKill?.() ?? cleanup;
      setTimeout(() => finish(null), SETTLE_MS).unref();
    };
    const timer = setTimeout(() => trip('timeout'), run.timeoutMs);

    const keep = (into: Buffer[], chunk: Buffer, used: () => number) => {
      const room = maxBytes - used();
      if (room > 0) into.push(chunk.subarray(0, room));
      if (chunk.length > room) trip('output');
    };
    const size = (parts: Buffer[]) => parts.reduce((n, p) => n + p.length, 0);
    let written = 0;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (sink === undefined) return keep(out, chunk, () => size(out));
      const room = maxBytes - written;
      if (room > 0) {
        const part = chunk.subarray(0, room);
        written += part.length;
        if (!sink.write(part)) {
          child.stdout?.pause();
          sink.once('drain', () => child.stdout?.resume());
        }
      }
      if (chunk.length > room) trip('output');
    });
    child.stderr?.on('data', (chunk: Buffer) =>
      keep(err, chunk, () => size(err))
    );
    child.stdin?.on('error', () => {});
    child.on('error', (error) => {
      err.push(Buffer.from(String(error)));
      finish(127);
    });
    child.on('close', (code) => finish(code));
    if (typeof stdin !== 'number') child.stdin?.end(stdin);

    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const result = (): ExecResult => ({
        exitCode:
          limit === 'timeout'
            ? TIMEOUT_EXIT
            : limit === 'output'
              ? OUTPUT_EXIT
              : writeFailed
                ? 1
                : (code ?? 1),
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        ...(limit === undefined ? {} : { limit }),
      });
      const settle = () => cleanup.then(() => resolve(result()));
      if (sink === undefined || writeFailed) void settle();
      else sink.end(() => void settle());
    };
  });
