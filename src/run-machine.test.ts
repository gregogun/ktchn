import { describe, expect, test } from 'vitest';
import * as runMachine from './run-machine.ts';
import type { RunEvent, RunState } from './run-machine.ts';

type Of<S extends RunState['status']> = Extract<RunState, { status: S }>;

const queued = (s: Partial<Of<'queued'>> = {}): Of<'queued'> => ({
  status: 'queued',
  input: { kind: 'job' },
  reviewsLeft: 3,
  crashResumed: false,
  ...s,
});

const running = (s: Partial<Of<'running'>> = {}): Of<'running'> => ({
  status: 'running',
  reviewsLeft: 3,
  crashResumed: false,
  parkRequested: false,
  ...s,
});

const inReview = (s: Partial<Of<'in_review'>> = {}): Of<'in_review'> => ({
  status: 'in_review',
  step: 'reviewing',
  reviewsLeft: 3,
  crashResumed: false,
  ...s,
});

const parked = (s: Partial<Of<'parked'>> = {}): Of<'parked'> => ({
  status: 'parked',
  reason: { kind: 'agent_question', question: 'Which config file?' },
  reviewsLeft: 3,
  crashResumed: false,
  ...s,
});

const effectTypes = (state: RunState, event: RunEvent) =>
  runMachine.transition(state, event).effects.map((e) => e.type);

const PARK_EFFECTS = ['KillSandbox', 'SendReport', 'ScheduleReminder'];

describe('starting', () => {
  test('a dequeued run starts its agent on the job', () => {
    const { state, effects } = runMachine.transition(queued(), {
      type: 'Dequeued',
    });
    expect(state.status).toBe('running');
    expect(effects).toEqual([{ type: 'RunAgent', input: { kind: 'job' } }]);
  });

  test('a dequeued resumed run hands the agent the owner answer', () => {
    const { effects } = runMachine.transition(
      queued({ input: { kind: 'answer', answer: 'use .env.local' } }),
      {
        type: 'Dequeued',
      }
    );
    expect(effects).toEqual([
      { type: 'RunAgent', input: { kind: 'answer', answer: 'use .env.local' } },
    ]);
  });
});

describe('review', () => {
  test('finished work goes to review', () => {
    const { state, effects } = runMachine.transition(running(), {
      type: 'AgentFinished',
    });
    expect(state).toMatchObject({ status: 'in_review', step: 'reviewing' });
    expect(effects.map((e) => e.type)).toEqual(['RunReview']);
  });

  test('a passed review opens the PR but is not done yet', () => {
    const { state, effects } = runMachine.transition(inReview(), {
      type: 'ReviewPassed',
    });
    expect(state).toMatchObject({ status: 'in_review', step: 'opening_pr' });
    expect(effects.map((e) => e.type)).toEqual(['OpenPr']);
  });

  test('done means review passed and the PR is open', () => {
    const pr = 'https://github.com/gregogun/ktchn/pull/1';
    const { state, effects } = runMachine.transition(
      inReview({ step: 'opening_pr' }),
      {
        type: 'PrOpened',
        pr,
      }
    );
    expect(state).toEqual({ status: 'done', pr });
    expect(effects.map((e) => e.type)).toEqual(['KillSandbox', 'SendReport']);
  });

  test('a PR cannot open on a review that has not passed', () => {
    const before = inReview({ step: 'reviewing' });
    const { state, effects } = runMachine.transition(before, {
      type: 'PrOpened',
      pr: 'https://x',
    });
    expect(state).toEqual(before);
    expect(effects).toEqual([]);
  });

  test('failed review sends findings back to the agent and uses up a review', () => {
    const { state, effects } = runMachine.transition(
      inReview({ reviewsLeft: 3 }),
      {
        type: 'ReviewFailed',
        findings: 'typecheck fails',
      }
    );
    expect(state).toMatchObject({ status: 'running', reviewsLeft: 2 });
    expect(effects).toEqual([
      {
        type: 'RunAgent',
        input: { kind: 'findings', findings: 'typecheck fails' },
      },
    ]);
  });

  test('the third failed review parks the run with the evidence', () => {
    const { state } = runMachine.transition(inReview({ reviewsLeft: 1 }), {
      type: 'ReviewFailed',
      findings: 'still failing',
    });
    expect(state).toMatchObject({
      status: 'parked',
      reason: { kind: 'review_exhausted', findings: 'still failing' },
    });
    expect(
      effectTypes(inReview({ reviewsLeft: 1 }), {
        type: 'ReviewFailed',
        findings: 'x',
      })
    ).toEqual(PARK_EFFECTS);
  });

  test('resuming after exhausted review gives a fresh set of reviews', () => {
    const { state } = runMachine.transition(
      parked({
        reason: { kind: 'review_exhausted', findings: 'x' },
        reviewsLeft: 1,
      }),
      {
        type: 'OwnerResumed',
        answer: 'skip the flaky e2e test',
      }
    );
    expect(state).toMatchObject({ status: 'queued', reviewsLeft: 3 });
  });

  test.each([
    { type: 'ReviewPassed' },
    { type: 'ReviewFailed', findings: 'late' },
  ] as const)('a passed review ignores a later $type', (event) => {
    const before = inReview({ step: 'opening_pr' });
    expect(runMachine.transition(before, event)).toEqual({
      state: before,
      effects: [],
    });
  });
});

describe('parking', () => {
  test.each([
    [
      { type: 'AgentAsked', question: 'Which DB?' },
      { kind: 'agent_question', question: 'Which DB?' },
    ],
    [
      { type: 'CheckpointReached', question: 'Plan ok?' },
      { kind: 'checkpoint', question: 'Plan ok?' },
    ],
    [{ type: 'BudgetExhausted' }, { kind: 'budget_exhausted' }],
  ] as const)('%o parks a running run as %o', (event, reason) => {
    const { state, effects } = runMachine.transition(running(), event);
    expect(state).toMatchObject({ status: 'parked', reason });
    expect(effects.map((e) => e.type)).toEqual(PARK_EFFECTS);
  });

  test('owner park lets the agent finish its current turn first', () => {
    const { state, effects } = runMachine.transition(running(), {
      type: 'OwnerParked',
    });
    expect(state).toMatchObject({ status: 'running', parkRequested: true });
    expect(effects.map((e) => e.type)).toEqual(['StopAfterTurn']);
  });

  test('the agent stopping after an owner park parks the run', () => {
    const { state, effects } = runMachine.transition(
      running({ parkRequested: true }),
      {
        type: 'AgentStopped',
      }
    );
    expect(state).toMatchObject({
      status: 'parked',
      reason: { kind: 'owner_parked' },
    });
    expect(effects.map((e) => e.type)).toEqual(PARK_EFFECTS);
  });

  test('an owner answer resumes the run at the front of the queue', () => {
    const { state, effects } = runMachine.transition(
      parked({ reviewsLeft: 2 }),
      {
        type: 'OwnerResumed',
        answer: 'Postgres',
      }
    );
    expect(state).toEqual(
      queued({ input: { kind: 'answer', answer: 'Postgres' }, reviewsLeft: 2 })
    );
    expect(effects).toEqual([{ type: 'Enqueue', position: 'front' }]);
  });

  test('raising the budget resumes a budget-parked run', () => {
    const { state, effects } = runMachine.transition(
      parked({ reason: { kind: 'budget_exhausted' } }),
      {
        type: 'OwnerRaisedBudget',
        budget: 20,
      }
    );
    expect(state).toEqual(queued({ input: { kind: 'resume' } }));
    expect(effects).toEqual([
      { type: 'SetBudget', budget: 20 },
      { type: 'Enqueue', position: 'front' },
    ]);
  });

  test('raising the budget does not resume a run parked for another reason', () => {
    const before = parked();
    expect(
      runMachine.transition(before, { type: 'OwnerRaisedBudget', budget: 20 })
    ).toEqual({ state: before, effects: [] });
  });

  test('an answer does not resume a budget-parked run', () => {
    const before = parked({ reason: { kind: 'budget_exhausted' } });
    expect(
      runMachine.transition(before, { type: 'OwnerResumed', answer: 'go on' })
    ).toEqual({ state: before, effects: [] });
  });

  test('a parked run gets a reminder when it falls due', () => {
    expect(effectTypes(parked(), { type: 'ReminderDue' })).toEqual([
      'SendReminder',
    ]);
  });

  test('the owner can fail a parked run', () => {
    const { state, effects } = runMachine.transition(parked(), {
      type: 'OwnerFailed',
    });
    expect(state).toEqual({ status: 'failed' });
    expect(effects.map((e) => e.type)).toEqual(['SendReport']);
  });
});

describe('crashes', () => {
  test('the first crash resumes once from the saved session', () => {
    const { state, effects } = runMachine.transition(running(), {
      type: 'Crashed',
    });
    expect(state).toMatchObject({
      status: 'queued',
      input: { kind: 'resume' },
      crashResumed: true,
    });
    expect(effects).toEqual([{ type: 'Enqueue', position: 'front' }]);
  });

  test('a second crash parks the run', () => {
    const { state, effects } = runMachine.transition(
      running({ crashResumed: true }),
      {
        type: 'Crashed',
      }
    );
    expect(state).toMatchObject({
      status: 'parked',
      reason: { kind: 'second_crash' },
    });
    expect(effects.map((e) => e.type)).toEqual(PARK_EFFECTS);
  });

  test('a crash with an owner park pending parks the run', () => {
    const { state, effects } = runMachine.transition(
      running({ parkRequested: true }),
      { type: 'Crashed' }
    );
    expect(state).toMatchObject({
      status: 'parked',
      reason: { kind: 'owner_parked' },
    });
    expect(effects.map((e) => e.type)).toEqual(PARK_EFFECTS);
  });

  test.each(['reviewing', 'opening_pr'] as const)(
    'a crash while %s starts review over',
    (step) => {
      const { state, effects } = runMachine.transition(
        inReview({ step, reviewsLeft: 2 }),
        { type: 'Crashed' }
      );
      expect(state).toEqual(
        inReview({ step: 'reviewing', reviewsLeft: 2, crashResumed: true })
      );
      expect(effects).toEqual([{ type: 'RunReview' }]);
    }
  );

  test('a second crash during review parks the run', () => {
    const { state, effects } = runMachine.transition(
      inReview({ crashResumed: true }),
      { type: 'Crashed' }
    );
    expect(state).toMatchObject({
      status: 'parked',
      reason: { kind: 'second_crash' },
    });
    expect(effects.map((e) => e.type)).toEqual(PARK_EFFECTS);
  });
});

describe('cancelling', () => {
  test.each([queued(), running(), inReview(), parked()])(
    'a $status run can be cancelled',
    (before) => {
      const { state, effects } = runMachine.transition(before, {
        type: 'OwnerCancelled',
      });
      expect(state).toEqual({ status: 'cancelled' });
      expect(effects.map((e) => e.type)).toEqual(['KillSandbox', 'SendReport']);
    }
  );
});

describe('ended runs', () => {
  test.each<RunState>([
    { status: 'done', pr: 'https://x' },
    { status: 'failed' },
    { status: 'cancelled' },
  ])('a $status run ignores late events', (before) => {
    for (const event of [
      { type: 'Crashed' },
      { type: 'AgentFinished' },
      { type: 'OwnerCancelled' },
    ] as const) {
      expect(runMachine.transition(before, event)).toEqual({
        state: before,
        effects: [],
      });
    }
  });
});
