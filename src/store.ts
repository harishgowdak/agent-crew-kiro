import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RoleId } from './agents.js';

export type Decision =
  | { kind: 'approve'; by: string }
  | { kind: 'changes'; by: string; notes: string }
  | { kind: 'stop'; by: string };

export interface Run {
  id: string;
  idea: string;
  channel: string;
  threadTs: string;
  startedBy: string;
  outputs: Partial<Record<RoleId, string>>;
  /** Slug naming a resumable project folder under PROJECTS_DIR; omitted for one-off runs. */
  project?: string;
  /** Resolver for the gate currently waiting on a human. */
  pending?: { role: RoleId; resolve: (d: Decision) => void };
}

// In-memory for v1. Swap for DynamoDB/Redis once runs must survive restarts.
const runs = new Map<string, Run>();

export const store = {
  create(run: Run) {
    runs.set(run.id, run);
    return run;
  },
  get(id: string) {
    return runs.get(id);
  },
  /** Called from Slack handlers; unblocks the orchestrator. */
  decide(id: string, role: RoleId, decision: Decision): boolean {
    const run = runs.get(id);
    if (!run?.pending || run.pending.role !== role) return false; // stale/duplicate click
    const { resolve } = run.pending;
    run.pending = undefined;
    resolve(decision);
    return true;
  },
};

export function waitForDecision(run: Run, role: RoleId): Promise<Decision> {
  return new Promise((resolve) => {
    run.pending = { role, resolve };
  });
}

/** Named projects live as siblings of this repo so they survive `runs/` and can be resumed by name. */
const PROJECTS_DIR = process.env.PROJECTS_DIR ?? path.resolve(process.cwd(), '..', 'kiro-crew-projects');

/** Root folder for a run's artifacts and workspace: a named project, or a throwaway `runs/<id>/`. */
export function runDir(run: Run) {
  return run.project ? path.join(PROJECTS_DIR, run.project) : path.join('runs', run.id);
}

/** Creates the project folder if it's new. Returns true if it already existed (a resume). */
export async function ensureProjectDir(project: string): Promise<boolean> {
  const dir = path.join(PROJECTS_DIR, project);
  const existed = await stat(dir).then(() => true, () => false);
  await mkdir(dir, { recursive: true });
  return existed;
}

/** Keep every artifact on disk so nothing is lost to Slack truncation. */
export async function saveArtifact(run: Run, role: RoleId, content: string) {
  const dir = runDir(run);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${role}.md`);
  await writeFile(file, content, 'utf8');
  return file;
}
