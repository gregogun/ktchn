# Concrete implementations until a second one exists

Status: [ADR 0016](0016-the-kitchen-owns-the-context.md) amends this for the harness. pi is the only harness, and a second one must let the kitchen own its context. The note about Sandcastle's agent-provider interface no longer holds. The rest stands.

ktchn uses Telegram for chat, GitHub for code and issues, and pi as the agent harness, each written directly against its real API in its own module, with no interface in front. The design is ports-and-adapters in spirit, but we write an interface only when a second implementation actually arrives, because an interface designed around one implementation is a guess. Clean module boundaries are kept everywhere, so extracting an interface later is cheap. (Sandcastle's own agent-provider interface already gives some harness flexibility at no cost to us.)
