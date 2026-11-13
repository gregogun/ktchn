import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { loadWorkflow, skillsFor } from './workflow.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ktchn-workflow-'));
  dirs.push(d);
  return d;
};

const addSkill = (catalogue: string, name: string, text: string) => {
  mkdirSync(join(catalogue, name), { recursive: true });
  writeFileSync(join(catalogue, name, 'SKILL.md'), text);
};

const world = (workflow?: string) => {
  const dir = tmp();
  const a = tmp();
  const b = tmp();
  if (workflow !== undefined) writeFileSync(join(dir, 'flow.md'), workflow);
  return {
    dir,
    a,
    b,
    load: (name = 'flow') => loadWorkflow(name, { dir, catalogue: [a, b] }),
  };
};

const TDD = '---\nname: tdd\n---\nWrite the test first.\n';
const LINT = 'Lint rules, no frontmatter.\n';

describe('loadWorkflow', () => {
  test('loads the method and each skill with its whole file text', () => {
    const w = world(
      '---\nskills:\n  - tdd\nfindings-skills: [lint]\n---\n\nDo it well.\n\n'
    );
    addSkill(w.a, 'tdd', TDD);
    addSkill(w.b, 'lint', LINT);
    expect(w.load()).toEqual({
      name: 'flow',
      method: 'Do it well.',
      skills: [{ name: 'tdd', text: TDD }],
      findingsSkills: [{ name: 'lint', text: LINT }],
    });
  });

  test('a file with no frontmatter is all method', () => {
    const w = world('Just a method.\n');
    expect(w.load()).toMatchObject({ method: 'Just a method.', skills: [] });
  });

  test('the first catalogue folder that has a skill wins', () => {
    const w = world('---\nskills: [tdd]\n---\nm');
    addSkill(w.a, 'tdd', 'from a');
    addSkill(w.b, 'tdd', 'from b');
    expect(w.load().skills).toEqual([{ name: 'tdd', text: 'from a' }]);
  });

  test('missing skills are refused with one message naming each and the workflow', () => {
    const w = world(
      '---\nskills: [tdd, lint-rules]\nfindings-skills: [x]\n---\nm'
    );
    addSkill(w.a, 'x', 'x');
    expect(() => w.load()).toThrow(
      `workflow flow names skills not in the skill catalogue: tdd, lint-rules (catalogue: ${w.a}, ${w.b})`
    );
  });

  test('an empty catalogue is named as empty with its env var', () => {
    const w = world('---\nskills: [tdd]\n---\nm');
    expect(() => loadWorkflow('flow', { dir: w.dir, catalogue: [] })).toThrow(
      /tdd.*empty.*KTCHN_SKILL_CATALOGUE/
    );
  });

  test.each([
    ['an unknown key', '---\nextra: [a]\n---\nm', /flow\.md.*"extra"/],
    ['a non-list value', '---\nskills: tdd\n---\nm', /flow\.md.*"skills"/],
    [
      'a non-string entry',
      '---\nfindings-skills: [1]\n---\nm',
      /flow\.md.*"findings-skills"/,
    ],
  ])('%s is refused naming the file and key', (_, text, message) => {
    expect(() => world(text).load()).toThrow(message);
  });

  test('a missing workflow is refused', () => {
    const w = world();
    expect(() => w.load('nope')).toThrow(`no workflow named nope in ${w.dir}`);
  });

  test.each(['../flow', 'a/b', '..', 'a\\b'])(
    'the path-like name %s is refused',
    (name) => {
      expect(() => world('m').load(name)).toThrow(/not a workflow name/);
    }
  );
});

describe('skillsFor', () => {
  const workflow = {
    name: 'flow',
    method: 'm',
    skills: [{ name: 'a', text: 'A' }],
    findingsSkills: [{ name: 'b', text: 'B' }],
  };

  test('the first round gets the workflow skills and not the findings skills', () => {
    expect(skillsFor(workflow, { kind: 'job' })).toEqual(workflow.skills);
  });

  test('a round from review findings gets the findings skills', () => {
    expect(skillsFor(workflow, { kind: 'findings', findings: 'f' })).toEqual(
      workflow.findingsSkills
    );
  });

  test('a round from the owner answer gets none', () => {
    expect(skillsFor(workflow, { kind: 'answer', answer: 'a' })).toEqual([]);
  });
});
