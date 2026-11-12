# ktchn

ktchn is a local system for working with coding agents. You hand it a job. An agent does the work inside a sealed sandbox, given only the context ktchn decides on. Review then runs the project's checks, and you get the work back as a branch and a pull request only after it passes.

The agent runs on the [pi](https://github.com/earendil-works/pi) harness through pi-durable. Today it can use any model on OpenRouter.

## Why not just use a coding agent?

Tools like Claude Code put the model in charge of its own context. It finds skills, reads context files and picks what to load, and you find out what it chose after the fact. ktchn is built to turn that around.

- **The kitchen decides what the agent is given.** Which skills a round gets will depend on the job, the project and the state of the run, such as whether this round is fixing review findings. ktchn makes that choice as a pure function and records it in the ledger, so you can see what an agent was given and why. The same inputs give the same context every time. This is designed but not built yet. Today the agent gets the job text, a note about its sandbox and the checks it must pass.
- **Containment instead of permission prompts.** The agent works in a Docker sandbox with no repository mounted, no credentials and, unless the job asks for it, no network. Model calls happen on the host, so the model key never enters the sandbox. Nothing asks you to approve a command, because nothing the agent does reaches past the sandbox.
- **Done means reviewed.** A run is done only when review passes. Today review checks that the agent made a new commit that leaves protected files alone, then runs the job's checks in a separate sandbox. The reviewer, a model that judges the work against what was asked, is not built yet.
- **Runs survive crashes.** If the process dies, starting the same job again picks the run up where it stopped. A run that needs you parks and frees its sandbox. Answering a parked run is not built yet.

You decide how work is done: the workflows, the rules that pick skills, the checks, the policy and the models. The sandbox and review are not optional, because they are why you can trust what comes back. [ADR 0016](docs/adr/0016-the-kitchen-owns-the-context.md) explains that line.

## How a run works

1. ktchn makes a private, bare clone of the project and copies the code into a fresh sandbox as a git bundle.
2. The agent works in rounds. Each round ends with a commit in the sandbox.
3. A separate sandbox with no agent tools and no network collects that commit into the clone.
4. Review runs the checks. If they fail, the findings go back to the agent for another round. After the third failed review, the run parks.
5. When review passes, ktchn writes the reviewed commit into the project as the branch `ktchn/<run id>`. That handoff is the only thing a run ever puts in the project. ktchn then pushes the branch to `origin` and opens a pull request.

Every decision along the way is an event in the ledger, an append-only record in SQLite. A run's state is those events replayed.

## Status

ktchn is early and runs from a command line. Workflows, skill selection, the reviewer and the local app are designed in [docs/adr/](docs/adr/) but not built yet.

## Try it

You need Node 24 (see `.nvmrc`), pnpm, a running Docker daemon, the GitHub CLI signed in with `gh auth login`, and an OpenRouter key. The project you point ktchn at needs a GitHub `origin`.

1. Install dependencies:

   ```sh
   pnpm install
   ```

2. Build the sandbox image:

   ```sh
   scripts/build-sandbox-image.sh
   ```

   If your project's checks need dependencies, build an image with them in it. [docs/sandbox-image.md](docs/sandbox-image.md) shows how.

3. Set your key. ktchn also reads it from `~/.pi/agent/auth.json`.

   ```sh
   export OPENROUTER_API_KEY=...
   ```

4. Start a run:

   ```sh
   node src/start.ts ~/code/my-project "Fix the off-by-one in the pagination helper" --check "pnpm test"
   ```

The command runs until the run is done or parks, then prints its state and model cost. It exits early with a message if something stops the run from starting. To pick up a run after a crash, run exactly the same command again. The run's id comes from its arguments.

Other flags:

- `--check "<command>"` adds a check. Repeat it for more.
- `--model <id>` picks an OpenRouter model.
- `--network` gives the agent's sandbox network access.
- `--allow-path "<glob>"` lets the agent change a protected file, such as `package.json` or a lint config.

Runs keep their clones and ledger in `~/.ktchn`. Set `KTCHN_HOME` to use another folder.

## Learn more

- [GLOSSARY.md](GLOSSARY.md) defines the words ktchn uses: job, run, round, sandbox, review, handoff and the rest.
- [docs/adr/](docs/adr/) records the decisions behind the design and why.
- [AGENTS.md](AGENTS.md) lists the checks to run before you call work done.
