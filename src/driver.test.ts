import { describe, expect, test } from 'vitest';
import { driveRun, type ReviewOutcome, type RunShell } from './driver.ts';
import { openLedger } from './ledger.ts';
import type { AgentInput, RunState } from './run-machine.ts';

const passed: ReviewOutcome = {
  event: { type: 'ReviewPassed', oid: 'abc123' },
  results: [{ command: 'pnpm test', exitCode: 0, output: 'ok' }],
};
const failed: ReviewOutcome = {
  event: { type: 'ReviewFailed', findings: 'pnpm test exited 1' },
  results: [{ command: 'pnpm test', exitCode: 1, output: 'boom' }],
};

const fakeShell = (reviews: (ReviewOutcome | 'crash')[]) => {
  const agentCalls: [AgentInput['kind'], number][] = [];
  const reports: RunState[] = [];
  let closes = 0;
  const handedOff: string[] = [];
  let discards = 0;
  const shell: RunShell = {
    runAgent: async ({ input, number }) => {
      agentCalls.push([input.kind, number]);
      return {
        event: { type: 'AgentFinished' },
        calls: [
          {
            entryId: agentCalls.length,
            model: 'm',
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cost: 0.01,
          },
        ],
      };
    },
    runReview: async () => {
      const next = reviews.shift();
      if (next === undefined || next === 'crash') throw new Error('crash');
      return next;
    },
    closeSandbox: async () => {
      closes++;
    },
    handOff: (oid) => {
      handedOff.push(oid);
    },
    discard: async () => {
      discards++;
    },
    report: (state) => reports.push(state),
  };
  return {
    shell,
    agentCalls,
    reports,
    handedOff,
    closes: () => closes,
    discards: () => discards,
  };
};

const kinds = (ledger: ReturnType<typeof openLedger>, runId: string) =>
  ledger
    .records(runId)
    .map((r) => (r.kind === 'run_event' ? r.event.type : r.kind));

describe('driveRun', () => {
  test('a run whose checks pass waits to open its PR with its evidence recorded', async () => {
    const ledger = openLedger(':memory:');
    const { shell, agentCalls, reports } = fakeShell([passed]);
    const state = await driveRun(ledger, 'run-1', shell);
    expect(state).toMatchObject({ status: 'in_review', step: 'opening_pr' });
    expect(agentCalls).toEqual([['job', 1]]);
    expect(reports).toEqual([state]);
    expect(kinds(ledger, 'run-1')).toEqual([
      'Dequeued',
      'model_call',
      'AgentFinished',
      'checks_ran',
      'ReviewPassed',
    ]);
  });

  test('a passed review hands the reviewed commit to the owner, again on every drive', async () => {
    const ledger = openLedger(':memory:');
    const first = fakeShell([passed]);
    await driveRun(ledger, 'run-1', first.shell);
    expect(first.handedOff).toEqual(['abc123']);
    expect(first.discards()).toBe(0);
    const again = fakeShell([]);
    await driveRun(ledger, 'run-1', again.shell);
    expect(again.handedOff).toEqual(['abc123']);
  });

  test('a run that reached a terminal state discards what it left, a parked one keeps it', async () => {
    const ledger = openLedger(':memory:');
    const parked = fakeShell([failed, failed, failed]);
    await driveRun(ledger, 'run-1', parked.shell);
    expect(parked.discards()).toBe(0);
    const replay = ledger.replay('run-1');
    ledger.appendEvent('run-1', replay.events, { type: 'OwnerFailed' });
    const done = fakeShell([]);
    const state = await driveRun(ledger, 'run-1', done.shell);
    expect(state.status).toBe('failed');
    expect(done.discards()).toBe(1);
  });

  test('failed checks go back to the agent as findings', async () => {
    const ledger = openLedger(':memory:');
    const { shell, agentCalls } = fakeShell([failed, passed]);
    await driveRun(ledger, 'run-1', shell);
    expect(agentCalls).toEqual([
      ['job', 1],
      ['findings', 2],
    ]);
  });

  test('checks failing every review park the run and close the sandbox', async () => {
    const ledger = openLedger(':memory:');
    const fake = fakeShell([failed, failed, failed]);
    const state = await driveRun(ledger, 'run-1', fake.shell);
    expect(state).toMatchObject({
      status: 'parked',
      reason: { kind: 'review_exhausted' },
    });
    expect(fake.closes()).toBe(1);
  });

  test('after a crash mid-review, driving again records the crash and reviews again', async () => {
    const ledger = openLedger(':memory:');
    await expect(
      driveRun(ledger, 'run-1', fakeShell(['crash']).shell)
    ).rejects.toThrow('crash');
    const state = await driveRun(ledger, 'run-1', fakeShell([passed]).shell);
    expect(state).toMatchObject({ step: 'opening_pr', crashResumed: true });
    expect(kinds(ledger, 'run-1')).toEqual([
      'Dequeued',
      'model_call',
      'AgentFinished',
      'Crashed',
      'checks_ran',
      'ReviewPassed',
    ]);
  });

  test('after a crash mid-agent, the agent resumes its same submission', async () => {
    const ledger = openLedger(':memory:');
    const dying: RunShell = {
      ...fakeShell([]).shell,
      runAgent: async () => {
        throw new Error('crash');
      },
    };
    await expect(driveRun(ledger, 'run-1', dying)).rejects.toThrow('crash');
    const fake = fakeShell([passed]);
    await driveRun(ledger, 'run-1', fake.shell);
    expect(fake.agentCalls).toEqual([['job', 1]]);
  });

  test('driving a settled run again appends nothing', async () => {
    const ledger = openLedger(':memory:');
    await driveRun(ledger, 'run-1', fakeShell([passed]).shell);
    const before = ledger.records('run-1');
    const again = fakeShell([]);
    await driveRun(ledger, 'run-1', again.shell);
    expect(ledger.records('run-1')).toEqual(before);
    expect(again.agentCalls).toEqual([]);
  });

  test('a model call seen twice is recorded once', async () => {
    const ledger = openLedger(':memory:');
    const fake = fakeShell([failed, passed]);
    const shell: RunShell = {
      ...fake.shell,
      runAgent: async (request) => ({
        ...(await fake.shell.runAgent(request)),
        calls: [
          {
            entryId: 7,
            model: 'm',
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cost: 0.01,
          },
        ],
      }),
    };
    await driveRun(ledger, 'run-1', shell);
    expect(kinds(ledger, 'run-1').filter((k) => k === 'model_call')).toEqual([
      'model_call',
    ]);
  });

  test('an event another driver already appended aborts the run with an error', async () => {
    const ledger = openLedger(':memory:');
    const fake = fakeShell([passed]);
    const shell: RunShell = {
      ...fake.shell,
      runAgent: async (request) => {
        ledger.appendEvent('run-1', 1, { type: 'OwnerParked' });
        return fake.shell.runAgent(request);
      },
    };
    await expect(driveRun(ledger, 'run-1', shell)).rejects.toThrow(
      /another driver/
    );
  });

  test('an agent that ends early parks the run and is not recorded as a crash', async () => {
    const ledger = openLedger(':memory:');
    const shell: RunShell = {
      ...fakeShell([]).shell,
      runAgent: async () => ({
        event: { type: 'AgentEndedEarly', reason: 'out of turns' },
        calls: [],
      }),
    };
    const state = await driveRun(ledger, 'run-1', shell);
    expect(state).toMatchObject({
      status: 'parked',
      reason: { kind: 'agent_ended_early', reason: 'out of turns' },
    });
    expect(kinds(ledger, 'run-1')).toEqual(['Dequeued', 'AgentEndedEarly']);
  });

  test('a process that dies mid-agent still records Crashed on the next drive', async () => {
    const ledger = openLedger(':memory:');
    const dying: RunShell = {
      ...fakeShell([]).shell,
      runAgent: async () => {
        throw new Error('killed');
      },
    };
    await expect(driveRun(ledger, 'run-1', dying)).rejects.toThrow('killed');
    await driveRun(ledger, 'run-1', fakeShell([passed]).shell);
    expect(kinds(ledger, 'run-1')).toContain('Crashed');
  });
});
