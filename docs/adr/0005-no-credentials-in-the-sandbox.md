# No credentials in the sandbox

Nothing secret enters a sandbox. Model access goes through a proxy on the host that adds the real API key, so the sandbox holds only a proxy URL. The proxy is also where model calls get logged to the ledger and where budgets are enforced. The agent commits locally and never gets GitHub credentials. ktchn pushes and opens PRs only after review. Before a run starts, ktchn refuses anything that would let a secret in: the head branch strategy, secret files in the copy-in list, and secrets found by a scan of the worktree.
