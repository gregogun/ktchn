# Could ktchn be built by composing pi, pi-durable, Sandcastle and gstack?

Question: can the first version in gregogun/ktchn#1 be reached by composing existing tools instead of building ktchn, and where does pi-durable change the plan?

Sources studied:

- pi-durable: `@earendil-works/pi-durable` 1.4.0, `packages/durable` in `https://github.com/earendil-works/pi` at commit `b556cfe` (2026-11-01). Its sibling `packages/env` (`@earendil-works/pi-env` 1.4.0) and `packages/coding-agent/package.json` from the same commit. Shorthand: `DUR/` and `ENV/` mean those package directories.
- Sandcastle 0.12.0 at `/Users/gregogun/webdev/ai/sandcastle`. Shorthand: `SC/`.
- gstack at `/Users/gregogun/webdev/projects/gstack`, commit `54b082e`.
- The earlier notes [issue-2-pi.md](issue-2-pi.md) and [issue-3-sandcastle.md](issue-3-sandcastle.md), and ADRs 0001–0009.

Method: read the README, examples and source. Nothing was run. Claims that rest on inference are labeled.

## Short answer

- **ktchn holds up.** No tool covers intake, classification, review as a gate that has to pass, the ledger, park through Telegram, or pushing only after review. Those are the core the owner hand-writes.
- **Composition can replace much of the adapter layer.** The strongest composition (a Telegram bot driving a pi-durable Harness, tools running in a Sandcastle sandbox, gstack text as prompt sections) still needs classification, the run state machine and the ledger. Once those are added, it is ktchn.
- **pi-durable undercuts the premise of ADR 0004.** It runs the model loop in the host process and sends every tool call through an `ExecutionEnv` that can point into a sandbox. ktchn would get containment and interception together, and the model proxy from ADR 0005 would mostly not be needed. Whether to switch harness should be settled before the harness and proxy adapters are built.
- **The pi CLI and pi-durable are separate harnesses.** `@earendil-works/pi-coding-agent` depends on `pi-agent-core`, `pi-ai`, `pi-codemode`, `pi-mcp` and `pi-tui`, not on `pi-durable` (`coding-agent/package.json:44-48`). Nothing in issue-2-pi.md carries over to pi-durable.
- **Egress is unsolved in every composition.**

## 1. What pi-durable is

`DUR/README.md:3`: "**Experimental.** The API changes without notice between releases." The `Unreleased` section of `DUR/CHANGELOG.md` is mostly breaking changes (storage commit contract, watches, removal of `watchEvents()`).

It is a library, not a CLI. Facts relevant to ktchn, all from `DUR/README.md`:

| Capability                                                                                                                                      | Where                                                                  | Relevance                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Every turn, tool call and document is committed to storage before it is shown. After a crash, `resume()` continues unfinished work              | "Persist and Resume", lines 115-138                                    | Park and resume (ADR 0007) without managing session files                                                   |
| A crashed task is retried up to `settings.restartLimit` (default 5), then ends with `runFailure` reason `restart_limit`                         | "Failures and Recovery", line 216                                      | Maps onto #4's "a crash resumes once, then parks" with `restartLimit: 1` (inferred)                         |
| `requestId` makes a submission idempotent across restarts                                                                                       | lines 129-138                                                          | Resuming after a reply can't double-submit                                                                  |
| Every tool call goes through `env`, a function from the conversation and its `cwd` to an `ExecutionEnv`                                         | "Environment", lines 430-457; example `28-sandbox-per-conversation.ts` | Tools run in the sandbox. The model loop and its keys stay on the host                                      |
| `pi.usage` holds tokens and cost per model and per tool, failed attempts included                                                               | "Usage and Cost", lines 842-848                                        | Spend for the ledger. There is no spend cap; a budget needs a `beforeRequest` hook or a check between turns |
| `maxTurns` caps tool rounds per run                                                                                                             | lines 404                                                              | A runaway ceiling                                                                                           |
| `beforeTool` can block or rewrite a call; `afterTool` can replace a result                                                                      | "Hooks", lines 646-667                                                 | Interception, which ADR 0004 gave up                                                                        |
| `afterRun` starts durable tasks after a run answers, such as checks, and can queue a fix run                                                    | lines 669-701; example `32-tests-after-edits.ts`                       | A building block for review's checks                                                                        |
| A conversation has its own model, extensions, tools and `cwd`                                                                                   | "Per-Conversation Agent", lines 380-404; example `27-reviewer.ts`      | A reviewer without the agent's context                                                                      |
| No skill discovery. Instruction text enters only as `section()`s and `instructions`                                                             | "System Prompt", lines 370-378                                         | ADR 0006 holds without the pi CLI's flag recipe (issue-2-pi.md risks 9 and 10)                              |
| Storage: memory, SQLite, JSONL, IndexedDB, Durable Object. One process owns a storage, with no cross-process locking                            | "Storage", lines 850-881                                               | One Harness per ktchn process                                                                               |
| Built-in tools are `read`, `write`, `edit`, `bash`                                                                                              | "Tools", line 247                                                      | Smaller than the pi CLI's tool set and prompt                                                               |
| Model requests carry pi attribution headers to OpenRouter, NVIDIA NIM and OpenCode by default; `identity: { attribution: null }` turns them off | line 80                                                                | Minor; set it off                                                                                           |

pi-env (`ENV/README.md`) is a Rust daemon plus a `RemoteExecutionEnv` client, so "an agent's tools run on another machine, usually over SSH, while the Durable worker, its storage and credentials stay local." Its `Connection` takes any argv as the daemon command (`ENV/src/connection.ts:76`) and spawns it with `serve --token` appended (`ENV/src/connection.ts:304`).

## 2. Against the #1 map

| Map item                                            | Covered by                                                                                                                          | What ktchn still owns                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Intake: Telegram, ticket label, schedule (#14)      | Nothing                                                                                                                             | All of it                                                   |
| Classification to workflow and model (#6, ADR 0009) | Nothing. gstack's go-mode routes inside the agent, which ADR 0006 rules out                                                         | All of it                                                   |
| Workflows as Markdown (#5)                          | gstack playbooks (`skills/go-mode/playbooks/`) as prior art                                                                         | The workflow format and its done section                    |
| Agent run in a sandbox                              | Sandcastle: worktree, `.git` overlays, commit extraction. pi-durable could run the loop on the host instead of a CLI in the sandbox | Choosing the harness (section 3)                            |
| Model proxy, keys, budget (#10, ADR 0005)           | pi-durable: keys stay in the host process; `pi.usage` gives spend                                                                   | Budget enforcement                                          |
| Park and resume (ADR 0007, #4)                      | pi-durable persists the conversation natively and resumes after crashes. It has no lazy-session gap (issue-2-pi.md risk 1)          | Matching Telegram replies to runs, the park states          |
| Review: checks and an independent reviewer (#7)     | pi-durable's `afterRun` and a separate reviewer conversation                                                                        | Evidence, "no evidence, not done", two fix rounds then park |
| Ledger (#12, ADR 0008)                              | Nothing. pi-durable's store holds transcripts, which the ledger excludes                                                            | All of it                                                   |
| Push and PR only after review (ADR 0005)            | Nothing                                                                                                                             | All of it                                                   |
| Egress allowlist                                    | Nothing. Sandcastle passes `--network` through only (issue-3-sandcastle.md section 2); pi-durable doesn't touch the network         | A proxy or host firewall                                    |
| Ref moves, submodules, `config.worktree`            | Sandcastle leaves these writable (issue-3-sandcastle.md section 3)                                                                  | Escape test, snapshotting refs before and after             |
| Chief of staff (#9)                                 | Nothing                                                                                                                             | All of it                                                   |

## 3. The harness question

ADR 0004 chose a CLI in a sandbox over embedding pi as a library: embedding would let ktchn veto each tool call, but containment is "far less to build." pi-durable changes that trade. Tool calls run inside the sandbox through `env`, so safety still comes from the boundary, and `beforeTool` gives interception as well.

What switching would remove or shrink:

- The model proxy as a way to keep keys out of the sandbox (#10, ADR 0005). It may still be wanted for logging, but `pi.usage` covers spend.
- Parsing the pi CLI's JSON stream (issue-2-pi.md section 3).
- The isolation flags `--no-skills --no-context-files --no-extensions --system-prompt` and the telemetry env vars (issue-2-pi.md sections 4 and 5).
- The lazy session file and per-run session dirs (issue-2-pi.md risks 1 and 2).

What it costs:

- An experimental API that breaks without notice.
- A hand-written `ExecutionEnv` into the container. It must implement both `FileSystem` and `Shell` (`DUR/src/env/index.ts:377`).
- Agent loops run in the ktchn process, which weakens the crash isolation that ADR 0001 borrows from OTP.
- Only `read`, `write`, `edit` and `bash`, without the pi CLI's own system prompt.
- A second store next to the ledger. ADR 0008 is unaffected, since transcripts aren't in the ledger.

Two ways to build the `ExecutionEnv`, both unverified:

1. **pi-env through `docker exec`.** `new Connection({ command: ["docker", "exec", "-i", <container>, "<path to pi-env>"] })` should work given `ENV/src/connection.ts:76` and `:304`, if the daemon binary is in the image. pi-env's env conformance suite (`registerEnvConformance()`) would check it.
2. **Wrap Sandcastle's sandbox handle.** `createSandbox()` returns a `Sandbox` with `exec(command, { cwd, stdin, onLine, sudo })`, `worktreePath` and `branch` (`SC/src/createSandbox.ts:228-267`). This keeps Sandcastle's worktree and `.git` overlays. `exec` covers `Shell`; `FileSystem` would be built from shell commands or by reading `worktreePath` on the host. Reading on the host is safe only for reads that don't run anything.

Sandcastle stays in either design as the layer for worktrees, git control files and commits. Under pi-durable, ktchn would call `createSandbox()` and `exec()` rather than `run()` with the pi agent provider.

## 4. gstack

gstack is content: skills, playbooks, a model table and a Claude Code plugin (`harnesses/claude-code/`). It has no runtime that ktchn could compose with.

Its `autonomous-run` playbook (`skills/go-mode/playbooks/autonomous-run.md`) is an agent working a spec's tickets from inside its own context. It defines its own exit condition, picks skills itself and judges done itself. Claude Code with `/loop` and go-mode gets roughly a run loop today, but that is the setup ADR 0002 and ADR 0006 exist to move away from. gstack's role stays as in ADR 0002: the skill catalogue, read as text.

## Unconfirmed items

- Whether pi-env runs as a daemon through `docker exec -i`.
- How pi-durable behaves with a container `ExecutionEnv`: latency per call, and `edit`/`write` serialization by env `id`.
- Whether Sandcastle's `exec` is enough for a full `FileSystem`, including binary reads and `stat`.
- Whether `restartLimit: 1` gives exactly #4's "resume once, then park."
- How often pi-durable's API breaks in practice between minor releases.

## Suggested spike

1. Back an `ExecutionEnv` with Sandcastle's `Sandbox.exec` and pass `registerEnvConformance()`.
2. Start a run, kill the process mid-turn, reopen the SQLite store and resume.
3. Run the planned adversarial escape test against that setup.

If it works, #10 mostly goes away and #4's crash and park rules map onto `restartLimit` and `runFailure`. If it doesn't, the pi CLI in a Sandcastle sandbox stays sound, with the gaps already listed in issue-2-pi.md and issue-3-sandcastle.md.
