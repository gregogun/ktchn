# The agent runs on the host with pi-durable; its tools run in the sandbox

Status: [ADR 0015](0015-sealed-sandbox-and-trusted-clone.md) amends this for the sandbox provider. Sandcastle is no longer used, and the sandbox's network is a job's Policy.

ADR 0004 put the agent inside the sandbox as a CLI and gave up seeing each tool call. ADR 0005 then needed a proxy on the host to keep the model key out of the sandbox. A spike ([docs/research/spike-pi-durable-sandcastle.md](../research/spike-pi-durable-sandcastle.md)) showed a third shape that gets both: ktchn runs the agent's model loop in its own process with pi-durable, and every tool call runs inside the Sandcastle sandbox through pi-env's daemon over `docker exec`. The model key never enters the sandbox because no model call happens there, so no proxy is needed. Every tool call passes through ktchn, which can block one before it runs. And when the ktchn process is killed, Durable resumes the agent where it stopped.

Safety still comes from the boundary. Blocking a tool call would be a second line, not the first: the sandbox is why nothing the agent does matters outside it, and review's checks run in a sandbox, never on the host.

## Considered options

- **The pi CLI in the sandbox** (ADR 0004 as written). It needs the proxy, gives no way to stop a single tool call, and has no resume after a crash beyond restarting the CLI session.
- **ktchn's own `ExecutionEnv` over Sandcastle's `Sandbox.exec`.** About 25 methods, including file watching and paged readers, for nothing pi-env's daemon doesn't already do and pass Durable's conformance suite with.

## Consequences

- Supersedes ADR 0004. Replaces ADR 0005's proxy; the rest of ADR 0005 stands. Model calls are logged to the ledger and budgets are enforced in ktchn's process, where the model loop runs.
- Durable's store holds agent sessions, not run state. The ledger stays the record (ADR 0010), and a run's state never comes from how far its agent session has got. A parked run's saved agent session (ADR 0007) is its Durable session.
- A tool call cut off by a crash runs again from the start on resume. Tools must be safe to run twice.
- The sandbox had open network access, and the spike moved `main` on the host and reached the internet. The refs side is closed by giving each run a private clone (ADR 0014, then ADR 0015). The network is now a job's Policy and off by default (ADR 0015).
- pi-durable is experimental, so pin it. Sandcastle was pinned here too, until ADR 0015 removed it.
