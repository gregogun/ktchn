ktchn is a software kitchen: the owner hands over jobs and agents carry them out, with every result reviewed before it counts as done. It is a single TypeScript package on Node, managed with pnpm.

## Ground rules

- Use the terms in [GLOSSARY.md](GLOSSARY.md) exactly. Don't invent synonyms in code, comments or docs.
- Settled architecture lives in [docs/adr/](docs/adr/). Follow it; propose a new ADR rather than working around one.

## Layout

- Source lives in `src/`. Tests sit beside the code as `*.test.ts` and run with vitest.

## Checks

Run these before calling work done; CI runs the same set:

- `pnpm format:check`
- `pnpm lint`
- `pnpm types:check`
- `pnpm knip` (unused files, exports and dependencies; delete rather than ignore)
- `pnpm test`

Before review, run a comment pass over the diff (gstack's comment-sicko agent or the no-comments skill). Keep a comment only for a non-obvious why the code can't show. A comment that spans lines is one `/* */` block; lint rejects a run of `//` lines.

A test earns its place by failing when behaviour a caller can see breaks. Don't add tests that compare constants, match generated script text, or repeat a case another layer already covers.

The pre-commit hook (lefthook) formats, lints, typechecks, runs tests and scans staged files for secrets. Don't bypass it with `--no-verify`; fix the finding.

## Commits

We use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, etc.). One logical change per commit.
