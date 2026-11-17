# pi is the harness for every role, and each role picks its provider and model

Status: refines [ADR 0003](0003-concrete-until-a-second-implementation.md) and [ADR 0009](0009-classification-picks-the-model.md).

Each role that calls a model, the agent and the reviewer today, runs in pi through pi-durable. A role names a provider and a model. The provider is how pi reaches the model and who pays for the call. ktchn keeps its providers in one table in `src/session.ts`, and each row says how the provider is billed.

- **openrouter** bills each call to the owner's OpenRouter key, at the price OpenRouter reports.
- **claude-code** bills the owner's Claude subscription. It is the [pi-claude-code](https://github.com/earendil-works/pi-claude-code) provider, which sends each request through the unmodified `claude` CLI on the host. Claude Code keeps the owner's login. The owner signs in once with `claude auth login`. ktchn never reads, copies or stores the credential, and the credential never enters a sandbox (ADR 0005).

The agent stays on OpenRouter. The reviewer defaults to Claude Opus on claude-code, and each provider has its own default reviewer model. A job records its reviewer's provider beside its model, so a run started again after a crash keeps both. Before a run starts, ktchn checks that the reviewer's provider is ready. For claude-code that means Claude Code is installed and signed in with a subscription, so a missing login stops the run before the agent spends anything.

A subscription call has no per-call price. The ledger records its tokens with cost 0 and marks it as a subscription call. The report gives the priced cost and says how many calls had no price, so a zero is not read as a free API.

## Considered options

- **pi-ai's own Anthropic login.** Anthropic's [terms for Claude Code](https://code.claude.com/docs/en/legal-and-compliance) do not let a third-party app offer Claude.ai login or store its tokens. This option needs both.
- **Claude Code as the reviewer's harness.** That is a second harness, and Claude Code fails the test in ADR 0016. It would also give the reviewer a different session model from the agent.
- **An Anthropic API key through pi's Anthropic provider.** It works, but each call is billed per call. It can become a row in the table when a role needs it.

## Consequences

- ADR 0003 stands. The table holds concrete providers, and pi-ai's provider type is the only interface. ktchn adds none.
- ADR 0009's model table gains a provider on each row. Classification still picks the model.
- Claude Code acts here only as the way to reach the model, not as a harness. pi supplies the system prompt, keeps the history and runs the tools. Claude Code loads no settings, no `CLAUDE.md`, no memory and no tools of its own. It still adds its own environment note to the request, with the working directory of the ktchn process, the platform, the date and the model's name. That note holds nothing from the agent's session or the project, so the reviewer keeps its independence. Before an agent runs on claude-code, this needs another look against ADR 0016.
- pi-claude-code is experimental, so it is pinned to a commit. It ships only TypeScript source, so `scripts/build-pi-claude-code.ts` compiles it on install.
- Anthropic can change how `claude -p` usage is billed. The provider refuses a call that would draw on extra usage instead of plan limits. If the route stops working, the owner moves the reviewer back to openrouter with one flag, `--reviewer-provider openrouter`, which also brings back OpenRouter's default reviewer model.
- The provider does not enforce strict constrained sampling for tool arguments. The reviewer's `submit_verdict` tool still asks for it. The Harness checks the arguments against the tool's schema, and a call that fails the check gives no verdict.
