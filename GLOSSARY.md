# ktchn

ktchn is a software kitchen: one system where the owner hands over jobs and agents carry them out, with every result reviewed before it counts as done.

## Language

### People and roles

**Owner**:
The human who runs the kitchen, hands over jobs and answers parked runs.
_Avoid_: user, operator, chef

**Agent**:
The model that does a run's work inside the sandbox.
_Avoid_: cook, worker, bot

**Chief of staff**:
The conversational role that talks with the owner and turns what they say into kitchen actions. It never touches code.
_Avoid_: front of house, chatbot, assistant, dispatcher

**Reviewer**:
The role in review that judges a run's work against what was asked, without the agent's context.
_Avoid_: critic, judge, QA

### How work is done

**Job**:
A piece of work the owner has handed to the kitchen. It may come from a ticket, a message or the schedule.
_Avoid_: order, task

**Run**:
One attempt at a job, from start until it is done or failed, including any time spent parked.
_Avoid_: execution, session

**Failed run**:
A run that ended because its work couldn't be carried through, such as when it couldn't pass review.
_Avoid_: errored run, broken run

**Cancelled run**:
A run the owner stopped, whatever state it was in and however it was going.
_Avoid_: aborted run, killed run, stopped run

**Dropped job**:
A job the owner has given up on, so it gets no more runs.
_Avoid_: cancelled job, closed job, abandoned job

**Ticket**:
An item in the tracker describing work someone wants. It becomes a job only when the owner hands it over.
_Avoid_: issue, task

**Project**:
A codebase the kitchen works on, with its own setup and checks.
_Avoid_: repo, codebase, workspace

**Clone**:
A run's trusted copy of a project, kept by the kitchen and never handed to the agent. Work comes into it only as a commit that has been checked, and whatever happens to it never changes the project.
_Avoid_: checkout, fork, copy, workspace

**Handoff**:
Giving the owner the one commit review passed, as a branch in the project. It is the only thing a run ever puts in the project.
_Avoid_: push, merge, publish, delivery

**Sandbox**:
The isolation boundary a run's agent works inside. It holds its own copy of the project, and the kitchen takes the agent's work out of it as a commit, never by reading its files.
_Avoid_: container, box, station, workspace

**Round**:
One stretch of the agent's work within a run, from being given the job or the reviewer's findings until it stops and its work goes to review.
_Avoid_: turn, iteration, pass, attempt

**Workflow**:
How to do one kind of work, and what done looks like for it.
_Avoid_: playbook, procedure, pipeline

**Classification**:
Deciding which workflow a job follows and which model runs it. The workflow comes from the job's labels first, then by inference from its content, and otherwise the general workflow or a question to the owner. The model is a judgement of the job's size, made from the model table.
_Avoid_: routing, triage

**Model table**:
The kitchen's list of models by role, each with its effort and when to use it. Classification picks an agent's model from it.
_Avoid_: model config, model roles, model list

**General workflow**:
The catch-all workflow for a job classification couldn't place. It always runs supervised.
_Avoid_: default workflow, fallback

**Skill**:
A piece of instruction text a workflow brings into an agent's context.
_Avoid_: prompt, tool

**Skill catalogue**:
The collection of skills the kitchen draws from. It lives outside the kitchen.
_Avoid_: skill stack, skill library

### Quality

**Review**:
The stage every run goes through before it can be done, where checks run and the reviewer judges the work.
_Avoid_: the pass, verification, QA gate

**Check**:
A deterministic test of a run's result, run during review, such as the test suite or the typecheck.
_Avoid_: gate, validation

**Evidence**:
The results of checks and the reviewer's judgement, attached to a run. A run without evidence cannot be done.
_Avoid_: proof, artifacts

### Trust and control

**Autonomous**:
A run that makes reversible assumptions and keeps going, parking only when it cannot proceed at all.
_Avoid_: AFK, unattended

**Supervised**:
A run that parks at judgement calls and at its workflow's checkpoints, so the owner decides.
_Avoid_: babysit, attended

**Checkpoint**:
A point a workflow declares where a supervised run always parks.
_Avoid_: gate, approval step

**Park**:
To stop a run so it waits on the owner, keeping everything needed to carry on.
_Avoid_: pause, block, suspend

**Resume**:
To carry on a parked run once the owner has answered.
_Avoid_: restart, retry, continue

**Policy**:
The rules for what a run may do and reach. Today it is whether the run's sandbox has a network; the agent's has none unless the job asks for it, and review's never has one.
_Avoid_: permissions, rules

**Budget**:
The most a run may spend on models before it is stopped.
_Avoid_: limit, quota

### Reaching the owner

**Channel**:
A way the kitchen and the owner reach each other: reports go out through it and answers to parked runs come back.
_Avoid_: adapter, integration, messenger

### Record

**Ledger**:
The append-only record of what the kitchen decided and what happened to each job. Agent transcripts are not part of it.
_Avoid_: log, history, audit trail, trace

**Report**:
The message the owner receives when a run ends or parks, written to stand alone with no other context.
_Avoid_: update, notification, summary
