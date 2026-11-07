---
status: superseded by ADR-0012
---

# Containment over interception

Agents run as a CLI inside a sandbox. They are not embedded as a library in the ktchn process. Embedding pi would let ktchn see and veto each tool call as it happens. Running it in a sandbox gives that up: ktchn watches the event stream but can't stop a single action mid-run. In return, safety comes from the boundary. The agent can do anything inside the box, and nothing it does matters outside it. That is far less to build, and it is the right trade for unattended runs. A consequence is that review's checks also run inside a sandbox, never on the host, because running the agent's code on the host would break the containment.
