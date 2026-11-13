import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { FreshAgentInput } from './run-machine.ts';

export type Skill = { name: string; text: string };

export type Workflow = {
  name: string;
  method: string;
  skills: readonly Skill[];
  findingsSkills: readonly Skill[];
};

const KEYS = ['skills', 'findings-skills'];
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

const names = (file: string, key: string, value: unknown): string[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${file}: "${key}" must be a list of skill names`);
  }
  return value.map((entry: unknown) => {
    if (typeof entry !== 'string') {
      throw new Error(`${file}: "${key}" must hold only skill names (strings)`);
    }
    return entry;
  });
};

const findSkill = (catalogue: readonly string[], name: string) => {
  for (const folder of catalogue) {
    const file = join(folder, name, 'SKILL.md');
    if (existsSync(file)) return { name, text: readFileSync(file, 'utf8') };
  }
  return undefined;
};

export const loadWorkflow = (
  name: string,
  opts: { dir: string; catalogue: readonly string[] }
): Workflow => {
  if (name === '' || /[\\/]/.test(name) || name.includes('..')) {
    throw new Error(`"${name}" is not a workflow name`);
  }
  const file = join(opts.dir, `${name}.md`);
  if (!existsSync(file)) {
    throw new Error(`no workflow named ${name} in ${opts.dir}`);
  }
  const source = readFileSync(file, 'utf8');
  const match = FRONTMATTER.exec(source);
  const front: unknown = (match && parse(match[1] ?? '')) ?? {};
  if (typeof front !== 'object' || front === null || Array.isArray(front)) {
    throw new Error(`${file}: the frontmatter must be keys and values`);
  }
  const fields = front as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!KEYS.includes(key)) {
      throw new Error(
        `${file}: unknown key "${key}" (allowed: ${KEYS.join(', ')})`
      );
    }
  }
  const wanted = names(file, 'skills', fields.skills);
  const wantedOnFindings = names(
    file,
    'findings-skills',
    fields['findings-skills']
  );

  const found = new Map<string, Skill>();
  const missing: string[] = [];
  for (const skill of new Set([...wanted, ...wantedOnFindings])) {
    const hit = findSkill(opts.catalogue, skill);
    if (hit) found.set(skill, hit);
    else missing.push(skill);
  }
  if (missing.length > 0) {
    const where =
      opts.catalogue.length === 0
        ? 'the catalogue is empty; set KTCHN_SKILL_CATALOGUE to folders of skills'
        : `catalogue: ${opts.catalogue.join(', ')}`;
    throw new Error(
      `workflow ${name} names skills not in the skill catalogue: ${missing.join(', ')} (${where})`
    );
  }
  const pick = (list: readonly string[]) =>
    list.map((skill) => found.get(skill) as Skill);
  return {
    name,
    method: (match ? (match[2] ?? '') : source).trim(),
    skills: pick(wanted),
    findingsSkills: pick(wantedOnFindings),
  };
};

const chosen: {
  [K in FreshAgentInput['kind']]: (workflow: Workflow) => readonly Skill[];
} = {
  job: (workflow) => workflow.skills,
  findings: (workflow) => workflow.findingsSkills,
  answer: () => [],
};

/* All rounds of a run share one durable session, so the first round's method
   and skills stay in context; a later round brings only what it adds.
*/
export const skillsFor = (
  workflow: Workflow,
  input: FreshAgentInput
): readonly Skill[] => chosen[input.kind](workflow);
