#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const noOpen = args.includes('--no-open');
const statusOnly = args.includes('--status');
const restart = args.includes('--restart');
const target = path.resolve(args.find((a) => !a.startsWith('--')) || process.cwd());

try {
  execFileSync('git', ['-C', target, 'rev-parse', '--show-toplevel'], { stdio: 'pipe' });
} catch {
  console.error(`✗ ${target} is not inside a git repository.`);
  process.exit(1);
}

const hasDeps = (() => {
  try { createRequire(import.meta.url).resolve('express'); return true; } catch { return false; }
})();
if (!hasDeps) {
  console.log('Installing dependencies (first run)…');
  execFileSync('npm', ['install'], { cwd: root, stdio: 'inherit' });
}
if (!fs.existsSync(path.join(root, 'dist'))) {
  console.log('Building UI (first run)…');
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
}

if (statusOnly) {
  const { summarize } = await import('../server/summary.js');
  console.log(await summarize(target));
  process.exit(0);
}

// Reuse a server that's already running for this repo
{
  const os = await import('node:os');
  const top = execFileSync('git', ['-C', target, 'rev-parse', '--show-toplevel']).toString().trim();
  const dir = path.join(os.homedir(), '.repo-map', 'servers');
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (r.repo !== top) continue;
      if (restart) {
        // Stop only this repo's server, then fall through to start a fresh one (same port if it frees up).
        try { process.kill(r.pid, 'SIGTERM'); } catch { /* already gone */ }
        for (let i = 0; i < 20; i++) { try { process.kill(r.pid, 0); await new Promise((x) => setTimeout(x, 150)); } catch { break; } }
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* gone */ }
        console.log(`Stopped the old Repo Map for ${target}`);
        process.env.PORT = process.env.PORT || String(r.port);
        continue;
      }
      const ok = await fetch(`http://127.0.0.1:${r.port}/api/ping`).then((x) => x.json()).then((j) => j.repo === top).catch(() => false);
      if (ok) {
        console.log(`Repo Map is already running for ${target}\n→ http://localhost:${r.port}`);
        if (!noOpen) spawn('open', [`http://localhost:${r.port}`], { stdio: 'ignore', detached: true }).unref();
        process.exit(0);
      }
      fs.unlinkSync(path.join(dir, f));
    } catch { /* stale entry */ }
  }
}

const { start } = await import('../server/index.js');
const { url } = await start({ repoPath: target });
console.log(`Repo Map for ${target}\n→ ${url}`);
if (!noOpen) spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
