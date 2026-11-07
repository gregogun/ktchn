import { withCancel } from '@earendil-works/chord/context';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { EXEC_TIMEOUT_MS, MAX_OUTPUT_BYTES } from './sandbox.ts';

type AgentLimits = {
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxOutputBytes: number;
};

export const AGENT_LIMITS: AgentLimits = {
  defaultTimeoutMs: EXEC_TIMEOUT_MS,
  maxTimeoutMs: 30 * 60_000,
  maxOutputBytes: MAX_OUTPUT_BYTES,
};

export const boundAgentEnv = (
  env: ExecutionEnv,
  limits: AgentLimits = AGENT_LIMITS
): ExecutionEnv =>
  new Proxy(env, {
    get: (target, key) => {
      if (key !== 'exec') {
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      const exec: ExecutionEnv['exec'] = async (command, options, context) => {
        const maxSeconds = limits.maxTimeoutMs / 1000;
        const asked = options?.timeout;
        const seconds = Math.min(
          asked ?? limits.defaultTimeoutMs / 1000,
          maxSeconds
        );
        const { context: bounded, cancel } = withCancel(context);
        const say = (text: string) =>
          options?.onOutput?.(`\n[ktchn: ${text}]\n`, context, {
            stream: 'stderr',
          });
        let produced = 0;
        let overLimit = false;
        const { window: _window, spill: _spill, ...rest } = options ?? {};
        const result = await target.exec(
          command,
          {
            ...rest,
            timeout: seconds,
            onOutput: (text, textContext, info) => {
              if (overLimit) return;
              produced += Buffer.byteLength(text) + (info.skipped?.bytes ?? 0);
              if (produced > limits.maxOutputBytes) {
                overLimit = true;
                cancel();
                return;
              }
              options?.onOutput?.(text, textContext, info);
            },
          },
          bounded
        );
        if (asked !== undefined && asked > maxSeconds) {
          say(
            `the timeout of ${asked}s is above the ceiling, so ${maxSeconds}s applies`
          );
        }
        if (overLimit) {
          say(
            `the command printed more than ${limits.maxOutputBytes} bytes, so ${result.ok ? 'the rest of its output was dropped' : 'it was killed'}`
          );
        } else if (!result.ok && result.error.code === 'timeout') {
          say(`the command ran longer than ${seconds}s and was killed`);
        }
        return result;
      };
      return exec;
    },
  });
