import { spawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Role } from './agents.js';

const KIRO_BIN = process.env.KIRO_BIN ?? 'kiro-cli';
const KIRO_MODEL = process.env.KIRO_MODEL; // optional: pin a model
const KIRO_AGENT = process.env.KIRO_AGENT; // optional: a Kiro custom agent for all roles
const KIRO_SANDBOX = process.env.KIRO_SANDBOX === 'true';
const TIMEOUT_MS = Number(process.env.KIRO_TIMEOUT_MS ?? 20 * 60_000);

const OPEN = '<<<DELIVERABLE';
const CLOSE = 'DELIVERABLE>>>';

/** Shared folder per run: Developer writes code, Tester adds tests, Reviewer reads both. */
export function workspaceDir(outDir: string) {
  return path.resolve(outDir, 'workspace');
}

/**
 * Runs one role through Kiro CLI headless mode.
 * `outDir` is the run's or project's root folder (see `runDir` in store.ts).
 * The deliverable is fenced with markers because plain stdout also contains
 * tool-status lines, trust warnings and a credits footer.
 */
export async function callKiro(role: Role, outDir: string, userPrompt: string): Promise<string> {
  // Text-only roles run in an empty scratch dir so they can't see or touch the code.
  const cwd =
    role.workspace === 'none'
      ? path.resolve(outDir, 'scratch', role.id)
      : workspaceDir(outDir);
  await mkdir(cwd, { recursive: true });

  const system = role.workspace === 'none' ? role.system : (role.agenticSystem ?? role.system);
  const toolRule =
    role.workspace === 'none'
      ? 'Do not use any tools. Answer from the context below only.'
      : role.workspace === 'read'
        ? 'You may read files in the current directory. Do not modify anything.'
        : 'You may create/edit files and run commands, but only inside the current directory.';

  const prompt = `${system}

${toolRule}

${userPrompt}

When you are done, output your final deliverable (Markdown) between these exact marker lines, and nothing after them:
${OPEN}
...your deliverable...
${CLOSE}`;

  const args = ['chat', '--v3', '--no-interactive'];
  if (KIRO_AGENT) args.push('--agent', KIRO_AGENT);
  if (KIRO_MODEL) args.push('--model', KIRO_MODEL);
  if (role.workspace === 'write') {
    args.push('--trust-all-tools');
    if (KIRO_SANDBOX) args.push('--sandbox');
  } else if (role.workspace === 'read') {
    args.push('--trust-tools=read_file,grep_search');
  }

  const stdout = await exec(args, prompt, cwd);
  let deliverable = extractDeliverable(stdout);

  if (role.workspace === 'write') {
    deliverable += `\n\n**Files in workspace** (\`${path.relative(process.cwd(), cwd)}\`):\n\`\`\`\n${(await listFiles(cwd)).join('\n') || '(empty)'}\n\`\`\``;
  }
  return deliverable;
}

function exec(args: string[], stdin: string, cwd: string): Promise<string> {
  // Don't hand Slack/Anthropic secrets to an agent that can run shell commands.
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('SLACK_') || k === 'ANTHROPIC_API_KEY') delete env[k];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(KIRO_BIN, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Kiro timed out after ${Math.round(TIMEOUT_MS / 60000)} min`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        e.code === 'ENOENT'
          ? new Error(`"${KIRO_BIN}" not found. Install: curl -fsSL https://cli.kiro.dev/install | bash`)
          : e,
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`kiro-cli exited ${code}: ${stripAnsi(err || out).trim().slice(-800)}`));
    });

    child.stdin.end(stdin); // prompt via stdin: no shell-quoting or arg-length issues
  });
}

export function extractDeliverable(raw: string): string {
  const text = stripAnsi(raw);
  const start = text.lastIndexOf(OPEN);
  if (start >= 0) {
    const end = text.indexOf(CLOSE, start);
    return text.slice(start + OPEN.length, end >= 0 ? end : undefined).trim();
  }
  // Fallback: model ignored the markers. Return stdout minus the credits footer.
  const cleaned = text
    .split('\n')
    .filter((l) => !/^\s*▸\s*Credits:/.test(l))
    .join('\n')
    .trim();
  return `_(Kiro didn't mark its deliverable; showing raw output)_\n\n${cleaned}`;
}

function stripAnsi(s: string) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');
}

async function listFiles(dir: string, base = dir, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'coverage'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await listFiles(p, base, out);
    else out.push(path.relative(base, p));
    if (out.length >= 200) break;
  }
  return out.sort();
}

function run(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const c = spawn(KIRO_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    c.stdout.on('data', (d) => (o += d));
    c.stderr.on('data', (d) => (o += d));
    c.on('error', () =>
      reject(new Error(`"${KIRO_BIN}" not found. Install: curl -fsSL https://cli.kiro.dev/install | bash`)),
    );
    c.on('close', (code) => resolve({ code, out: stripAnsi(o).trim() }));
  });
}

/**
 * Startup check: CLI installed and authenticated.
 * Auth precedence in Kiro CLI: active `kiro-cli login` session → KIRO_API_KEY.
 * So either a logged-in session (works for org / IAM Identity Center accounts)
 * or an API key is enough.
 */
export async function checkKiro() {
  const { out: version } = await run(['--version']);

  let auth: string;
  if (process.env.KIRO_API_KEY) {
    auth = 'API key';
  } else {
    const who = await run(['whoami']);
    if (who.code !== 0) {
      throw new Error(
        'Kiro CLI is not signed in. Run `kiro-cli login` (choose "Your organization" for an enterprise account), ' +
          `or set KIRO_API_KEY.\nkiro-cli whoami said: ${who.out.slice(0, 300)}`,
      );
    }
    auth = 'login session';
  }
  const docker = await dockerAvailable();
  if (!docker) {
    console.warn('⚠️  Docker not reachable: the Tester will skip integration tests (Testcontainers needs Docker).');
  }
  return `Kiro CLI (${version || 'unknown version'}, ${auth}${KIRO_MODEL ? `, model ${KIRO_MODEL}` : ''}; Docker ${docker ? 'available' : 'not available'})`;
}

function dockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const c = spawn('docker', ['info'], { stdio: 'ignore' });
    const t = setTimeout(() => { c.kill(); resolve(false); }, 10_000);
    c.on('error', () => { clearTimeout(t); resolve(false); });
    c.on('close', (code) => { clearTimeout(t); resolve(code === 0); });
  });
}
