# agent-crew

Multi-agent pipeline (PM → Architect → Developer → Tester → Reviewer) with a human
approval gate in Slack after every role. TypeScript, ESM, Node 22, Slack Bolt (Socket Mode).

## Commands
- `npm run dev` — run with watch (needs `.env`, see `.env.example`)
- `npm run typecheck` — must pass before any change is considered done

## Layout
- `src/agents.ts` — role definitions, prompts, `TEST_POLICY`, `DOCKER_POLICY` (every generated
  project must ship a Dockerfile + docker-compose.yml; Tester verifies it builds/starts),
  per-role workspace access (none/read/write)
- `src/llm.ts` — builds the prompt for a role and routes to a provider (`LLM_PROVIDER`: kiro | ollama | anthropic)
- `src/kiro.ts` — spawns `kiro-cli chat --v3 --no-interactive` per role; extracts output between
  `<<<DELIVERABLE` / `DELIVERABLE>>>`; strips SLACK_* and ANTHROPIC_API_KEY from the child env
- `src/orchestrator.ts` — sequential loop: run role → post to Slack → await gate → approve / revise / stop.
  Exception: Reviewer's gate is skipped unless its verdict is a clean `VERDICT: SHIP`
  (see its prompts in `agents.ts`) — `SHIP_WITH_FIXES`/`BLOCK` loop straight back to Developer
  with the review as feedback, up to `MAX_REVISIONS` auto-fix rounds before falling back to a
  human gate.
- `src/store.ts` — in-memory run state; a gate is a Promise resolved by a Slack button; also
  `runDir(run)` (resolves to a named project folder or a throwaway `runs/<id>/`) and `ensureProjectDir`
- `src/slack-ui.ts` — Block Kit messages, file upload, feedback modal
- `src/index.ts` — Bolt app, slash command (`SLACK_COMMAND`), gate handlers
- `runs/<runId>/` — generated at runtime for one-off (unnamed) runs: approved outputs + `workspace/`
  (agent-written code). Never edit or commit.

## Named projects
- `/crew <idea>` starts a one-off run under `runs/<runId>/` (same as before).
- `/crew <project-name>: <idea>` starts or resumes a named project. Its folder lives under
  `PROJECTS_DIR` (default: a `kiro-crew-projects` folder next to this repo, see `.env.example`),
  is created if it doesn't exist yet, and keeps the same `workspace/` across runs so the Developer/
  Tester can keep improving the same codebase. Each run's `pm.md` / `architect.md` / etc. are
  overwritten in place with the latest approved output — no history is kept.
- On a resumed project, `orchestrator.ts`'s `loadPreviousContext` feeds the project's last approved
  `pm.md` / `architect.md` / `reviewer.md` to every role as prior context (PM/Architect/Reviewer
  have no workspace access, so without this they'd draft as if starting from scratch).

## Conventions
- Imports use `.js` extensions (NodeNext resolution).
- New providers implement the same shape as `callKiro` / `callOllama` and are selected in `runRole`.
- Agents with shell access must only ever run inside `runDir(run)/workspace` (`runs/<runId>/workspace`
  for one-off runs, `<PROJECTS_DIR>/<project-name>/workspace` for named projects).
- Keep v1 simple: no database, no queue; state is in memory by design.
