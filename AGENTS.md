ktchn is a software kitchen: the owner hands over jobs and agents carry them out, with every result reviewed before it counts as done. It is a single TypeScript package on Node, managed with pnpm.

## Ground rules

- Use the terms in [GLOSSARY.md](GLOSSARY.md) exactly. Don't invent synonyms in code, comments or docs.
- Settled architecture lives in [docs/adr/](docs/adr/). Follow it; propose a new ADR rather than working around one.

## Checks

Run these before calling work done; CI runs the same set:

- `pnpm format:check`
- `pnpm lint`
- `pnpm types:check`
- `pnpm knip` (unused files, exports and dependencies; delete rather than ignore)
- `pnpm test`

The pre-commit hook (lefthook) formats, lints, typechecks, runs tests and scans staged files for secrets. Don't bypass it with `--no-verify`; fix the finding.
