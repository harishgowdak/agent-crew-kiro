import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { App, type BlockAction, type ButtonAction } from '@slack/bolt';
import { getRole, type RoleId } from './agents.js';
import { runPipeline } from './orchestrator.js';
import { store } from './store.js';
import { feedbackModal } from './slack-ui.js';
import { checkLlm } from './llm.js';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true, // no public URL needed for local dev
});

const APPROVERS = (process.env.APPROVER_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const canApprove = (userId: string) => APPROVERS.length === 0 || APPROVERS.includes(userId);

// ── Start a run: /crew <feature idea> ───────────────────────────────
const COMMAND = process.env.SLACK_COMMAND ?? '/crew';

app.command(COMMAND, async ({ command, ack, client }) => {
  await ack();
  const idea = command.text.trim();
  if (!idea) {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: `Usage: \`${COMMAND} <feature idea>\``,
    });
    return;
  }

  const id = randomUUID().slice(0, 8);
  const root = await client.chat.postMessage({
    channel: command.channel_id,
    text: `:rocket: *Run ${id}* started by <@${command.user_id}>\n>${idea}`,
  });

  const run = store.create({
    id,
    idea,
    channel: command.channel_id,
    threadTs: root.ts!,
    startedBy: command.user_id,
    outputs: {},
  });

  void runPipeline(app, run); // runs in background; gates resolve via button handlers
});

// ── Gate buttons ────────────────────────────────────────────────────
function parse(body: BlockAction) {
  const action = body.actions[0] as ButtonAction;
  return JSON.parse(action.value!) as { runId: string; role: RoleId };
}

async function guard(body: BlockAction, client: App['client']) {
  if (canApprove(body.user.id)) return true;
  await client.chat.postEphemeral({
    channel: body.channel!.id,
    user: body.user.id,
    text: ':no_entry: You are not an approver for this crew.',
  });
  return false;
}

/** Replace the buttons with a status line so nobody can double-click. */
async function closeGate(body: BlockAction, client: App['client'], status: string) {
  await client.chat.update({
    channel: body.channel!.id,
    ts: body.message!.ts,
    text: status,
    blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: status }] }],
  });
}

app.action<BlockAction>('gate_approve', async ({ ack, body, client }) => {
  await ack();
  if (!(await guard(body, client))) return;
  const { runId, role } = parse(body);
  if (store.decide(runId, role, { kind: 'approve', by: body.user.id })) {
    await closeGate(body, client, `:white_check_mark: Approved by <@${body.user.id}>`);
  }
});

app.action<BlockAction>('gate_stop', async ({ ack, body, client }) => {
  await ack();
  if (!(await guard(body, client))) return;
  const { runId, role } = parse(body);
  if (store.decide(runId, role, { kind: 'stop', by: body.user.id })) {
    await closeGate(body, client, `:octagonal_sign: Stopped by <@${body.user.id}>`);
  }
});

app.action<BlockAction>('gate_changes', async ({ ack, body, client }) => {
  await ack();
  if (!(await guard(body, client))) return;
  const { runId, role } = parse(body);
  const meta = getRole(role)!;
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      ...feedbackModal(runId, role, meta.name),
      // carry the gate message so we can close it on submit
      private_metadata: JSON.stringify({ runId, role, channel: body.channel!.id, ts: body.message!.ts }),
    },
  });
});

app.view('gate_feedback', async ({ ack, view, body, client }) => {
  await ack();
  const { runId, role, channel, ts } = JSON.parse(view.private_metadata);
  const notes = view.state.values.notes.value.value ?? '';
  if (store.decide(runId, role, { kind: 'changes', by: body.user.id, notes })) {
    const status = `:memo: Changes requested by <@${body.user.id}>`;
    await client.chat.update({
      channel,
      ts,
      text: status,
      blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: status }] }],
    });
  }
});

for (const key of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']) {
  if (!process.env[key]) throw new Error(`Missing ${key} in .env`);
}
const llm = await checkLlm();
await app.start();
console.log(`⚡ agent-crew is running (Socket Mode) using ${llm}. Try: ${COMMAND} <idea>`);
