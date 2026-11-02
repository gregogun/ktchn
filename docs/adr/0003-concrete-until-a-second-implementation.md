# Ports come from the core; one adapter each until a second exists

ktchn uses Telegram for chat, GitHub for code and issues, and pi as the agent harness. Each sits behind a port, but the port is defined by what the core needs, not by the tool behind it. The core's effects and events (ADR 0008) are the contract: an effect such as `RunAgent` or `SendReport` names what the kitchen wants done, and the adapter turns it into calls against the real API and turns the results back into events. No port is modelled on a vendor's API, so nothing in the core takes the shape of pi, Telegram or GitHub.

Each port has one concrete adapter, written directly against its real API in its own module. We add a second adapter only when one is actually needed, because an adapter interface designed around a single tool is a guess. A port shaped by the core is not a guess: it changes only when the kitchen's own needs change. (Sandcastle's agent-provider interface already gives some harness flexibility at no cost to us.)

## Considered options

- **No ports, concrete modules only** (this ADR's first version). It keeps things simple, but each tool's shape leaks into the code that calls it, and swapping a harness or channel means changing the core.
- **Interfaces per tool, written up front.** This commits to the first tool's shape and adds code with only one implementation behind it.
