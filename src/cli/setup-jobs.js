// src/cli/setup-jobs.js — install harvest/reindex/synthesis as launchd or systemd user jobs
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { LOGS_DIR } from '../paths.js';
import { JOBS } from '../jobs.js';

export { JOBS };


function command(job, { nodeBin, kbRoot }) {
  const [entry, ...rest] = job.args;
  return [nodeBin, join(kbRoot, entry), ...rest];
}

const xmlEscape = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// systemd Environment=: % is a specifier, " ends the quoted value
const sdEscape = s => String(s).replace(/%/g, '%%').replace(/"/g, '\\"');

// A scheduled job inherits nothing — no shell profile, and dotenv resolves .env
// against the launcher's cwd (/ under launchd), not the install. Whatever the
// job needs has to be written into the unit here, and changing it later means
// re-running `kb setup`.
const jobEnv = (job, opts) => ({
  OBSIDIAN_VAULT_PATH: opts.vaultPath,
  CLAUDE_PATH: opts.claudePath ?? '',
  // Only the harvest reads it, and only when the installing environment set it.
  ...(job.name === 'harvest' && opts.harvestFacts ? { KB_HARVEST_FACTS: opts.harvestFacts } : {}),
});

export function renderPlist(job, opts) {
  const cmd = command(job, opts).map(c => `        <string>${xmlEscape(c)}</string>`).join('\n');
  const sched = job.schedule.interval
    ? `    <key>StartInterval</key>\n    <integer>${job.schedule.interval}</integer>`
    : `    <key>StartCalendarInterval</key>\n    <dict>${Object.entries(job.schedule.calendar).map(([k, v]) => `<key>${k}</key><integer>${v}</integer>`).join('')}</dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.kb.${job.name}</string>
    <key>ProgramArguments</key>
    <array>
${cmd}
    </array>
${sched}
    <key>StandardOutPath</key>
    <string>${xmlEscape(join(opts.logsDir, `${job.name}.log`))}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(join(opts.logsDir, `${job.name}.err`))}</string>
    <key>EnvironmentVariables</key>
    <dict>
${Object.entries(jobEnv(job, opts)).map(([k, v]) => `        <key>${k}</key>\n        <string>${xmlEscape(v)}</string>`).join('\n')}
    </dict>
</dict>
</plist>
`;
}

export function renderSystemdUnits(job, opts) {
  const service = `[Unit]
Description=KB ${job.name}

[Service]
Type=oneshot
ExecStart=${command(job, opts).join(' ')}
${Object.entries(jobEnv(job, opts)).map(([k, v]) => `Environment="${k}=${sdEscape(v)}"`).join('\n')}
`;
  const trigger = job.schedule.interval
    ? `OnBootSec=${job.schedule.interval}\nOnUnitActiveSec=${job.schedule.interval}`
    : `OnCalendar=${job.onCalendar}`;
  const timer = `[Unit]
Description=KB ${job.name} timer

[Timer]
${trigger}
Persistent=true

[Install]
WantedBy=timers.target
`;
  return { service, timer };
}

export function installJobs({ home, nodeBin, kbRoot, vaultPath, claudePath, harvestFacts = process.env.KB_HARVEST_FACTS, load = true, logsDir = LOGS_DIR }) {
  const opts = { nodeBin, kbRoot, vaultPath, claudePath, harvestFacts, logsDir };
  const steps = [];
  // launchd does not create the directory it is told to redirect into; a
  // missing one makes the job fail before it runs, with nowhere to say so.
  try {
    mkdirSync(logsDir, { recursive: true });
  } catch (err) {
    steps.push({ action: 'Failed to create job log directory', error: err.message });
    return { steps };
  }
  if (process.platform === 'darwin') {
    const dir = join(home, 'Library', 'LaunchAgents');
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      steps.push({ action: 'Failed to create job directory', error: err.message });
      return { steps };
    }
    for (const job of JOBS) {
      const path = join(dir, `com.kb.${job.name}.plist`);
      try {
        writeFileSync(path, renderPlist(job, opts));
        if (load) {
          try { execFileSync('launchctl', ['unload', path], { stdio: 'ignore' }); } catch { /* not loaded yet */ }
          execFileSync('launchctl', ['load', path], { stdio: 'ignore' });
        }
        steps.push({ action: `Installed launchd job com.kb.${job.name}`, path });
      } catch (err) {
        steps.push({ action: `Failed to install com.kb.${job.name}`, error: err.message });
      }
    }
  } else {
    const dir = join(home, '.config', 'systemd', 'user');
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      steps.push({ action: 'Failed to create job directory', error: err.message });
      return { steps };
    }
    for (const job of JOBS) {
      try {
        const { service, timer } = renderSystemdUnits(job, opts);
        writeFileSync(join(dir, `kb-${job.name}.service`), service);
        writeFileSync(join(dir, `kb-${job.name}.timer`), timer);
        if (load) {
          execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
          execFileSync('systemctl', ['--user', 'enable', '--now', `kb-${job.name}.timer`], { stdio: 'ignore' });
        }
        steps.push({ action: `Installed systemd user timer kb-${job.name}`, path: join(dir, `kb-${job.name}.timer`) });
      } catch (err) {
        steps.push({ action: `Failed to install kb-${job.name}`, error: err.message });
      }
    }
  }
  return { steps };
}
