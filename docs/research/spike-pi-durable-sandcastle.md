# Spike: pi-durable on the host, tools in a Sandcastle sandbox

Question: can ktchn run the model loop in its own process with pi-durable, run every tool call inside a Sandcastle sandbox, and survive the host process being killed mid-run? This is step 1 of "Path to a first validating run" on the map (gregogun/ktchn#1). The earlier notes are [composition-pi-durable.md](composition-pi-durable.md) and [issue-3-sandcastle.md](issue-3-sandcastle.md).

Versions: `@earendil-works/pi-durable` 1.5.0, `@earendil-works/pi-env` 1.5.0, Sandcastle built from source at `0460513` (2026-10-31), Docker 29.1.3 on macOS arm64, image `sandcastle-test:latest`. Model: `anthropic/claude-haiku-4.5` through OpenRouter. Run on 2026-11-04. The scripts were throwaway and lived in a session scratch directory.

## Verdict: it works, and it needs no hand-written `ExecutionEnv`

pi-env ships a daemon (`bin/pi-env-linux-arm64/pi-env`) and `RemoteExecutionEnv`, a Durable `ExecutionEnv` that talks to the daemon over stdin and stdout. Its `Connection` takes any command, so the transport is `docker exec -i <sandbox container> /opt/pi-env/pi-env`, with the daemon bind-mounted read-only into the sandbox. The spike plan assumed ktchn would write an `ExecutionEnv` over `Sandbox.exec`. That is about 25 methods, including file watching and paged readers, and it is no longer needed.

| Check                                                                        | Result                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable's env conformance suite (`registerEnvConformance`, with `listFiles`) | 29 of 29 pass with each case in a fresh directory under `/tmp` in the container. Inside the workspace repo, 28 of 29 pass. The failure is the `.gitignore` case, and the likely cause is that its fixture sits inside another work tree (inferred, not traced).                                                                               |
| Kill and resume                                                              | The host process was `SIGKILL`ed while the agent's `sleep 25` tool call ran. A new process reopened the SQLite store, found the same submission by `requestId`, and finished the run: `two.txt` written, commit made, answer `DONE`. Steps that had finished did not run again.                                                               |
| Model key in the sandbox                                                     | None. The key is read by the host process only. `env` inside the sandbox has no key or token.                                                                                                                                                                                                                                                 |
| Escape probes, through the same `env.exec` the agent's `bash` tool uses      | Planting a hook fails (read-only file system). Writing `.git/config` fails (device busy, from the overlay). The host home is not visible. Moving `main` succeeds, and the host's `main` moved. Network egress succeeds (`https://example.com` returned 200).                                                                                  |
| Blocking one tool call (`beforeTool` hook, run 2026-11-05)                   | A hook on the host blocked `git update-ref refs/heads/main HEAD` and let the commit before it through. The call never reached the sandbox: the host's `main` did not move, and the tool result has no duration. The model got `Tool call blocked: <reason>` as an error result, recorded with diagnostic code `blocked`, and stopped as told. |

## What this changes

- **#10 (model proxy) is not needed to keep keys out of the sandbox.** The model loop runs in ktchn, so ADR 0005 holds without a proxy.
- **ADR 0004 (containment over interception) is superseded by ADR 0012.** With Durable, ktchn gets containment and interception together: every tool call passes through the host, where a `beforeTool` hook can block it. The spike tested this on one call.
- **#4's crash rule maps onto Durable's `settings.restartLimit`.** "A crash resumes once, then parks" would be `restartLimit` plus `runFailure`. This is inferred from the README. The spike tested one crash only.

## Gaps the build has to handle

- **An interrupted tool call runs again from the start on resume.** The `sleep 25` result records `durationMs` 41,666, so it ran a second time after the restart. Tool execution is at least once, so a tool cut off mid-call can repeat its side effects.
- **Refs stay writable.** The agent can move `main` on the host. The known fix is to push only after review and never let the sandbox share the host's refs. Bind mount versus own clone is still open on the map.
- **Egress is open.** Nothing in Sandcastle or pi-env restricts the network.
- **Sandcastle on macOS breaks git under a symlinked path.** A repo under `/var/folders` (the macOS temp dir) is mounted at `/var/...`, but the worktree's `.git` pointer names `/private/var/...`, so git fails inside the sandbox. Real projects under the home directory are not affected. Worth reporting upstream.
- **ktchn must build Sandcastle from a pinned commit.** The checkout's `dist/` was from May and had none of the read-only git overlays. With that build, the sandbox planted a hook in the host repo, set `core.hooksPath` in the host's `.git/config`, and moved `main`.
- **`safe.directory` has to be set by ktchn.** Sandcastle sets it only before its own agent starts. Files in the bind mount belong to the host user (uid 501), while the container user is uid 1000.
- **pi-durable is experimental.** 1.5.0 shipped breaking changes two days after 1.4.0. Pin the version.

## Not tested

- A hook that is asked to approve rather than refuse: one that parks the run and waits on the owner.
- The agent attempting the escape itself. The probes used `env.exec` directly, which is the path the `bash` tool takes (inferred from the tools README).
- Whether the daemon or its child processes outlive a killed host process inside the container.
- Two crashes in a row, and park through a Durable sleep or a wait on the owner.
