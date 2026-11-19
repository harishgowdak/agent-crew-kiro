import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { App } from '@slack/bolt';
import { getRole, PIPELINE, type Role, type RoleId } from './agents.js';
import { runRole, type PriorOutput } from './llm.js';
import { runDir, saveArtifact, waitForDecision, type Run } from './store.js';
import { approvalBlocks, postArtifact } from './slack-ui.js';

const MAX_REVISIONS = Number(process.env.MAX_REVISIONS ?? 3);

/**
 * On a resumed project, PM/Architect/Reviewer have no workspace access and would
 * otherwise draft as if starting from scratch. Feed them the project's last approved
 * PRD/design/review so they build on the existing feature set instead of ignoring it.
 * Developer/Tester don't need this: they see the real code via the shared workspace.
 */
async function loadPreviousContext(run: Run): Promise<PriorOutput[]> {
  if (!run.project) return [];
  const dir = runDir(run);
  const out: PriorOutput[] = [];
  for (const id of ['pm', 'architect', 'reviewer'] satisfies RoleId[]) {
    try {
      const content = await readFile(path.join(dir, `${id}.md`), 'utf8');
      out.push({
        role: getRole(id)!,
        content: `_(From an earlier run on this project — the existing state before this request.)_\n\n${content}`,
      });
    } catch {
      // no previous artifact for this role yet (new project, or it never ran)
    }
  }
  return out;
}

/**
 * Reviewer must start its deliverable with exactly `VERDICT: SHIP` / `SHIP_WITH_FIXES` / `BLOCK`
 * (see its prompts in agents.ts). Anything unparseable falls back to the normal human gate
 * instead of auto-looping, so a malformed verdict can't get stuck retrying forever.
 */
function parseReviewVerdict(output: string): 'SHIP' | 'NEEDS_FIX' | 'UNKNOWN' {
  const m = /^\s*VERDICT:\s*(SHIP_WITH_FIXES|BLOCK|SHIP)\b/im.exec(output);
  if (!m) return 'UNKNOWN';
  return m[1] === 'SHIP' ? 'SHIP' : 'NEEDS_FIX';
}

type StageResult = 'approved' | 'stopped' | 'needs-fix';

/**
 * Sequential pipeline with a human gate after every role:
 *   PM → [gate] → Architect → [gate] → Developer → [gate] → Tester → [gate] → Reviewer → [gate]
 * Exception: if Reviewer's verdict isn't a clean SHIP, its gate is skipped and its findings
 * go straight back to Developer for a fix-up pass (Developer → Tester → Reviewer again),
 * up to MAX_REVISIONS auto-fix rounds before surfacing it to a human instead.
 */
export async function runPipeline(app: App, run: Run) {
  const say = (text: string) =>
    app.client.chat.postMessage({ channel: run.channel, thread_ts: run.threadTs, text });

  let approved: PriorOutput[] = await loadPreviousContext(run);
  const devIndex = PIPELINE.findIndex((r) => r.id === 'developer');

  try {
    let i = 0;
    let autoFixes = 0;
    let seedFeedback: { previous: string; notes: string } | undefined;

    while (i < PIPELINE.length) {
      const role = PIPELINE[i];
      const result = await runStage(app, run, role, approved, say, seedFeedback);
      seedFeedback = undefined;

      if (result === 'stopped') {
        await say(`:octagonal_sign: Run stopped at *${role.name}*.`);
        return;
      }

      approved = [...approved.filter((p) => p.role.id !== role.id), { role, content: run.outputs[role.id]! }];

      if (result === 'needs-fix') {
        if (autoFixes >= MAX_REVISIONS) {
          await say(`:warning: Reviewer still flags issues after ${MAX_REVISIONS} auto-fix round(s); stopping for a human look.`);
          return;
        }
        autoFixes++;
        approved = approved.filter((p) => PIPELINE.findIndex((r) => r.id === p.role.id) < devIndex);
        seedFeedback = { previous: run.outputs.developer!, notes: run.outputs.reviewer! };
        i = devIndex;
        continue;
      }

      i++;
    }
    await say(`:tada: All stages approved. Artifacts saved under \`${runDir(run)}\`.`);
  } catch (err) {
    console.error(err);
    await say(`:x: Run failed: ${(err as Error).message}`);
  }
}

async function runStage(
  app: App,
  run: Run,
  role: Role,
  approved: PriorOutput[],
  say: (t: string) => Promise<unknown>,
  initialFeedback?: { previous: string; notes: string },
): Promise<StageResult> {
  let feedback = initialFeedback;

  for (let attempt = 0; attempt <= MAX_REVISIONS; attempt++) {
    await say(`${role.emoji} *${role.name}* is working${feedback ? ' on a revision' : ''}…`);

    const output = await runRole(runDir(run), role, run.idea, approved, feedback);
    run.outputs[role.id] = output;
    await saveArtifact(run, role.id, output);
    await postArtifact(app, run, role, output);

    if (role.id === 'reviewer') {
      const verdict = parseReviewVerdict(output);
      if (verdict === 'NEEDS_FIX') {
        await say(`:arrows_counterclockwise: Reviewer requested fixes — sending its findings back to *Developer*.`);
        return 'needs-fix';
      }
    }

    await app.client.chat.postMessage({
      channel: run.channel,
      thread_ts: run.threadTs,
      text: `Approve ${role.name} output?`,
      blocks: approvalBlocks(run.id, role),
    });

    const decision = await waitForDecision(run, role.id);

    if (decision.kind === 'approve') {
      await say(`:white_check_mark: <@${decision.by}> approved *${role.name}*.`);
      return 'approved';
    }
    if (decision.kind === 'stop') return 'stopped';

    await say(`:memo: <@${decision.by}> requested changes: _${decision.notes}_`);
    feedback = { previous: output, notes: decision.notes };
  }

  await say(`:warning: ${role.name} hit the revision limit (${MAX_REVISIONS}).`);
  return 'stopped';
}
