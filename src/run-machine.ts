type ReviewsLeft = 1 | 2 | 3;

export type AgentInput =
  | { kind: 'job' }
  | { kind: 'answer'; answer: string }
  | { kind: 'findings'; findings: string }
  | { kind: 'resume' };

type Queued = {
  status: 'queued';
  input: AgentInput;
  reviewsLeft: ReviewsLeft;
  crashResumed: boolean;
};

type Running = {
  status: 'running';
  reviewsLeft: ReviewsLeft;
  crashResumed: boolean;
  parkRequested: boolean;
};

type ParkReason =
  | { kind: 'agent_question'; question: string }
  | { kind: 'checkpoint'; question: string }
  | { kind: 'agent_ended_early'; reason: string }
  | { kind: 'review_exhausted'; findings: string }
  | { kind: 'budget_exhausted' }
  | { kind: 'second_crash' }
  | { kind: 'owner_parked' };

type Parked = {
  status: 'parked';
  reason: ParkReason;
  reviewsLeft: ReviewsLeft;
  crashResumed: boolean;
};

type Failed = {
  status: 'failed';
};
type Cancelled = {
  status: 'cancelled';
};

type ReviewStep = 'reviewing' | 'opening_pr';

type InReview = {
  status: 'in_review';
  step: ReviewStep;
  reviewsLeft: ReviewsLeft;
  crashResumed: boolean;
};

type Done = { status: 'done'; pr: string };

export type RunState =
  Queued | Running | Parked | Failed | Cancelled | InReview | Done;

export type RunEvent =
  | { type: 'Dequeued' }
  | { type: 'PrOpened'; pr: string }
  | { type: 'ReviewPassed'; oid: string }
  | { type: 'ReviewFailed'; findings: string }
  | { type: 'OwnerResumed'; answer: string }
  | { type: 'OwnerParked' }
  | { type: 'OwnerFailed' }
  | { type: 'OwnerCancelled' }
  | { type: 'OwnerRaisedBudget'; budget: number }
  | { type: 'AgentFinished' }
  | { type: 'AgentStopped' }
  | { type: 'AgentEndedEarly'; reason: string }
  | { type: 'AgentAsked'; question: string }
  | { type: 'CheckpointReached'; question: string }
  | { type: 'Crashed' }
  | { type: 'BudgetExhausted' }
  | { type: 'ReminderDue' };

export type Effect =
  | { type: 'RunAgent'; input: AgentInput }
  | { type: 'RunReview' }
  | { type: 'OpenPr'; oid: string }
  | { type: 'KillSandbox' }
  | { type: 'SendReport' }
  | { type: 'ScheduleReminder' }
  | { type: 'StopAfterRound' }
  | { type: 'SendReminder' }
  | { type: 'SetBudget'; budget: number }
  | { type: 'Enqueue'; position: 'front' | 'back' };

const PARK_EFFECTS: readonly Effect[] = [
  { type: 'KillSandbox' },
  { type: 'SendReport' },
  { type: 'ScheduleReminder' },
];

const park = (
  state: Running | InReview,
  reason: ParkReason
): { state: RunState; effects: readonly Effect[] } => ({
  state: {
    status: 'parked',
    reason,
    reviewsLeft: state.reviewsLeft,
    crashResumed: state.crashResumed,
  },
  effects: PARK_EFFECTS,
});

const fewer = { 3: 2, 2: 1 } as const;

const REVIEWS_PER_RUN = 3;

const TERMINAL = ['done', 'failed', 'cancelled'];

export const isTerminal = (state: RunState) => TERMINAL.includes(state.status);

const newRun: RunState = {
  status: 'queued',
  input: { kind: 'job' },
  reviewsLeft: REVIEWS_PER_RUN,
  crashResumed: false,
};

export const transition = (
  state: RunState,
  event: RunEvent
): { state: RunState; effects: readonly Effect[] } => {
  if (event.type === 'OwnerCancelled' && !isTerminal(state)) {
    return {
      state: { status: 'cancelled' },
      effects: [{ type: 'KillSandbox' }, { type: 'SendReport' }],
    };
  }

  switch (state.status) {
    case 'queued':
      switch (event.type) {
        case 'Dequeued':
          return {
            state: {
              status: 'running',
              reviewsLeft: state.reviewsLeft,
              crashResumed: state.crashResumed,
              parkRequested: false,
            },
            effects: [{ type: 'RunAgent', input: state.input }],
          };
      }
      return { state, effects: [] };
    case 'running':
      switch (event.type) {
        case 'AgentFinished':
          return {
            state: {
              status: 'in_review',
              step: 'reviewing',
              reviewsLeft: state.reviewsLeft,
              crashResumed: state.crashResumed,
            },
            effects: [{ type: 'RunReview' }],
          };
        case 'AgentEndedEarly':
          return park(state, {
            kind: 'agent_ended_early',
            reason: event.reason,
          });
        case 'AgentAsked':
          return park(state, {
            kind: 'agent_question',
            question: event.question,
          });
        case 'CheckpointReached':
          return park(state, { kind: 'checkpoint', question: event.question });
        case 'BudgetExhausted':
          return park(state, { kind: 'budget_exhausted' });
        case 'OwnerParked':
          return {
            state: {
              ...state,
              parkRequested: true,
            },
            effects: [{ type: 'StopAfterRound' }],
          };
        case 'AgentStopped':
          if (!state.parkRequested) break;
          return park(state, { kind: 'owner_parked' });
        case 'Crashed':
          if (state.parkRequested) {
            return park(state, { kind: 'owner_parked' });
          }
          if (!state.crashResumed) {
            return {
              state: {
                status: 'queued',
                input: {
                  kind: 'resume',
                },
                crashResumed: true,
                reviewsLeft: state.reviewsLeft,
              },
              effects: [{ type: 'Enqueue', position: 'front' }],
            };
          }
          return park(state, { kind: 'second_crash' });
      }
      return { state, effects: [] };
    case 'parked':
      switch (event.type) {
        case 'OwnerRaisedBudget':
          if (state.reason.kind !== 'budget_exhausted') break;
          return {
            state: {
              status: 'queued',
              input: { kind: 'resume' },
              crashResumed: state.crashResumed,
              reviewsLeft: state.reviewsLeft,
            },
            effects: [
              { type: 'SetBudget', budget: event.budget },
              { type: 'Enqueue', position: 'front' },
            ],
          };
        case 'OwnerResumed':
          if (state.reason.kind === 'budget_exhausted') break;
          return {
            state: {
              status: 'queued',
              input: { kind: 'answer', answer: event.answer },
              crashResumed: state.crashResumed,
              reviewsLeft:
                state.reason.kind === 'review_exhausted'
                  ? REVIEWS_PER_RUN
                  : state.reviewsLeft,
            },
            effects: [{ type: 'Enqueue', position: 'front' }],
          };
        case 'OwnerFailed':
          return {
            state: {
              status: 'failed',
            },
            effects: [{ type: 'SendReport' }],
          };
        case 'ReminderDue':
          return {
            state,
            effects: [{ type: 'SendReminder' }],
          };
      }
      return { state, effects: [] };
    case 'in_review':
      switch (event.type) {
        case 'ReviewPassed':
          if (state.step !== 'reviewing') break;
          return {
            state: {
              ...state,
              step: 'opening_pr',
            },
            effects: [{ type: 'OpenPr', oid: event.oid }],
          };
        case 'PrOpened':
          if (state.step !== 'opening_pr') break;
          return {
            state: {
              status: 'done',
              pr: event.pr,
            },
            effects: [{ type: 'KillSandbox' }, { type: 'SendReport' }],
          };
        case 'Crashed':
          if (state.crashResumed) {
            return park(state, { kind: 'second_crash' });
          }
          return {
            state: { ...state, step: 'reviewing', crashResumed: true },
            effects: [{ type: 'RunReview' }],
          };
        case 'ReviewFailed':
          if (state.step !== 'reviewing') break;
          if (state.reviewsLeft === 1) {
            return park(state, {
              kind: 'review_exhausted',
              findings: event.findings,
            });
          }
          return {
            state: {
              status: 'running',
              reviewsLeft: fewer[state.reviewsLeft],
              parkRequested: false,
              crashResumed: state.crashResumed,
            },
            effects: [
              {
                type: 'RunAgent',
                input: { kind: 'findings', findings: event.findings },
              },
            ],
          };
      }
      return { state, effects: [] };
  }

  return {
    state,
    effects: [],
  };
};

export type FreshAgentInput = Exclude<AgentInput, { kind: 'resume' }>;

export type AgentRequest = { input: FreshAgentInput; number: number };

type Replay = {
  state: RunState;
  effects: readonly Effect[];
  events: number;
  agentRequest: AgentRequest | undefined;
};

export const replay = (events: readonly RunEvent[]): Replay => {
  let state: RunState = newRun;
  let effects: readonly Effect[] = [];
  let agentRequest: AgentRequest | undefined;
  for (const event of events) {
    ({ state, effects } = transition(state, event));
    for (const effect of effects) {
      if (effect.type === 'RunAgent' && effect.input.kind !== 'resume') {
        agentRequest = {
          input: effect.input,
          number: (agentRequest?.number ?? 0) + 1,
        };
      }
    }
  }
  return { state, effects, events: events.length, agentRequest };
};
