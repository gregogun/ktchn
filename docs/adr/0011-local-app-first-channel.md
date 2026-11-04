# A local web app is the first channel; Telegram comes later

ADRs 0003 and 0007 assume Telegram is how the owner and the kitchen talk. We're changing the order: the first channel is a web app the kitchen serves on the owner's own machine, and Telegram is added later as the channel for when the owner is away from their desk. The owner works almost entirely on a laptop, so Telegram's real advantage, reaching them anywhere with push and a mobile client for free, isn't what's needed first. What is needed is a place to work with the kitchen that a chat thread or a terminal can't give: a view of every run and its state, reports rendered richly (diffs, evidence, diagrams, prose a person could print and read), and one place to hand over jobs, answer parked runs and cancel runs, whether a run is supervised or autonomous. Served locally, the app needs no hosting, auth or push service; desktop notifications cover a parked run. The chat with the chief of staff that Telegram gives for free becomes a pane in the app.

## Consequences

- The app reads from the ledger and turns the owner's actions into events, like any other part of the shell (ADR 0008). It holds no state of its own.
- Reports are structured data, so each channel renders them its own way. Prose, such as a narrative of a diff, is one field of a report, not the whole of it.
- When Telegram arrives it is the second channel, which is the point ADR 0003 says to extract a channel interface. Matching replies by the Telegram message they answer (ADR 0007) becomes how that one channel finds a run; the app answers a parked run by the run itself.
- An answer to a parked run can come from more than one channel. Resume is an event, so the first answer wins and any later one is told the run has already resumed.
