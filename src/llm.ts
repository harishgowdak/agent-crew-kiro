import Anthropic from '@anthropic-ai/sdk';
import type { Role } from './agents.js';
import { callKiro, checkKiro } from './kiro.js';

const PROVIDER = (process.env.LLM_PROVIDER ?? 'ollama').toLowerCase();

const OLLAMA_HOST = (process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:7b';
// Later roles see every earlier artifact, so give the model room.
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? 16384);

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5';

export interface PriorOutput {
  role: Role;
  content: string;
}

/**
 * Runs one role. Context = the idea + every approved artifact so far
 * (+ human feedback if changes were requested).
 */
export async function runRole(
  runId: string,
  role: Role,
  idea: string,
  prior: PriorOutput[],
  feedback?: { previous: string; notes: string },
): Promise<string> {
  const context = prior
    .map((p) => `<artifact role="${p.role.name}">\n${p.content}\n</artifact>`)
    .join('\n\n');

  let user = `<feature_idea>\n${idea}\n</feature_idea>\n\n${context}\n\nProduce your ${role.name} deliverable now.`;

  if (feedback) {
    user += `\n\n<your_previous_draft>\n${feedback.previous}\n</your_previous_draft>
<human_feedback>\n${feedback.notes}\n</human_feedback>
Revise your previous draft to address the feedback. Output the full revised deliverable.`;
  }

  if (PROVIDER === 'kiro') return callKiro(role, runId, user);
  if (PROVIDER === 'anthropic') return callAnthropic(role, user);
  return callOllama(role, user);
}

// ── Ollama (local) ──────────────────────────────────────────────────
// Streams the response: local models can take minutes, and a non-streaming
// request would hit Node's default 5-minute headers timeout.
async function callOllama(role: Role, user: string): Promise<string> {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: true,
      messages: [
        { role: 'system', content: role.system },
        { role: 'user', content: user },
      ],
      options: { num_ctx: OLLAMA_NUM_CTX, num_predict: role.maxTokens, temperature: 0.3 },
    }),
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama ${res.status}: ${body || res.statusText} (is "${OLLAMA_MODEL}" pulled?)`);
  }

  // Response is NDJSON: one {"message":{"content":"..."},"done":false} per line.
  const decoder = new TextDecoder();
  let buffer = '';
  let out = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(`Ollama: ${msg.error}`);
      out += msg.message?.content ?? '';
    }
  }
  return stripThinking(out).trim();
}

/** Reasoning models (deepseek-r1, qwen3…) may emit <think> blocks; drop them. */
function stripThinking(text: string) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '');
}

// ── Anthropic (optional) ────────────────────────────────────────────
let anthropic: Anthropic | undefined;
async function callAnthropic(role: Role, user: string): Promise<string> {
  anthropic ??= new Anthropic(); // reads ANTHROPIC_API_KEY
  const res = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: role.maxTokens,
    system: role.system,
    messages: [{ role: 'user', content: user }],
  });
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** Fail fast at startup if Ollama isn't running or the model is missing. */
export async function checkLlm() {
  if (PROVIDER === 'kiro') return checkKiro();
  if (PROVIDER === 'anthropic') return `Anthropic (${ANTHROPIC_MODEL})`;
  const res = await fetch(`${OLLAMA_HOST}/api/tags`).catch(() => {
    throw new Error(`Can't reach Ollama at ${OLLAMA_HOST}. Start it with: ollama serve`);
  });
  const { models = [] } = (await res.json()) as { models?: { name: string }[] };
  const names = models.map((m) => m.name);
  const wanted = OLLAMA_MODEL.includes(':') ? OLLAMA_MODEL : `${OLLAMA_MODEL}:latest`;
  if (!names.includes(wanted)) {
    throw new Error(
      `Model "${OLLAMA_MODEL}" not found. Run: ollama pull ${OLLAMA_MODEL}\nInstalled: ${names.join(', ') || '(none)'}`,
    );
  }
  return `Ollama (${OLLAMA_MODEL} @ ${OLLAMA_HOST})`;
}
