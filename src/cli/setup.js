import { createInterface } from 'readline';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir, platform, release, type as osType } from 'os';
import { basename, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import { SUPPORTED_AGENTS, registerAgents } from './mcp-register.js';
import { HOOK_FILES, PUSH_AGENTS, installAgentHooks } from './setup-hooks.js';
import {
  installJobs, systemdEscape, systemdExecWord, xmlEscape,
} from './setup-jobs.js';
import { installBundledSkills } from './setup-skills.js';
import { stableNodePath } from './runtime-node.js';
import { writePrivateFile } from '../private-file.js';
import { askHidden } from '../secret-prompt.js';
import { DEFAULT_KB_DIR } from '../env.js';
import { DB_PATH, KB_DIR } from '../paths.js';
import { scanVault } from '../vault/indexer.js';
import {
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  formatHttpServerUrl,
  resolveHttpHost,
  resolveHttpPort,
} from '../http-bind.js';

const HOME = homedir();
const API_KEY_PREFIX = 'KB_API_KEY_';
// fileURLToPath handles Windows drive letters correctly (avoids C:\C:\ duplication)
const PROJECT_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function out(text) { process.stdout.write(text); }
function outln(text = '') { process.stdout.write(text + '\n'); }

function genHex(bytes = 32) { return randomBytes(bytes).toString('hex'); }
function genBase64(bytes = 32) { return randomBytes(bytes).toString('base64'); }
function shellWord(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:-]+$/.test(text)
    ? text
    : `'${text.replaceAll("'", "'\"'\"'")}'`;
}

export function setupCliCommand({
  argvPath = process.argv[1],
  projectRoot = PROJECT_ROOT,
  cwd = process.cwd(),
} = {}) {
  const invokedName = basename(argvPath || '').replace(/\.(cmd|exe)$/i, '');
  const installedPackage = resolve(projectRoot).split(sep).includes('node_modules');
  if (invokedName === 'kb' || installedPackage) return 'kb';

  const entrypoint = join(projectRoot, 'bin', 'kb.js');
  return `node ${shellWord(relative(cwd, entrypoint) || basename(entrypoint))}`;
}

function which(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function detectVaultPath() {
  const candidates = [
    join(HOME, 'obsidian-vault'),
    join(HOME, 'Documents', 'Obsidian'),
    join(HOME, 'Obsidian'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export class SetupVaultSafetyError extends Error {
  constructor({ candidatePath, documentCount }) {
    const candidate = candidatePath || 'none';
    super(
      `Refusing to repoint a populated knowledge base (${documentCount} documents) `
      + `to an empty vault candidate (${candidate}). In automatic mode, supply `
      + `--vault=${candidate} and --confirm-empty-vault=${candidate} together.`
    );
    this.name = 'SetupVaultSafetyError';
    this.code = 'KB_SETUP_EMPTY_VAULT_REFUSED';
  }
}

export function countStoredDocuments(dbPath = DB_PATH) {
  if (!existsSync(dbPath)) return 0;
  const database = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const hasDocuments = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'documents'"
    ).get();
    return hasDocuments
      ? database.prepare('SELECT COUNT(*) AS count FROM documents').get().count
      : 0;
  } finally {
    database.close();
  }
}

function markdownCount(vaultPath) {
  if (!vaultPath || !existsSync(vaultPath)) return 0;
  return scanVault(vaultPath).length;
}

export function assertSafeVaultSelection({
  candidatePath,
  priorPath,
  explicitVault,
  confirmation,
  documentCount = countStoredDocuments(),
  candidateMarkdownCount = markdownCount(candidatePath),
}) {
  const sameAsPrior = candidatePath && priorPath
    && resolve(candidatePath) === resolve(priorPath);
  if (documentCount === 0 || candidateMarkdownCount > 0 || sameAsPrior) return;

  const expected = candidatePath ? resolve(candidatePath) : 'none';
  const confirmed = confirmation === 'none' ? 'none' : confirmation && resolve(confirmation);
  if (!explicitVault || confirmed !== expected) {
    throw new SetupVaultSafetyError({ candidatePath, documentCount });
  }
}

export function setupJobPolicy(args, {
  kbDir = KB_DIR,
  defaultKbDir = DEFAULT_KB_DIR,
} = {}) {
  const loadRequested = args.includes('--load-jobs');
  const noLoadRequested = args.includes('--no-load-jobs');
  if (loadRequested && noLoadRequested) {
    throw new Error('--load-jobs and --no-load-jobs cannot be used together');
  }
  const customKbDir = resolve(kbDir) !== resolve(defaultKbDir);
  if (customKbDir) {
    if (loadRequested) {
      throw new Error('--load-jobs is refused for a custom KB_DIR; install its scheduler explicitly');
    }
    return { installJobs: noLoadRequested, loadJobs: false };
  }
  return { installJobs: true, loadJobs: !noLoadRequested };
}

export function assertSafeServiceSelection(deploy, {
  kbDir = KB_DIR,
  defaultKbDir = DEFAULT_KB_DIR,
} = {}) {
  const customKbDir = resolve(kbDir) !== resolve(defaultKbDir);
  if (customKbDir && ['launchd', 'systemd'].includes(deploy)) {
    throw new Error(
      `${deploy} service installation is refused for a custom KB_DIR; `
      + 'use manual mode and install the service explicitly'
    );
  }
}

// Parse KEY=value lines from a .env file; ignores comments and blanks.
export function parseEnvFile(content) {
  const out = {};
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  return parseEnvFile(readFileSync(path, 'utf8'));
}

// New installs keep mutable state outside the checkout/package. Merge the
// legacy checkout file first so re-running setup migrates without rotating
// secrets, while an existing durable value wins.
export function loadExistingEnv({
  statePath = join(KB_DIR, '.env'),
  legacyPath = join(PROJECT_ROOT, '.env'),
} = {}) {
  return { ...readEnvFile(legacyPath), ...readEnvFile(statePath) };
}

function apiKeysFromEnv(env) {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([key]) => key.startsWith(API_KEY_PREFIX))
      .map(([key, value]) => [key.slice(API_KEY_PREFIX.length).toLowerCase(), value]),
  );
}

function apiKeyEnvName(agent) {
  return `${API_KEY_PREFIX}${agent.toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Readline prompt helpers
// ---------------------------------------------------------------------------

function createRl() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, question, defaultVal = '') {
  const suffix = defaultVal ? ` [${defaultVal}]` : '';
  return new Promise(resolve => {
    rl.question(`  ${question}${suffix}: `, answer => {
      resolve(answer.trim() || defaultVal);
    });
  });
}

export function askSecret(rl, question, defaultVal) {
  return askHidden(
    rl,
    `  ${question} [leave blank to keep or generate]: `,
    defaultVal,
  );
}

async function askChoice(rl, question, choices, defaultIdx = 0) {
  outln();
  choices.forEach((c, i) => {
    const marker = i === defaultIdx ? '>' : ' ';
    outln(`  ${marker} ${i + 1}) ${c}`);
  });
  const answer = await ask(rl, question, String(defaultIdx + 1));
  const idx = parseInt(answer, 10) - 1;
  if (idx >= 0 && idx < choices.length) return idx;
  return defaultIdx;
}

async function askMulti(rl, question, choices) {
  outln();
  choices.forEach((c, i) => {
    outln(`    ${i + 1}) ${c}`);
  });
  outln(`    A) All`);
  const answer = await ask(rl, question, 'A');
  if (answer.toUpperCase() === 'A') return choices.map((_, i) => i);
  return answer.split(/[,\s]+/).map(s => parseInt(s, 10) - 1).filter(i => i >= 0 && i < choices.length);
}

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

const AGENT_LABELS = {
  claude: 'Claude Code',
  codex: 'OpenAI Codex CLI',
  gemini: 'Google Gemini CLI',
  cursor: 'Cursor',
  ollama: 'Ollama',
};

function detectEnvironment() {
  const env = {
    os: `${osType()} ${platform()} ${release()}`,
    nodeVersion: process.version,
    tools: {},
  };

  for (const [cmd, label] of Object.entries(AGENT_LABELS)) {
    env.tools[cmd] = { label, available: which(cmd) };
  }

  return env;
}

// ---------------------------------------------------------------------------
// Config generation
// ---------------------------------------------------------------------------

export function buildEnvContent(cfg) {
  const host = resolveHttpHost(cfg.host);
  const port = resolveHttpPort(cfg.port);
  const agents = cfg.agents || [];
  const lines = [
    '# Knowledge Base Server Configuration',
    `# Generated by setup wizard on ${new Date().toISOString()}`,
    '',
    '# Server port for the dashboard',
    `KB_PORT=${port}`,
    '',
    '# Bind to loopback by default. Set 0.0.0.0 only behind a TLS reverse proxy.',
    `KB_HOST=${host}`,
    '',
    '# Dashboard login password',
    `KB_PASSWORD=${cfg.password}`,
    '',
    '# Obsidian vault path (leave empty if not using Obsidian)',
    `OBSIDIAN_VAULT_PATH=${cfg.vaultPath || ''}`,
    '',
    '# Let the nightly harvest extract facts as well as lessons (1, true or yes).',
    '# Off by default: it is the expensive half, and unattended it writes an open',
    '# predicate vocabulary. Set it before `kb setup` — the scheduled job takes a',
    '# copy, so changing it here later needs a `kb setup` re-run.',
    '# KB_HARVEST_FACTS=1',
    '',
    '# Include print-mode/SDK sessions in manual and scheduled harvests.',
    '# Off by default. Set it before `kb setup`; scheduled jobs take a copy.',
    '# KB_HARVEST_SDK_SESSIONS=1',
    '',
  ];

  // API keys per agent
  const apiKeyAgents = [
    ...agents,
    ...Object.keys(cfg.apiKeys || {}).filter(agent => !agents.includes(agent)),
  ];
  if (apiKeyAgents.length > 0) {
    lines.push('# Brain API keys — one per AI agent');
    for (const agent of apiKeyAgents) {
      const envName = apiKeyEnvName(agent);
      const key = cfg.apiKeys?.[agent] || genHex();
      lines.push(`${envName}=${key}`);
    }
    lines.push('');
  }

  // Auth secret
  lines.push('# Better Auth secret (for OAuth / remote Brain API)');
  lines.push(`BETTER_AUTH_SECRET=${cfg.authSecret || genBase64()}`);
  lines.push('');

  if (cfg.brainApi) {
    lines.push('# Brain API public URL');
    lines.push(`BETTER_AUTH_URL=https://${cfg.brainDomain}`);
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Service installation helpers
// ---------------------------------------------------------------------------

export function systemdServiceContent({
  kbDir = KB_DIR,
  nodeBin = stableNodePath(),
  projectRoot = PROJECT_ROOT,
} = {}) {
  return `[Unit]
Description=Knowledge Base Server
After=network.target

[Service]
Type=simple
User=${process.env.USER || 'root'}
WorkingDirectory=${systemdExecWord(projectRoot)}
ExecStart=${systemdExecWord(nodeBin)} ${systemdExecWord(join(projectRoot, 'bin', 'kb.js'))} start
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment="KB_DIR=${systemdEscape(kbDir)}"

[Install]
WantedBy=multi-user.target
`;
}

function installSystemd() {
  const unit = systemdServiceContent();
  const unitPath = '/etc/systemd/system/knowledge-base.service';
  try {
    writeFileSync(unitPath, unit);
    execFileSync('systemctl', ['daemon-reload'], { stdio: 'ignore' });
    execFileSync('systemctl', ['enable', 'knowledge-base'], { stdio: 'ignore' });
    return { ok: true, path: unitPath };
  } catch (err) {
    return { ok: false, error: err.message, content: unit };
  }
}

export function launchdServiceContent({
  kbDir = KB_DIR,
  nodeBin = stableNodePath(),
  projectRoot = PROJECT_ROOT,
} = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.knowledgebase.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodeBin)}</string>
    <string>${xmlEscape(join(projectRoot, 'bin', 'kb.js'))}</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(projectRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>KB_DIR</key>
    <string>${xmlEscape(kbDir)}</string>
  </dict>
</dict>
</plist>
`;
}

function installLaunchd() {
  const plist = launchdServiceContent();
  const plistPath = join(HOME, 'Library', 'LaunchAgents', 'com.knowledgebase.server.plist');
  try {
    mkdirSync(join(HOME, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(plistPath, plist);
    return { ok: true, path: plistPath };
  } catch (err) {
    return { ok: false, error: err.message, content: plist };
  }
}

export function dockerComposeContent(cfg) {
  return `version: "3.8"
services:
  knowledge-base:
    build: .
    ports:
      - "127.0.0.1:${cfg.port}:${cfg.port}"
    volumes:
      - kb-data:/root/.knowledge-base
${cfg.vaultPath ? `      - ${cfg.vaultPath}:/vault` : ''}
    env_file:
      - ${JSON.stringify(join(KB_DIR, '.env'))}
    environment:
      KB_HOST: 0.0.0.0
    restart: unless-stopped

volumes:
  kb-data:
`;
}

function generateDockerCompose(cfg) {
  const content = dockerComposeContent(cfg);
  const composePath = join(PROJECT_ROOT, 'docker-compose.yml');
  writeFileSync(composePath, content);
  return composePath;
}

// ---------------------------------------------------------------------------
// Parse --auto CLI flags
// ---------------------------------------------------------------------------

export function parseAutoArgs(args) {
  const cfg = {};
  for (const arg of args) {
    const m = arg.match(/^--(\w[\w-]*)=(.*)$/);
    if (m) {
      const [, key, val] = m;
      if (key === 'port') cfg.port = resolveHttpPort(val);
      else if (key === 'host') cfg.host = resolveHttpHost(val);
      else if (key === 'password') cfg.password = val;
      else if (key === 'vault') cfg.vaultPath = val === 'none' ? '' : resolve(val.replace(/^~/, HOME));
      else if (key === 'confirm-empty-vault') {
        cfg.confirmEmptyVault = val === 'none' ? 'none' : resolve(val.replace(/^~/, HOME));
      }
      else if (key === 'agents') cfg.agents = val.split(',').map(s => s.trim().toLowerCase());
      else if (key === 'deploy') cfg.deploy = val;
      else if (key === 'brain') cfg.brainApi = val === 'true' || val === 'yes';
      else if (key === 'domain') cfg.brainDomain = val;
    }
  }
  return cfg;
}

function resolveVaultPath(configuredPath, priorPath) {
  if (typeof configuredPath === 'string' && configuredPath) {
    return resolve(configuredPath.replace(/^~/, HOME));
  }
  if (configuredPath !== undefined) return configuredPath;
  return priorPath || detectVaultPath() || join(HOME, 'kb-vault');
}

function loadConfigFile() {
  for (const configPath of [
    join(KB_DIR, 'setup-config.json'),
    join(PROJECT_ROOT, 'setup-config.json'),
  ]) {
    if (!existsSync(configPath)) continue;
    try {
      return JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch { return null; }
  }
  return null;
}

export function writeSetupEnv(path, content) {
  writePrivateFile(path, content);
}

export function resolvePersistedHttpHost(value, onInvalid = () => {}) {
  try {
    return resolveHttpHost(value);
  } catch (error) {
    onInvalid(error);
    return DEFAULT_HTTP_HOST;
  }
}

export function resolvePersistedHttpPort(value, onInvalid = () => {}) {
  try {
    return resolveHttpPort(value);
  } catch (error) {
    onInvalid(error);
    return DEFAULT_HTTP_PORT;
  }
}

// ---------------------------------------------------------------------------
// Interactive wizard
// ---------------------------------------------------------------------------

async function runInteractive(env) {
  const rl = createRl();
  const cfg = {};
  const prior = loadExistingEnv();
  const priorHost = resolvePersistedHttpHost(
    prior.KB_HOST,
    error => outln(`  Warning: ${error.message}; resetting to ${DEFAULT_HTTP_HOST}.`),
  );
  const priorPort = resolvePersistedHttpPort(
    prior.KB_PORT,
    error => outln(`  Warning: ${error.message}; resetting to ${DEFAULT_HTTP_PORT}.`),
  );

  // 1. Welcome
  outln();
  outln('========================================');
  outln('  Knowledge Base Server Setup');
  outln('========================================');
  outln();

  // 2. Environment
  outln('  Detected environment:');
  outln(`    OS:   ${env.os}`);
  outln(`    Node: ${env.nodeVersion}`);
  outln(`    AI tools found:`);
  for (const [, info] of Object.entries(env.tools)) {
    outln(`      ${info.available ? '[x]' : '[ ]'} ${info.label}`);
  }
  outln();

  // 3. Dashboard password
  const randomPw = prior.KB_PASSWORD || genHex(8);
  outln('  Dashboard password protects the web UI.');
  outln(prior.KB_PASSWORD
    ? '  Press Enter to keep the existing password, or type a new one.'
    : '  Press Enter to generate a random one, or type your own.');
  cfg.password = await askSecret(rl, 'Dashboard password', randomPw);

  // 4. Server port
  outln();
  outln('  The dashboard and API will listen on this port.');
  const portStr = await ask(rl, 'Server port', String(priorPort));
  cfg.port = resolveHttpPort(portStr);
  cfg.host = resolveHttpHost(await ask(
    rl,
    'Bind host (use 0.0.0.0 only behind a TLS reverse proxy)',
    priorHost,
  ));

  // 5. Vault (any markdown dir; Obsidian is an optional viewer)
  outln();
  outln('  The vault is a markdown folder the KB indexes for search.');
  const detected = prior.OBSIDIAN_VAULT_PATH || detectVaultPath();
  const vaultDefault = detected || join(HOME, 'kb-vault');
  if (detected) {
    outln(`  Using vault: ${detected}`);
  }
  outln('  Enter a path (created if missing), or "none" to skip.');
  const vaultAnswer = await ask(rl, 'Vault path', vaultDefault);
  cfg.vaultPath = vaultAnswer === 'none' ? '' : resolve(vaultAnswer.replace(/^~/, HOME));
  try {
    assertSafeVaultSelection({
      candidatePath: cfg.vaultPath,
      priorPath: prior.OBSIDIAN_VAULT_PATH,
      explicitVault: false,
      confirmation: null,
    });
  } catch (error) {
    if (!(error instanceof SetupVaultSafetyError)) throw error;
    const expected = cfg.vaultPath || 'none';
    outln(`  ${error.message}`);
    const confirmation = await ask(rl, `Type "${expected}" to confirm this empty vault`, '');
    assertSafeVaultSelection({
      candidatePath: cfg.vaultPath,
      priorPath: prior.OBSIDIAN_VAULT_PATH,
      explicitVault: true,
      confirmation,
    });
  }

  // 6. AI agents
  outln();
  outln('  Select which AI agents will connect to the knowledge base.');
  outln('  Each gets a unique API key for authentication.');
  const agentKeys = Object.keys(AGENT_LABELS);
  const agentChoices = agentKeys.map(k => AGENT_LABELS[k]);
  const selected = await askMulti(rl, 'Select agents (comma-separated numbers, or A for all)', agentChoices);
  cfg.agents = selected.map(i => agentKeys[i]);
  cfg.apiKeys = apiKeysFromEnv(prior);
  for (const agent of cfg.agents) {
    cfg.apiKeys[agent] = prior[apiKeyEnvName(agent)] || genHex();
  }

  // 7. Deployment mode
  const deployChoices = [];
  const deployKeys = [];
  if (platform() === 'linux') { deployChoices.push('systemd (auto-start on boot)'); deployKeys.push('systemd'); }
  if (platform() === 'darwin') { deployChoices.push('launchd (auto-start on boot)'); deployKeys.push('launchd'); }
  deployChoices.push('Docker Compose (source checkout; requires Dockerfile)');
  deployKeys.push('docker');
  deployChoices.push('PM2 (process manager)');
  deployKeys.push('pm2');
  deployChoices.push('Manual (run kb start yourself)');
  deployKeys.push('manual');

  outln();
  outln('  How should the server run?');
  const deployIdx = await askChoice(rl, 'Deployment mode', deployChoices, 0);
  cfg.deploy = deployKeys[deployIdx];

  // 8. Brain API
  outln();
  outln('  The Brain API allows remote HTTPS access from AI agents.');
  outln('  Requires a domain name and reverse proxy (e.g., Caddy, nginx).');
  const brainAnswer = await ask(rl, 'Enable Brain API? (y/N)', 'n');
  cfg.brainApi = brainAnswer.toLowerCase().startsWith('y');
  if (cfg.brainApi) {
    cfg.brainDomain = await ask(rl, 'Domain for Brain API', 'brain.yourdomain.com');
  }

  cfg.authSecret = prior.BETTER_AUTH_SECRET || genBase64();

  rl.close();
  return cfg;
}

// ---------------------------------------------------------------------------
// Apply configuration
// ---------------------------------------------------------------------------

export function registerSetupAgents(agents, {
  homeDir = HOME,
  cwd = process.cwd(),
  register = registerAgents,
} = {}) {
  try {
    return register(agents, homeDir, { cwd }).map(result => {
      const { agent } = result;
      // A hand-managed config (Codex's config.toml) and a refused move are
      // both "not registered" — reporting either as a write is how a setup
      // run ends believing it wired something it did not.
      if (result.manual) {
        return {
          action: `MCP config for ${agent} is hand-managed — not written`,
          path: result.path,
          hint: `Run 'kb register --agents=${agent}' to print the block to paste`,
        };
      }
      if (!result.written) {
        return {
          action: `Refused to move the MCP registration for ${agent}`,
          path: result.path,
          error: `points at ${result.from} — re-register from that checkout, or 'kb register --force'`,
        };
      }
      return { action: `Registered MCP for ${agent}`, path: result.path };
    });
  } catch (err) {
    return [{ action: 'Failed to register MCP clients', error: err.message }];
  }
}

export function registerSetupAgent(agent, options = {}) {
  return registerSetupAgents([agent], options);
}

function applyConfig(cfg) {
  const results = { steps: [] };

  // 0. Ensure vault exists (any markdown dir works; Obsidian is an optional viewer)
  if (cfg.vaultPath && !existsSync(cfg.vaultPath)) {
    try {
      mkdirSync(cfg.vaultPath, { recursive: true });
      try {
        execFileSync('bash', [join(PROJECT_ROOT, 'bin', 'init-vault.sh')], {
          env: { ...process.env, OBSIDIAN_VAULT_PATH: cfg.vaultPath }, stdio: 'ignore',
        });
        results.steps.push({ action: 'Created vault with folder taxonomy', path: cfg.vaultPath });
      } catch (err) {
        results.steps.push({ action: 'Created vault (taxonomy script failed; folders optional)', path: cfg.vaultPath, error: err.message });
      }
    } catch (err) {
      results.steps.push({ action: 'Failed to create vault directory', path: cfg.vaultPath, error: err.message });
    }
  }

  // 1. Write .env
  const envContent = buildEnvContent(cfg);
  const envPath = join(KB_DIR, '.env');
  const envExisted = existsSync(envPath);
  writeSetupEnv(envPath, envContent);
  results.steps.push({
    action: envExisted ? 'Updated .env' : 'Created .env',
    path: envPath,
  });

  // 2. Register every owned MCP config in one batch so a late target failure
  // rolls back earlier clients from this setup run.
  const registrationAgents = (cfg.agents || []).filter(agent => SUPPORTED_AGENTS.includes(agent));
  if (registrationAgents.length > 0) {
    results.steps.push(...registerSetupAgents(registrationAgents));
  }

  // 3. Install service
  if (cfg.deploy === 'systemd') {
    const r = installSystemd();
    if (r.ok) {
      results.steps.push({ action: 'Installed systemd service', path: r.path });
    } else {
      results.steps.push({
        action: 'Could not install systemd service (may need sudo)',
        error: r.error,
        hint: 'Save the unit file manually and run: sudo systemctl daemon-reload && sudo systemctl enable knowledge-base',
      });
    }
  } else if (cfg.deploy === 'launchd') {
    const r = installLaunchd();
    if (r.ok) {
      results.steps.push({ action: 'Installed launchd plist', path: r.path });
    } else {
      results.steps.push({ action: 'Could not install launchd plist', error: r.error });
    }
  } else if (cfg.deploy === 'docker') {
    const path = generateDockerCompose(cfg);
    results.steps.push({ action: 'Generated docker-compose.yml', path });
  } else if (cfg.deploy === 'pm2') {
    results.steps.push({
      action: 'PM2 selected',
      hint: 'Run: pm2 start bin/kb.js --name knowledge-base -- start',
    });
  }

  // 4. Agent hooks: session briefing + per-prompt KB hints
  for (const agent of (cfg.agents || [])) {
    if (!HOOK_FILES[agent]) continue;
    const label = AGENT_LABELS[agent] || agent;
    try {
      const r = installAgentHooks({
        home: HOME,
        agent,
        nodeBin: stableNodePath(),
        kbJsPath: join(PROJECT_ROOT, 'bin', 'kb.js'),
        kbDir: KB_DIR,
      });
      results.steps.push({ action: `Installed ${label} hooks (${PUSH_AGENTS.includes(agent) ? 'briefing + hints' : 'briefing'})`, path: r.path });
      if (r.backup) results.steps.push({ action: `Backed up prior ${label} hook config`, path: r.backup });
    } catch (err) {
      results.steps.push({ action: `Failed to install ${label} hooks`, error: err.message });
    }
  }

  // 5. Scheduled jobs: nightly harvest, reindex, weekly synthesis
  let claudePath = null;
  try { claudePath = execFileSync('which', ['claude']).toString().trim(); } catch { /* optional */ }
  if (cfg.installJobs !== false) {
    const jobs = installJobs({
      home: HOME, nodeBin: stableNodePath(), kbRoot: PROJECT_ROOT,
      vaultPath: cfg.vaultPath, claudePath, load: cfg.loadJobs !== false, kbDir: KB_DIR,
    });
    results.steps.push(...jobs.steps);
    if (!claudePath) results.steps.push({ action: 'claude CLI not found — nightly harvest needs it; install Claude Code and re-run setup', error: 'CLAUDE_PATH unset' });
  } else {
    results.steps.push({
      action: 'Skipped scheduled jobs for custom KB_DIR',
      hint: 'Re-run with --load-jobs or --no-load-jobs to choose explicitly.',
    });
  }

  // 6. Bundled skills — never overwrite a skill the user already has.
  try {
    results.steps.push(...installBundledSkills({ home: HOME, projectRoot: PROJECT_ROOT }));
  } catch (err) {
    results.steps.push({ action: 'Failed to install bundled skills', error: err.message });
  }

  // 7. First ingest if vault provided
  if (cfg.vaultPath && existsSync(cfg.vaultPath)) {
    results.ingestPath = cfg.vaultPath;
  }

  results.cfg = cfg;
  return results;
}

// ---------------------------------------------------------------------------
// Print summary
// ---------------------------------------------------------------------------

export function formatSetupSummary(results, {
  cliCommand = setupCliCommand(),
} = {}) {
  const lines = [
    '',
    '========================================',
    '  Setup Complete',
    '========================================',
    '',
  ];

  for (const step of results.steps) {
    lines.push(`  [${step.error ? 'warning' : 'done'}] ${step.action}`);
    if (step.path) lines.push(`         ${step.path}`);
    if (step.hint) lines.push(`         ${step.hint}`);
    if (step.error) lines.push(`         Error: ${step.error}`);
  }

  const cfg = results.cfg;
  lines.push('');
  lines.push('  Configuration summary:');
  lines.push(`    Bind host:   ${cfg.host || DEFAULT_HTTP_HOST}`);
  lines.push(`    Port:        ${cfg.port}`);
  lines.push(`    Credentials: stored in ${join(KB_DIR, '.env')}`);
  lines.push(`    Vault:       ${cfg.vaultPath || '(none)'}`);
  lines.push(`    Agents:      ${(cfg.agents || []).join(', ') || '(none)'}`);
  lines.push(`    Deploy:      ${cfg.deploy || 'manual'}`);
  if (cfg.brainApi) {
    lines.push(`    Brain API:   https://${cfg.brainDomain}`);
  }

  lines.push('');
  lines.push('  Next steps:');
  lines.push('    1. Review .env and adjust if needed');
  if (results.ingestPath) {
    lines.push(`    2. Run: ${cliCommand} ingest ${shellWord(results.ingestPath)}`);
    lines.push(`    3. Run: ${cliCommand} start`);
  } else {
    lines.push(`    2. Run: ${cliCommand} start`);
  }
  lines.push(`    Dashboard: ${formatHttpServerUrl({
    host: cfg.host || DEFAULT_HTTP_HOST,
    port: cfg.port,
  })}`);
  lines.push('');
  const hooked = (cfg.agents || []).filter(a => HOOK_FILES[a]).map(a => AGENT_LABELS[a] || a);
  if (hooked.length) lines.push(`Open a new ${hooked.join(' or ')} session — your first KB BRIEFING should appear at startup.`);
  return `${lines.join('\n')}\n`;
}

function printSummary(results) {
  out(formatSetupSummary(results));
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function setup(args = []) {
  const isAuto = args.includes('--auto');

  const env = detectEnvironment();

  if (isAuto) {
    // Agent mode: combine config file + CLI flags, no prompts
    const fileConfig = loadConfigFile() || {};
    const cliConfig = parseAutoArgs(args);
    const merged = { ...fileConfig, ...cliConfig };

    // Apply defaults for anything not specified; preserve existing secrets on re-run.
    const prior = loadExistingEnv();
    const priorHost = resolvePersistedHttpHost(
      prior.KB_HOST,
      error => outln(`Warning: ${error.message}; resetting to ${DEFAULT_HTTP_HOST}.`),
    );
    const priorPort = resolvePersistedHttpPort(
      prior.KB_PORT,
      error => outln(`Warning: ${error.message}; resetting to ${DEFAULT_HTTP_PORT}.`),
    );
    const jobPolicy = setupJobPolicy(args);
    const cfg = {
      port: merged.port ?? priorPort,
      host: merged.host || priorHost,
      password: merged.password || prior.KB_PASSWORD || genHex(8),
      // A non-empty vaultPath (from setup-config.json or --vault) gets the same
      // tilde/relative resolution the flag and interactive paths apply; '' keeps
      // the `--vault=none` skip-vault semantics.
      vaultPath: resolveVaultPath(merged.vaultPath, prior.OBSIDIAN_VAULT_PATH),
      agents: merged.agents || Object.keys(env.tools).filter(k => env.tools[k].available),
      deploy: merged.deploy || 'manual',
      brainApi: merged.brainApi || false,
      brainDomain: merged.brainDomain || 'brain.yourdomain.com',
      authSecret: merged.authSecret || prior.BETTER_AUTH_SECRET || genBase64(),
      apiKeys: apiKeysFromEnv(prior),
      ...jobPolicy,
    };

    assertSafeVaultSelection({
      candidatePath: cfg.vaultPath,
      priorPath: prior.OBSIDIAN_VAULT_PATH,
      explicitVault: args.some(arg => arg.startsWith('--vault=')),
      confirmation: cliConfig.confirmEmptyVault,
    });
    assertSafeServiceSelection(cfg.deploy);

    // Generate API keys for each agent, reusing prior keys so registered agents keep working.
    for (const agent of cfg.agents) {
      cfg.apiKeys[agent] = merged.apiKeys?.[agent] || cfg.apiKeys[agent] || genHex();
    }

    outln('Knowledge Base Server — automatic setup');
    outln();

    const results = applyConfig(cfg);
    printSummary(results);
    return;
  }

  // Interactive mode
  const cfg = await runInteractive(env);
  Object.assign(cfg, setupJobPolicy(args));
  assertSafeServiceSelection(cfg.deploy);
  const results = applyConfig(cfg);
  printSummary(results);
}
