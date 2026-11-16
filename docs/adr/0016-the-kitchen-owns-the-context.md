# The kitchen owns the agent's context, so it runs only on a harness it controls

Status: amends [ADR 0002](0002-single-package-external-skills-and-sandbox.md) for the skill catalogue and [ADR 0003](0003-concrete-until-a-second-implementation.md) for the harness. Widens [ADR 0006](0006-the-kitchen-chooses-skills.md).

ktchn started as a kitchen that takes a job and hands back reviewed work. It is now a system for agentic development: one place where the owner hands jobs to agents, follows their runs, answers the ones that park and gets back only work that passed review. It is built around the pieces that make that safe, which are a harness, sandboxes, review and the ledger.

What ktchn offers that a coding agent such as Claude Code does not is that the kitchen decides what goes into the agent's context. ADR 0006 has the workflow bring its skills. This widens the choice: which skills a round gets is a pure decision made from the job's workflow, the project and the run's state, such as whether the round starts from review's findings. The ledger records it (ADR 0008). It is never a private choice the model makes from whatever it finds on disk.

That decides which harnesses ktchn can run. A harness qualifies only if ktchn owns everything that reaches the model, meaning the system prompt, the skills, the tools and any context files, with nothing loaded from the project or the owner's machine behind the kitchen's back. pi, run through pi-durable, qualifies and is the only harness (ADR 0012). Any model pi-ai can reach may run in it. Claude Code, Codex and other agent CLIs that discover their own skills and context files do not qualify, however they are wrapped.

ktchn is malleable in the parts that say how work is done and fixed in the parts that make its results safe to trust. The owner defines workflows, the rules that pick skills, checks, policy and the model table. Every run works inside a sandbox, and no run is done without passing review with evidence. Neither can be switched off.

## Considered options

- **Any harness the owner prefers, behind an interface.** An agent CLI loads its own context, so the kitchen's choice of skills would compete with the harness's own. It also runs its model loop inside the sandbox, which brings back the key proxy that ADR 0012 removed and gives up seeing each tool call and resuming after a crash.
- **Review and the sandbox as options the owner can turn off.** That is what a front end for a harness offers already. Without them, ktchn has nothing to offer that the harness lacks.

## Consequences

- ADR 0003's rule stands: no harness interface until a second harness passes the test above. Its note that Sandcastle's agent-provider interface gives harness flexibility no longer holds. ADR 0015 removed Sandcastle, and this ADR rules out the harnesses that interface would have reached.
- The local app (ADR 0011) is where the owner works with the kitchen. For each round it shows what the agent was given and why, because that record is what this decision buys.
- No skill catalogue or set of workflows shapes ktchn's design. The skill catalogue is whichever folders of skills the owner points the kitchen at, and gstack is one of them.
