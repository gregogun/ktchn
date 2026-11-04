# What the background-agents course brings to ktchn

Source studied: the "Build AI Agents that Never Sleep" workshop at `/Users/gregogun/webdev/fem/background-agents`, branch `lesson-1`.
The lesson folder `lessons/01-goal-and-harness` holds only `index.md`. The code is at the repo root.
Later lessons are known only from their notes, not their code.

## Short answer

- The course mostly confirms ktchn's design. Its deterministic done-test matches review and evidence. Its rule that an alert is a trigger, not proof, matches the reviewer working without the agent's context. Its durable steps match ADR 0008. Its decision limit matches the budget and `reviewsLeft`.
- Five ideas are worth bringing in. They are listed below, most concrete first.
- Tools: zod yes, Drizzle maybe, the Vercel AI SDK optional, Inngest not yet (ADR 0010).
- Small harnesses for the roles that only decide are a future idea. They need a glossary term before they need code.

## What the course builds

Lesson 1 is an incident agent with a loop that observes, decides and acts, capped at 8 rounds (`server/agent-workflow.ts`).
The model proposes one structured action, validated by zod (`server/agent-brain.ts`).
The code around the model owns the list of allowed actions, the policy for each action (`server/tool-policy.ts`) and the test for done.
The goal is a sentence plus a fixed condition, such as `{ path: 'health.status', equals: 'healthy' }` (`server/environment.ts`).
The model may say `complete`, but the run completes only when the condition holds on a fresh read of the world.

Course roadmap: durable steps (02), real waiting on events (03), human approval with expiry (04), safe retries and idempotency (05), escalation and handoff (06), and a capstone that judges how the work was done as well as the outcome.

## Ideas to bring in

### 1. An id on every effect, and check before acting

The course gives every effect an id (`runId:uuid`) and a version precondition. The service on the other end replays the stored outcome for an id it has already seen. Lesson 5 drills this with a service that commits and then returns 503.

ktchn's shell has the same gap. If `OpenPr` succeeds but the process dies before `PrOpened` is recorded, replay could open a second PR. `SendReport` has the same problem. The fix is an id per effect in the ledger, plus a check before acting, such as looking for an existing PR on the run's branch.

Not yet confirmed against `src/run-machine.ts`. The first step is a test that crashes while the PR is being opened.

### 2. Stale check on resume

In lesson 4, approvals expire and are re-checked against fresh state before anything acts on them.

A parked run can wait hours, and the project's main branch may move in that time. Record the base commit when a run parks. On resume, compare it, then rebase or ask the owner again if it moved.

### 3. Review how the work was done, not only the result

The capstone fails runs that ended healthy but used actions they weren't allowed to.

The reviewer could judge the diff against the run's policy as well as the checks. One example is a run that edits core modules its workflow doesn't allow.

### 4. Dedupe at intake

The course drops repeated incoming events by a stable event id and joins later events to the run already open for them.

For ktchn, that means one job per ticket, and duplicate GitHub webhooks are ignored.

### 5. Same-sandbox check after a crash resume

The course aborts if the service's instance id has changed mid-run.

After a crash resume, ktchn should check that the sandbox and worktree are the ones the run started with.

## One idea that clashes

The course checks each action against a policy as the agent takes it. ADR 0004 chose containment over interception for agents. ktchn's equivalent of the course's action list is its list of effects. Authority stays there, and ktchn doesn't add a check for each tool call.

## Tools

| Tool          | Verdict  | Why, and when to reconsider                                                                                                                                                                                                |
| ------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| zod           | Yes      | Validate ledger events on replay, GitHub webhook payloads, the agent's event stream and the reviewer's verdict.                                                                                                            |
| Drizzle       | Maybe    | Typed SQLite access for the ledger. Consider it when the ledger's schema grows past one events table, or when hand-written SQL starts to repeat.                                                                           |
| Vercel AI SDK | Optional | Its main gain is switching between providers, which ADR 0003 says not to pay for in advance. The Anthropic SDK pointed at the proxy (ADR 0005) does the same job. Consider it if the model table gains non-Anthropic rows. |
| Inngest       | Not yet  | See ADR 0010. Reconsider if the shell starts rebuilding retries, timers and concurrency badly. Even then it would only carry out effects.                                                                                  |

## Future idea: small harnesses for the roles that only decide

The course's harness is about 50 lines: one structured model call, a fixed list of allowed actions, and code that checks every proposal. That shape fits ktchn's roles that decide but don't touch code:

- **Classification:** one structured call returning the workflow, the model table row and the reason, with no tools. The reason goes in the ledger (ADR 0009).
- **Chief of staff:** the model proposes typed kitchen actions such as handing over a job, cancelling a run, resuming a run or raising a budget. The core's `transition` already checks every event, so a proposal is just another input.
- **Reviewer:** read-only access to the diff and the evidence from checks, returning a typed verdict with findings.
- **Report writing:** one call that writes a report able to stand alone.

This doesn't clash with ADR 0004. Containment is for the agent, which runs arbitrary code in the sandbox. These roles act only through actions ktchn defines, so checking each proposal is cheap and right. It also extends ADR 0006: every choice becomes visible and recorded.

A small harness earns its place when all three hold:

1. The role's actions are few and owned by ktchn.
2. Each of its decisions should be in the ledger.
3. A cheap row of the model table can do it.

A role that needs a shell or edits files is an agent in a sandbox, not a small harness.

Under ADR 0003, build classification's harness concretely first. Pull out a shared shape only if the reviewer's turns out the same.

### Open question: the word "harness"

"Harness" isn't in the glossary. ADR 0003 uses "agent harness" for pi. The glossary defines the agent as the model doing a run's work inside the sandbox, so the reviewer and the chief of staff aren't agents. If small harnesses become a real concept, they need a glossary term that doesn't collide with the agent harness. Settle the term before writing the first one.
