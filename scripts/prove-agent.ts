import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { DEFAULT_MODEL, openAgent, readOpenRouterKey } from '../src/agent.ts';
import { ensureClone } from '../src/clone.ts';
import { collect, openSandbox, removeSandboxes, seed } from '../src/sandbox.ts';
import { git, makeTempRepo } from './temp-repo.ts';

const repo = makeTempRepo();
const home = mkdtempSync(join(tmpdir(), 'ktchn-agent-home-'));
const clone = ensureClone({
  home,
  runId: 'proof-agent',
  source: repo,
  base: git(repo, 'rev-parse', 'HEAD'),
  branch: 'ktchn/proof-agent',
});
const mainBefore = git(repo, 'rev-parse', 'main');
const storeDir = mkdtempSync(join(tmpdir(), 'ktchn-agent-'));
const jobText = [
  'Use the bash tool for each step, one tool call per step, in this order:',
  '1. echo hi > hello.txt && git add hello.txt && git commit -qm hello',
  '2. git update-ref refs/heads/main HEAD',
  'Then reply with the exit status of each step, and stop.',
].join('\n');

const opened = await openSandbox({
  runId: 'proof-agent',
  name: 'ktchn-proof-agent-r1',
  image: process.env.KTCHN_IMAGE ?? 'sandcastle-test:latest',
  volume: true,
  piEnv: true,
});
await seed(opened, {
  repo: clone,
  ref: 'refs/heads/ktchn/proof-agent',
  branch: 'ktchn/proof-agent',
});
try {
  const out: string[] = [];
  await opened.env?.exec(
    'env',
    { onOutput: (chunk) => out.push(chunk) },
    BACKGROUND_CONTEXT
  );
  const sandboxEnv = out.join('');
  assert(!/openrouter|sk-or-/i.test(sandboxEnv), 'no model key in sandbox');
  console.log('sandbox env has no OpenRouter key or sk-or- value');

  const agent = await openAgent({
    runId: 'proof',
    storePath: join(storeDir, 'session.sqlite'),
    env: opened.env as NonNullable<typeof opened.env>,
    model: process.env.KTCHN_MODEL ?? DEFAULT_MODEL,
    jobText,
    apiKey: readOpenRouterKey(),
  });
  try {
    const outcome = await agent.run({ input: { kind: 'job' }, number: 1 });
    console.log('outcome', outcome.event.type);
    for (const call of outcome.calls)
      console.log('model call', JSON.stringify(call));
    assert(outcome.calls.length > 0, 'model calls read from Durable');
    const cost = outcome.calls.reduce((sum, c) => sum + c.cost, 0);
    console.log('total cost', cost.toFixed(6));
  } finally {
    await agent.close();
  }
  await collect({
    sandbox: opened,
    repo: clone,
    branch: 'ktchn/proof-agent',
  });
} finally {
  await opened.close();
  removeSandboxes('proof-agent', true);
}

const store = new DatabaseSync(join(storeDir, 'session.sqlite'));
for (const row of store
  .prepare('SELECT record FROM entries ORDER BY id')
  .all()) {
  const entry = JSON.parse(String(row.record)) as {
    kind: string;
    model?: { content?: unknown }[];
  };
  if (entry.kind === 'pi.tool-result' || entry.kind === 'pi.assistant') {
    console.log(
      entry.kind,
      JSON.stringify(entry.model?.[0]?.content).slice(0, 300)
    );
  }
}
store.close();

const head = git(clone, 'rev-parse', 'refs/heads/ktchn/proof-agent');
console.log(
  'run branch in the clone',
  head,
  'log',
  git(clone, 'log', '--oneline', '-1', head)
);
assert.notEqual(head, mainBefore, 'commit landed on the run branch');
assert.equal(
  git(repo, 'rev-parse', 'main'),
  mainBefore,
  "the owner's main did not move"
);
console.log("the owner's main unchanged", mainBefore);
rmSync(home, { recursive: true, force: true });
rmSync(repo, { recursive: true, force: true });
rmSync(storeDir, { recursive: true, force: true });
