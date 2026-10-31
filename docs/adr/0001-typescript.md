# TypeScript, not Elixir

ktchn is written in TypeScript on Node. Elixir fits the problem's shape better: each run as a supervised process with a mailbox, restarted when it crashes. But the work is I/O-bound, the agent tooling ktchn depends on (pi, Sandcastle) is TypeScript, and the goal is for the owner to understand the core. Learning a new paradigm while designing a new system works against that. ktchn borrows OTP's ideas (supervision, let it crash, message passing) without the runtime. Revisit if we find ourselves rebuilding supervisors and mailboxes badly.
