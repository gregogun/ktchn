# The kitchen chooses skills; the agent does not

ktchn picks the workflow for a job and puts the workflow's skills straight into the agent's context. The harness's own skill discovery and invocation are not used. That makes the choice of skills visible and recorded in the ledger, instead of being something the model decides privately. It also keeps ktchn independent of how any harness handles skills. The skill catalogue is text that ktchn reads.

Classification never falls back to letting the agent browse the skill catalogue. A job that labels and inference can't place goes to the general workflow, which runs supervised, or becomes a question to the owner before the run starts. Falling back to the agent would bring back private skill choice in exactly the cases where the kitchen is least sure.
