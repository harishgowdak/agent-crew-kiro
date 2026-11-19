# agent-crew

A basic multi-agent pipeline (PM → Architect → Developer → Tester → Reviewer)
with a human approval gate in Slack after every role.

```
/crew <idea>
   │
   ▼
 PM ──► [Approve | Request changes | Stop]
   ▼
 Architect ──► [gate]
   ▼
 Developer ──► [gate]
   ▼
 Tester ──► [gate]
   ▼
 Reviewer ──► [gate] ──► done (artifacts in runs/<id>/)
```

Each role gets the idea plus every approved artifact before it. "Request changes"
opens a modal; your notes go back to the same agent, which revises its draft.

## Setup

### 1. Model backend (pick one, set `LLM_PROVIDER`)

**Kiro (`LLM_PROVIDER=kiro`)** — agentic: Developer writes real files and Tester actually runs the tests.

```bash
curl -fsSL https://cli.kiro.dev/install | bash
kiro-cli --version
```

Authenticate **one** of two ways:

- **Login session (recommended, works for enterprise / IAM Identity Center):** run `kiro-cli login`,
  pick **Your organization**, and finish sign-in in the browser (or with the device code). Check with
  `kiro-cli whoami`. Leave `KIRO_API_KEY` empty; headless runs reuse this session.
- **API key:** app.kiro.dev → **API Keys** → **Create key** → put the `ksk_…` value in `KIRO_API_KEY`.
  For enterprise accounts this needs an admin to enable the Kiro web portal (Cloud Sessions) and API keys.

What each role may do with Kiro:

| Role | Workspace access | Kiro flags |
|---|---|---|
| PM, Architect | none (empty scratch dir) | no trusted tools |
| Developer, Tester | read + write + shell in `runs/<id>/workspace` | `--trust-all-tools` (+ `--sandbox` if `KIRO_SANDBOX=true`) |
| Reviewer | read-only in the workspace | `--trust-tools=read_file,grep_search` |

Slack and Anthropic secrets are stripped from the environment before `kiro-cli` is spawned.

**Ollama (`LLM_PROVIDER=ollama`)** — free, local, text-only.

```bash
ollama pull qwen2.5-coder:7b   # or any model you prefer; set OLLAMA_MODEL to match
ollama serve                   # skip if the Ollama app is already running
```

The app checks at startup that Ollama is reachable and the model is pulled.
Set `LLM_PROVIDER=anthropic` (plus `ANTHROPIC_API_KEY`) to switch to Claude later.

### 2. Slack app

1. api.slack.com/apps → **Create New App** → **From a manifest** → pick your workspace → paste `slack-manifest.yml` → Create.
2. **Basic Information → App-Level Tokens → Generate Token and Scopes**, add scope `connections:write` → copy the `xapp-…` token into `SLACK_APP_TOKEN`.
3. **Install App → Install to Workspace → Allow** → copy the **Bot User OAuth Token** (`xoxb-…`) into `SLACK_BOT_TOKEN`.
4. In Slack, create a channel (e.g. `#agent-crew`) and run `/invite @agent-crew-kiro` there.
5. (Optional) To restrict approvers: click a person's profile → ⋮ → **Copy member ID** → add to `APPROVER_USER_IDS`.

### 3. Run

```bash
cp .env.example .env   # fill in the two Slack tokens
npm install
npm run dev
```

In the channel: `/crew-kiro Build a URL shortener with click analytics`

### Troubleshooting

| Symptom | Fix |
|---|---|
| `/crew` says "dispatch_failed" / app didn't respond | The process isn't running, or `SLACK_APP_TOKEN` is wrong |
| `not_in_channel` / `channel_not_found` | Invite the bot to the channel (`/invite @agent-crew-kiro`) |
| `missing_scope` | Add the scope in **OAuth & Permissions**, then **Reinstall to Workspace** |
| Buttons do nothing | **Interactivity & Shortcuts** must be on (the manifest enables it) |
| Outputs cut off or very generic | Use a bigger model, or raise `OLLAMA_NUM_CTX` |
| "Kiro didn't mark its deliverable" | The model skipped the marker lines; output is shown raw. Retry via *Request changes* |
| "Kiro CLI is not signed in" at startup | Run `kiro-cli login`, or set `KIRO_API_KEY` |
| "Kiro Web is not enabled for your enterprise" | Use `kiro-cli login` instead of an API key, or ask your admin to enable Cloud Sessions |

## How generated code is tested

Every role follows `TEST_POLICY` in `src/agents.ts`:

- **Unit tests** (`npm run test:unit`): external services (Postgres, Redis, queues…) sit behind
  interfaces with in-memory fakes, so unit tests run with no Docker and no network.
- **Integration tests** (`npm run test:integration`): start real services themselves with
  Testcontainers and tear them down afterwards. Needs Docker running on this machine.
  If Docker is unavailable, the Tester marks them **SKIPPED**, not failed.

The Architect lists required services in a *Test environment* section, and the Reviewer flags
code that breaks the policy (for example, unit tests that need a real DB, or hard-coded connection strings).
On startup the app logs whether Docker is reachable.

Generated code lives in `runs/<runId>/workspace/`, relative to where you start the app.

## Files

| File | What it does |
|---|---|
| `src/agents.ts` | Role definitions, prompts and `TEST_POLICY`, in pipeline order |
| `src/llm.ts` | Builds each role's prompt and routes it to Kiro, Ollama or Claude |
| `src/kiro.ts` | Spawns `kiro-cli chat --no-interactive` per role in the right folder with the right tool trust |
| `src/orchestrator.ts` | Sequential loop: run role → post → wait at gate → approve / revise / stop |
| `src/store.ts` | In-memory run state; a gate is a Promise resolved by a Slack click |
| `src/slack-ui.ts` | Block Kit: artifact preview, file upload, approval buttons, feedback modal |
| `src/index.ts` | Bolt app (Socket Mode): `/crew` command and gate handlers |

## Known limits of v1 (deliberate)

- State is in memory: restart the process and in-flight runs are lost.
- Strictly sequential; no agent-to-agent back-and-forth.
- With Ollama/Claude, agents only produce text. With Kiro, code is written and run locally but never committed or deployed.

## Next steps

1. **Durable state** — DynamoDB for runs; gates become "waiting" records instead of in-memory Promises.
2. **Step Functions** — each role a Lambda task; gates use `.waitForTaskToken`, and the Slack handler calls `SendTaskSuccess`. Survives restarts, gives retries and an execution graph for free.
3. **Tools per role** — Developer writes to a branch and opens a PR; Tester actually runs `vitest` in a sandbox and feeds real failures to the Reviewer.
4. **Feedback loops** — let the Reviewer send a "BLOCK" back to the Developer automatically before involving a human.
