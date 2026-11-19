# agent-crew

Multi-agent pipeline (PM → Architect → Developer → Tester → Reviewer) with a human
approval gate in Slack after every role. TypeScript, ESM, Node 22, Slack Bolt (Socket Mode).

## Commands
- `npm run dev` — run with watch (needs `.env`, see `.env.example`)
- `npm run typecheck` — must pass before any change is considered done

## Layout
- `src/agents.ts` — role definitions, prompts, `TEST_POLICY`, per-role workspace access (none/read/write)
- `src/llm.ts` — builds the prompt for a role and routes to a provider (`LLM_PROVIDER`: kiro | ollama | anthropic)
- `src/kiro.ts` — spawns `kiro-cli chat --v3 --no-interactive` per role; extracts output between
  `<<<DELIVERABLE` / `DELIVERABLE>>>`; strips SLACK_* and ANTHROPIC_API_KEY from the child env
- `src/orchestrator.ts` — sequential loop: run role → post to Slack → await gate → approve / revise / stop
- `src/store.ts` — in-memory run state; a gate is a Promise resolved by a Slack button
- `src/slack-ui.ts` — Block Kit messages, file upload, feedback modal
- `src/index.ts` — Bolt app, slash command (`SLACK_COMMAND`), gate handlers
- `runs/<runId>/` — generated at runtime: approved outputs + `workspace/` (agent-written code). Never edit or commit.

## Conventions
- Imports use `.js` extensions (NodeNext resolution).
- New providers implement the same shape as `callKiro` / `callOllama` and are selected in `runRole`.
- Agents with shell access must only ever run inside `runs/<runId>/workspace`.
- Keep v1 simple: no database, no queue; state is in memory by design.
