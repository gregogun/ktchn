# Decisions are pure; the ledger is the event log

Every decision ktchn makes (run state changes, choosing a workflow, policy) is a pure function from current state and an event to a new state and a list of effects. The effects are data, and a thin shell carries them out and turns their results back into events. The ledger stores those events, append-only, in SQLite, and current state is the events replayed. The core can then be tested without Docker, Telegram or a model, and what happened in any run can be inspected after the fact. That inspectability is the trust ktchn was started for.
