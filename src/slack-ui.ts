import type { App } from '@slack/bolt';
import type { Role } from './agents.js';
import type { Run } from './store.js';

const PREVIEW_CHARS = 2800; // Slack section blocks cap at 3000 chars

/** Short preview inline + full artifact as a file in the thread. */
export async function postArtifact(app: App, run: Run, role: Role, content: string) {
  const preview =
    content.length > PREVIEW_CHARS ? content.slice(0, PREVIEW_CHARS) + '\n…_(truncated, see file)_' : content;

  await app.client.chat.postMessage({
    channel: run.channel,
    thread_ts: run.threadTs,
    text: `${role.name} output`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `${role.name} output` } },
      { type: 'section', text: { type: 'mrkdwn', text: preview } },
    ],
  });

  await app.client.files.uploadV2({
    channel_id: run.channel,
    thread_ts: run.threadTs,
    filename: `${run.id}-${role.id}.md`,
    title: `${role.name} — full output`,
    content,
  });
}

export function approvalBlocks(runId: string, role: Role) {
  const value = JSON.stringify({ runId, role: role.id });
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Gate:* review the *${role.name}* output above.` },
    },
    {
      type: 'actions',
      block_id: 'gate',
      elements: [
        { type: 'button', action_id: 'gate_approve', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, value },
        { type: 'button', action_id: 'gate_changes', text: { type: 'plain_text', text: 'Request changes' }, value },
        {
          type: 'button',
          action_id: 'gate_stop',
          style: 'danger',
          text: { type: 'plain_text', text: 'Stop' },
          value,
          confirm: {
            title: { type: 'plain_text', text: 'Stop this run?' },
            text: { type: 'plain_text', text: 'The pipeline will end here.' },
            confirm: { type: 'plain_text', text: 'Stop' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        },
      ],
    },
  ];
}

export function feedbackModal(runId: string, roleId: string, roleName: string) {
  return {
    type: 'modal' as const,
    callback_id: 'gate_feedback',
    private_metadata: JSON.stringify({ runId, role: roleId }),
    title: { type: 'plain_text' as const, text: 'Request changes' },
    submit: { type: 'plain_text' as const, text: 'Send to agent' },
    blocks: [
      {
        type: 'input',
        block_id: 'notes',
        label: { type: 'plain_text', text: `What should the ${roleName} change?` },
        element: { type: 'plain_text_input', action_id: 'value', multiline: true },
      },
    ],
  };
}
