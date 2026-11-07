import { strict as assert } from 'node:assert';
import { realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';
import type { ExecResult } from './bounded.ts';
import type { ExecOptions, Sandbox } from './sandbox.ts';

export type Reply = Partial<ExecResult> & {
  // Bytes to put in `opts.stdoutFile`, as if the command had printed them.
  file?: Buffer;
};

export type Call = { command: string; opts: ExecOptions };

// A sandbox for tests that never runs anything. It records each command and
// answers from `respond`. The only thing it writes is the file a caller asked
// stdout to go to, inside the temporary directory.
export const fakeSandbox = (
  respond: (call: Call) => Reply | Promise<Reply> = () => ({})
) => {
  const calls: Call[] = [];
  const sandbox: Sandbox = {
    name: 'fake',
    env: undefined,
    exec: async (command, opts = {}) => {
      const call = { command, opts };
      calls.push(call);
      const reply = await respond(call);
      if (reply.file !== undefined) {
        assert(opts.stdoutFile !== undefined, 'a file reply needs stdoutFile');
        assert(
          opts.stdoutFile.startsWith(realpathSync(tmpdir()) + sep) ||
            opts.stdoutFile.startsWith(tmpdir() + sep),
          `fake would write outside the temporary directory: ${opts.stdoutFile}`
        );
        writeFileSync(opts.stdoutFile, reply.file);
      }
      return {
        exitCode: reply.exitCode ?? 0,
        stdout: reply.stdout ?? '',
        stderr: reply.stderr ?? '',
        ...(reply.limit === undefined ? {} : { limit: reply.limit }),
      };
    },
    close: async () => {},
  };
  return { sandbox, calls };
};
