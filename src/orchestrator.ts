import type { App } from '@slack/bolt';
import { PIPELINE, type Role } from './agents.js';
import { runRole, type PriorOutput } from './llm.js';
import { saveArtifact, waitForDecision, type Run } from './store.js';
import { approvalBlocks, postArtifact } from './slack-ui.js';

const MAX_REVISIONS = Number(process.env.MAX_REVISIONS ?? 3);

/**
 * Sequential pipeline with a human gate after every role:
 *   PM → [gate] → Architect → [gate] → Developer → [gate] → Tester → [gate] → Reviewer → [gate]
 */
export async function runPipeline(app: App, run: Run) {
  const say = (text: string) =>
    app.client.chat.postMessage({ channel: run.channel, thread_ts: run.threadTs, text });

  const approved: PriorOutput[] = [];

  try {
    for (const role of PIPELINE) {
      const ok = await runStage(app, run, role, approved, say);
      if (!ok) {
        await say(`:octagonal_sign: Run stopped at *${role.name}*.`);
        return;
      }
      approved.push({ role, content: run.outputs[role.id]! });
    }
    await say(`:tada: All stages approved. Artifacts saved under \`runs/${run.id}/\`.`);
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
): Promise<boolean> {
  let feedback: { previous: string; notes: string } | undefined;

  for (let attempt = 0; attempt <= MAX_REVISIONS; attempt++) {
    await say(`${role.emoji} *${role.name}* is working${feedback ? ' on a revision' : ''}…`);

    const output = await runRole(run.id, role, run.idea, approved, feedback);
    run.outputs[role.id] = output;
    await saveArtifact(run.id, role.id, output);

    await postArtifact(app, run, role, output);
    await app.client.chat.postMessage({
      channel: run.channel,
      thread_ts: run.threadTs,
      text: `Approve ${role.name} output?`,
      blocks: approvalBlocks(run.id, role),
    });

    const decision = await waitForDecision(run, role.id);

    if (decision.kind === 'approve') {
      await say(`:white_check_mark: <@${decision.by}> approved *${role.name}*.`);
      return true;
    }
    if (decision.kind === 'stop') return false;

    await say(`:memo: <@${decision.by}> requested changes: _${decision.notes}_`);
    feedback = { previous: output, notes: decision.notes };
  }

  await say(`:warning: ${role.name} hit the revision limit (${MAX_REVISIONS}).`);
  return false;
}
