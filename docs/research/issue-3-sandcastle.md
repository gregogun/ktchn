# Issue #3: What Sandcastle gives ktchn, and where it has gaps

Source studied: `/Users/gregogun/webdev/ai/sandcastle`, version 0.12.0 (`package.json:3`).
Paths below are relative to that repo unless they start with `/`.

## Short answer

- **Session capture and resume:** Both `claudeCode` and `pi` capture a session and resume or fork it. Only `claudeCode` parses usage and captures subagent sessions. Pi has no `canFork` flag, so it is forked by default.
- **Docker network egress:** Not supported. Sandcastle only passes `--network` through to Docker. It has no egress allowlist, proxy, or DNS option. An allowlist has to be built outside sandcastle.
- **`.git` lockdown:** Read-only overlays cover `config`, `hooks`, `info`, the worktree `.git` pointer file, and `commondir`. Refs, `packed-refs`, `HEAD`, the index, logs, `modules/`, and the worktree's `config.worktree` stay writable.
- **Hooks:** Sandcastle has pre-flight hooks (`host.onWorktreeReady`, `host.onSandboxReady`, `sandbox.onSandboxReady`). It has no post-agent hook. Post-run checks belong in ktchn after `run()` resolves.
- **Run result:** `RunResult` carries iterations, completion signal, stdout, commits, branch, log path, preserved worktree path, and resume and fork handles. Per-iteration results carry session ID, session file path, usage, and context window.
- **Spec claim:** "Sandcastle locks git config and hooks, but submodules, the worktree config file and ref moves are gaps." This is confirmed. The worktree config gap is conditional on the host repo having `extensions.worktreeConfig` enabled, and the submodule behaviour is unconfirmed at runtime.

## 1. Pi versus claudeCode: session capture and resume

| Capability | claudeCode | pi |
|---|---|---|
| Provider name | `name: "claude-code"` at `src/AgentProvider.ts:1608` | `name: "pi"` at `src/AgentProvider.ts:863` |
| Session capture default | Capture on | `captureSessions: options?.captureSessions ?? true` at `src/AgentProvider.ts:865` |
| Session storage | `makeClaudeSessionStorage`, `src/AgentProvider.ts:513-560`, host capture at 531 | `makePiSessionStorage`, `src/AgentProvider.ts:667-712`, host capture at 695, resume into sandbox at 712 |
| Session ID source | Init line | Stream `session` header, `src/AgentProvider.ts:788` |
| Resume flag | `--resume <id>`, `src/AgentProvider.ts:1629-1637` | `--session <id>`, `src/AgentProvider.ts:882-886` |
| Fork flag | `--fork-session` (only with resume), `src/AgentProvider.ts:1629-1637` | `--fork <id>`, which copies to a new session, `src/AgentProvider.ts:882-886` |
| Fork support flag | Not set (default fork allowed) | Not set (default fork allowed); `canFork: false` is set for cursor and copilot at `src/AgentProvider.ts:1144` and `1519` |
| Usage parsing | `parseSessionUsage`, `src/AgentProvider.ts:1662` | Not implemented (no `parseSessionUsage` in the pi provider) |
| Context window | Available from captured JSONL | Taken from `message_end`, `src/AgentProvider.ts:793` |
| Final result | From the stream `result` event | From `agent_end` messages, `src/AgentProvider.ts:751` and `830` |
| Subagent capture | Best-effort, `src/AgentProvider.ts:550` | Not observed in pi code (unconfirmed whether pi emits subagent sessions) |

Orchestration:

- Resume and fork apply only on iteration 1. `src/Orchestrator.ts` around lines 421-424.
- `resumeSession` with `maxIterations > 1` is refused, `src/run.ts:554-557`.
- `forkSession` without `resumeSession` is refused, `src/run.ts:566`. The fork path sets `forkSession: true` at `src/run.ts:872`.
- Captured session JSONL feeds `sessionFilePath`, usage, and context window, `src/Orchestrator.ts` around lines 553-601.
- `IterationResult` fields are documented at `src/Orchestrator.ts:326-338`.

For ktchn, pi can park and resume a run (ADR 0007), but it does not give per-iteration token usage. Those numbers would have to be read from pi's own output.

## 2. Docker provider: network egress allowlist

Answer: **No.**

- `DockerOptions.network` is `string | readonly string[]`, documented as "When omitted, Docker's default bridge network is used", `src/sandboxes/docker.ts:71-78`.
- The value passes through as `--network` flags, `src/DockerLifecycle.ts:128-130`, and into `docker run`.
- No egress, proxy, DNS, capability, or read-only root filesystem option exists in `DockerOptions` (checked the option block at `src/sandboxes/docker.ts:60-130` and the construction at `src/sandboxes/docker.ts:186-194`).
- Sandcastle cannot stop a container from reaching arbitrary hosts. A ktchn allowlist needs an external Docker network with an egress proxy, or a host firewall. That design is outside this repo and unconfirmed as a working setup here.

## 3. `.git` lockdown: exact paths and mechanism

Mechanism: `protectGitControlFiles` adds read-only bind mounts over the control paths at every place they appear inside the sandbox. Read-only is set by `formatVolumeMount` adding `ro` (`src/mountUtils.ts:380-390`). The overlay is applied in `src/startSandbox.ts:166-172` with the comment "The sandbox may write the repo's objects and refs, but never the git files that decide what git on the host runs."

The `.git` pointer file and parent `.git` directory are mounted read-write first (`src/SandboxFactory.ts:350-368`), and the overlays then narrow that.

Control paths locked (`src/protectGitMounts.ts`):

| Path | Lines | Locked by |
|---|---|---|
| `<commonDir>/config` | 72-77 | `commonDirControlPaths` |
| `<commonDir>/hooks` (created if missing) | 72-77 | `commonDirControlPaths` |
| `<commonDir>/info` (created if missing) | 72-77 | `commonDirControlPaths` |
| Worktree `.git` pointer file | 80-102 | `linkedWorktreeControlPaths` |
| `<adminDir>/commondir` | 80-102 | `linkedWorktreeControlPaths` |

Left writable (not in the overlay list):

- `refs/` and `packed-refs`, so the sandbox can move any branch ref in the common dir, including the host's current branch.
- `HEAD`, `index`, and `logs/` in the admin dir.
- `modules/` (submodule admin dirs). Behaviour unconfirmed.
- `<adminDir>/config.worktree`. Read by git only when `extensions.worktreeConfig` is set. The sandbox cannot set that extension, since the common `config` is read-only, but a host that already has it set is exposed. Confirmed by a scratch experiment in `/private/tmp/claude-501/-Users-gregogun-webdev-projects-ktchn/af8a2ee4-6d37-47cb-83f1-edb6424af577/scratchpad/wt.AKqA/` that a `core.hooksPath` in `config.worktree` takes effect only after `git config extensions.worktreeConfig true`.

Host-side guard: `src/hostGit.ts:1-30` pins `GIT_DIR`, `GIT_COMMON_DIR`, `GIT_WORK_TREE`, and restricts `PATH` and protocols. `src/hostGitConfig.ts:31-44` pins program-running keys (`core.fsmonitor`, `core.hookspath`, `core.pager`, and others, and `submodule.recurse=false`). Because of this, a sandbox-written `config.worktree` value that runs a program is mostly neutralised. Non-program keys in that file are not analysed further (unconfirmed impact).

## 4. Pre-flight and post-run hooks

Hook shape, `src/SandboxLifecycle.ts:143-160`:

- `host.onWorktreeReady`: runs on the host after the worktree copy and before sandbox creation, `src/createWorktree.ts:251-253` and `src/createSandbox.ts:989-992`. A non-zero exit fails the run. This is the right place for ktchn pre-flight checks.
- `host.onSandboxReady`: runs on the host in parallel with the sandbox hooks, `src/createSandbox.ts:1069-1090`.
- `sandbox.onSandboxReady`: runs inside the container (optionally with `sudo`), in parallel with the host hooks, `src/createSandbox.ts:1069-1090`. The lifecycle also runs `git config --global --add safe.directory` before these hooks.

Post-run: **none.** `src/SandboxLifecycle.ts` runs `work` at line 443, then collects commits at line 474 and merges or deletes the branch, lines 509-537. No user hook runs after the agent finishes. ktchn has to run its post-run checks after `run()` resolves, against the preserved or merged state.

Worktree cleanup, `src/createSandbox.ts:1136-1160`: the worktree is preserved when `hasUncommittedChanges` is true, otherwise removed. A ktchn check that needs the worktree must run before close or read `preservedWorktreePath`.

## 5. Run result shape

`RunResult`, `src/run.ts:455-496`:

- `iterations`: count and per-iteration results
- `completionSignal`
- `stdout`
- `commits`
- `branch`
- `logFilePath` (log mode is `"file"`, `src/run.ts:206`)
- `preservedWorktreePath`
- `resume` and `fork` handles (`src/run.ts:474` and `492`)
- `output` (structured output, with retry on parse failure around `src/run.ts:890-930`)

`IterationResult`, `src/Orchestrator.ts:326-338`: `sessionId`, `sessionFilePath`, `usage`, `contextWindow`. `usage` is undefined for providers without `parseSessionUsage`, so pi returns no usage here.

Stream events: `onAgentStreamEvent` at `src/run.ts:215`. Event emission is in `AgentStreamEmitter.ts:16-35` (unverified at line level in this pass).

Validation: `head` with `isolated` is refused, `src/run.ts:536`. `copyToWorktree` with `head` is refused, `src/run.ts:544`.

## Gaps table

| Gap | Evidence | Classification | Why |
|---|---|---|---|
| No egress allowlist for Docker | `src/sandboxes/docker.ts:71-78`, `src/DockerLifecycle.ts:128-130` | wrap | Sandcastle passes `--network` through only. ktchn needs an external network with a proxy. Upstream feature request is optional. |
| No Docker DNS, proxy, or cap options | `src/sandboxes/docker.ts:60-130` | upstream | Missing options block a proper containment story (ADR 0004). |
| Worktree `config.worktree` not locked | `src/protectGitMounts.ts:72-102` (not listed), scratch experiment | fork | Exposed only when the host has `extensions.worktreeConfig`. A fork can add `config.worktree` to the overlay list. |
| Refs and `packed-refs` writable | `src/protectGitMounts.ts:72-102`, `src/SandboxFactory.ts:350-368` | upstream | Sandbox must write refs to commit. Protection would need a per-branch policy, which is a design choice upstream should make. Wrap by snapshotting refs before and after. |
| `HEAD`, `index`, `logs` writable | `src/protectGitMounts.ts:72-102` | wrap | Low risk for ktchn if the host checks `git rev-parse` after the run. |
| `modules/` (submodules) not handled | `src/protectGitMounts.ts:72-102` (not listed), `src/hostGitConfig.ts:31-44` pins `submodule.recurse=false` | fork | Submodule admin dirs are unlocked. Runtime behaviour unconfirmed. |
| No post-agent hook | `src/SandboxLifecycle.ts:443-537` | upstream or wrap | ktchn can wrap by running checks after `run()` resolves. Upstream hook would let checks run before commit. |
| Pre-flight available | `src/createWorktree.ts:251-253`, `src/createSandbox.ts:989-992` | (no gap) | `host.onWorktreeReady` covers pre-flight. |
| No secret scan on output | None found | wrap | ADR 0005 puts credential handling on ktchn. Add a scan after run. |
| Env from `.sandcastle/.env` reaches container | `src/EnvResolver.ts:52-69`, `src/DockerLifecycle.ts` env `-e` flags | wrap | Conflicts with ADR 0005 if the file holds credentials. ktchn should keep that file free of secrets. |
| Uncommitted changes preserve worktree | `src/createSandbox.ts:1136-1160` | wrap | ktchn must read `preservedWorktreePath` and handle it, not treat it as failure. |
| Pi has no usage parsing | `src/AgentProvider.ts:1662` (claudeCode only) | upstream | Token accounting for pi runs is missing. |
| Pi has no subagent capture | `src/AgentProvider.ts:550` (claudeCode only) | upstream | Unconfirmed whether pi emits subagent sessions at all. |
| Pi `captureSessions` doc comment stale | `src/AgentProvider.ts:423` says default is false for non-Claude | upstream | Code at 865 defaults to true. Doc nit only. |
| Pi resume and fork work | `src/AgentProvider.ts:882-886`, `src/AgentProvider.ts:788` | (no gap) | Supported. Pi rejects `--fork` with `--session`, so sandcastle must not combine them. |

## Unconfirmed items

- Whether pi emits subagent sessions.
- Whether a submodule admin dir under `modules/` can be written from the sandbox at runtime.
- Whether non-program keys in a host `config.worktree` affect host git behaviour.
- Whether an external Docker network with an egress proxy works with sandcastle's container setup.
