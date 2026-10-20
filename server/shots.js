import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import { record } from './actions.js';
import { analyze, baseStrategy, envHints } from './detect.js';

const execp = promisify(execFile);
export const CONFIG_FILE = '.repo-map.json';
export const cacheRoot = (repoName) => path.join(os.homedir(), '.repo-map', 'cache', repoName);
export const shotDir = (repoName, sha) => path.join(cacheRoot(repoName), sha);

const git = async (cwd, ...a) => {
  try { const { stdout } = await execp('git', a, { cwd, maxBuffer: 20 * 1024 * 1024 }); return stdout.trim(); } catch { return null; }
};

// ---- config ---------------------------------------------------------------
export function normalizeConfig(c = {}) {
  const routes = (c.routes?.length ? c.routes : ['/']).map((r) => (typeof r === 'string' ? { path: r } : r))
    .filter((r) => r && typeof r.path === 'string' && r.path.startsWith('/'))
    .map((r) => ({ path: r.path, name: r.name || r.path, waitFor: r.waitFor || undefined, slug: slugOf(r.path) }));
  const vp = c.viewport || {};
  return {
    mode: c.mode === 'dev' || (!c.mode && !c.build) ? 'dev' : 'build',
    install: c.install || '',
    build: c.build || '',
    outDir: c.outDir || 'dist',
    dev: c.dev || '',
    port: Number(c.port) || 5173,
    routes: routes.length ? routes : [{ path: '/', name: '/', slug: 'home' }],
    viewport: { width: Number(vp.width) || 1440, height: Number(vp.height) || 900 },
    waitMs: c.waitMs ?? 500,
    fullPage: !!c.fullPage,
    env: c.env && typeof c.env === 'object' ? c.env : {},
    storage: { localStorage: c.storage?.localStorage || {}, sessionStorage: c.storage?.sessionStorage || {} },
    autoCapture: c.autoCapture !== false,
    autoMax: Math.min(20, Math.max(1, Number(c.autoMax) || 8)),
    autoDays: Math.max(1, Number(c.autoDays) || 21),
  };
}
export const slugOf = (p) => (p === '/' ? 'home' : p.replace(/^\/|\/$/g, '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase() || 'home');
export const configHash = (cfg) => crypto.createHash('sha1').update(JSON.stringify([cfg.viewport, cfg.fullPage, cfg.routes.map((r) => r.path)])).digest('hex').slice(0, 10);

export function readConfig(top) {
  const f = path.join(top, CONFIG_FILE);
  if (!fs.existsSync(f)) return { exists: false, path: f };
  try { return { exists: true, path: f, config: normalizeConfig(JSON.parse(fs.readFileSync(f, 'utf8'))) }; } catch (e) { return { exists: true, path: f, error: `Couldn’t read ${CONFIG_FILE}: ${e.message}` }; }
}

export function detectConfig(top, analyzed = analyze(top)) {
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(top, 'package.json'), 'utf8')); } catch { /* none */ }
  const has = (f) => fs.existsSync(path.join(top, f));
  const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
  const install = pm === 'pnpm' ? 'pnpm install --frozen-lockfile' : pm === 'yarn' ? 'yarn install --frozen-lockfile' : has('package-lock.json') ? 'npm ci' : 'npm install';
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const vite = !!deps.vite;
  const scripts = pkg.scripts || {};
  const run = (s) => (pm === 'npm' ? `npm run ${s}` : `${pm} ${s}`);
  const devScript = scripts.dev ? 'dev' : scripts.start ? 'start' : null;
  const cfg = {
    mode: scripts.build ? 'build' : 'dev',
    install: pkg.name || has('package.json') ? install : '',
    build: scripts.build ? run('build') : '',
    outDir: has('build') && !has('dist') ? 'build' : 'dist',
    dev: devScript ? (vite ? `${run(devScript)} -- --port {port} --strictPort` : `PORT={port} ${run(devScript)}`) : '',
    port: vite ? 5173 : 3000,
    routes: analyzed.routes.selected.map((r) => ({ path: r.path, name: r.component && r.path === '/' ? r.component : r.path })),
    env: Object.assign({}, ...analyzed.env.filter((e) => e.defaultOn).map((e) => e.vars)),
    viewport: { width: 1440, height: 900 },
    waitMs: 500,
  };
  if (!has('package.json')) { cfg.routes = ['/', ...fs.readdirSync(top).filter((f) => /\.html?$/.test(f) && !/^index\.html?$/.test(f)).map((f) => `/${f}`)].slice(0, 12).map((p) => ({ path: p })); cfg.mode = 'dev'; cfg.dev = 'python3 -m http.server {port}'; cfg.port = 8000; cfg.install = ''; }
  return cfg;
}

export function writeConfig(top, config) {
  const clean = { ...config, routes: normalizeConfig(config).routes.map(({ slug, ...r }) => (r.name === r.path && !r.waitFor ? r.path : r)) };
  if (clean.autoCapture !== false) { delete clean.autoCapture; } if (clean.autoMax === 8) delete clean.autoMax; if (clean.autoDays === 21) delete clean.autoDays;
  if (!Object.keys(clean.storage?.localStorage || {}).length && !Object.keys(clean.storage?.sessionStorage || {}).length) delete clean.storage;
  delete clean.env; if (config.env && Object.keys(config.env).length) clean.env = config.env;
  fs.writeFileSync(path.join(top, CONFIG_FILE), JSON.stringify(clean, null, 2) + '\n');
}

// ---- cache index ----------------------------------------------------------
export function readMeta(repoName, sha) {
  try { return JSON.parse(fs.readFileSync(path.join(shotDir(repoName, sha), 'meta.json'), 'utf8')); } catch { return null; }
}
export function shotsIndex(repoName, shas) {
  const out = {};
  for (const sha of new Set(shas.filter(Boolean))) {
    const m = readMeta(repoName, sha);
    if (m) out[sha] = { at: m.at, routes: m.routes.map((r) => ({ slug: r.slug, path: r.path, name: r.name, ok: r.ok, error: r.error })), first: (m.routes.find((r) => r.ok) || {}).slug || null };
  }
  return out;
}
const failFile = (repoName, sha) => path.join(shotDir(repoName, sha), 'fail.json');
export const hasFailed = (repoName, sha, cfg) => { try { return JSON.parse(fs.readFileSync(failFile(repoName, sha), 'utf8')).configHash === configHash(cfg); } catch { return false; } };
export const isCached = (repoName, sha, cfg) => { const m = readMeta(repoName, sha); return !!m && m.configHash === configHash(cfg) && m.routes.some((r) => r.ok); };
export function clearFailures(repoName) {
  const root = cacheRoot(repoName);
  for (const d of fs.existsSync(root) ? fs.readdirSync(root) : []) { try { fs.rmSync(path.join(root, d, 'fail.json'), { force: true }); } catch { /* ignore */ } }
}

// ---- planning -------------------------------------------------------------
const LOCKS = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'];
async function depsStrategy(top, sha, cfg) {
  if ((await git(top, 'rev-parse', '--verify', '--quiet', `${sha}:package.json`)) === null) return 'none';
  for (const l of LOCKS) {
    const f = path.join(top, l);
    if (!fs.existsSync(f)) continue;
    const here = await git(top, 'hash-object', f);
    const there = await git(top, 'rev-parse', '--verify', '--quiet', `${sha}:${l}`);
    if (here && there && here === there && fs.existsSync(path.join(top, 'node_modules'))) return 'link';
  }
  return cfg.install ? 'install' : 'none';
}

export async function planShots(top, repoName, items, cfg, force) {
  const out = [];
  for (const it of items) {
    const cached = !force && isCached(repoName, it.sha, cfg);
    const deps = cached ? null : await depsStrategy(top, it.sha, cfg);
    const wt = `$TMP/repo-map-wt/${repoName}-${it.sha.slice(0, 10)}`;
    const steps = cached ? [] : [
      `git worktree add --detach ${wt} ${it.sha.slice(0, 10)}`,
      ...(deps === 'link' ? [`ln -s ${top}/node_modules ${wt}/node_modules   # same lockfile as your checkout, so no install needed`] : deps === 'install' ? [`(in ${wt}) ${cfg.install}`] : []),
      ...(cfg.mode === 'build' ? [`(in ${wt}) ${baseStrategy(top, cfg.build).cmd}`, `serve ${wt}/${cfg.outDir} on a free localhost port`] : [`(in ${wt}) ${cfg.dev}`]),
      `playwright: screenshot ${cfg.routes.length} route${cfg.routes.length > 1 ? 's' : ''} at ${cfg.viewport.width}×${cfg.viewport.height}`,
      `git worktree remove --force ${wt}`,
    ];
    out.push({ sha: it.sha, label: it.label, cached, deps, steps });
  }
  return out;
}

// ---- job engine -----------------------------------------------------------
const jobs = [];
let working = false;
export const listJobs = () => jobs.slice(-30).map(({ _cfg, _top, ...j }) => j);

export function enqueue(top, repoName, items, cfg, force, auto = false) {
  const made = [];
  for (const it of items) {
    if (jobs.some((j) => j.sha === it.sha && ['queued', 'running'].includes(j.state))) continue;
    if (!force && isCached(repoName, it.sha, cfg)) continue;
    const j = { id: crypto.randomBytes(4).toString('hex'), sha: it.sha, label: it.label, auto, priority: auto ? 0 : 1, state: 'queued', step: 'Waiting', log: [], error: null, _cfg: cfg, _top: top, repoName };
    jobs.push(j); made.push(j.id);
  }
  work();
  return made;
}
async function work() {
  if (working) return;
  working = true;
  try {
    for (let j; (j = jobs.filter((x) => x.state === 'queued').sort((p, q) => q.priority - p.priority)[0]); ) await runJob(j);
  } finally { working = false; }
}

function runCmd(job, display, cmd, { cwd, env = {}, timeout = 600000 }) {
  const entry = { cmd: display, status: 'running', out: '' };
  job.log.push(entry);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], { cwd, env: { ...process.env, BROWSER: 'none', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const add = (d) => { entry.out = (entry.out + d.toString()).slice(-3000); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => { add('\n[timed out]'); child.kill('SIGKILL'); }, timeout);
    child.on('close', async (code) => {
      clearTimeout(timer);
      entry.status = code === 0 ? 'ok' : 'failed'; entry.ms = Date.now() - t0;
      await record(job._top, { intent: 'screenshot', branch: job.label, cmd: display, ok: code === 0, output: entry.out.slice(-1500) });
      resolve(code === 0);
    });
  });
}

// Chrome refuses to load pages from these ports (ERR_UNSAFE_PORT), so never pick them.
const UNSAFE_PORTS = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
const freePort = (start) => new Promise((resolve) => {
  if (UNSAFE_PORTS.has(start)) return resolve(freePort(start + 1));
  const s = net.createServer();
  s.once('error', () => resolve(freePort(start + 1)));
  s.once('listening', () => s.close(() => resolve(start)));
  s.listen(start, '127.0.0.1');
});
const ping = (url) => new Promise((resolve) => { const r = http.get(url, (res) => { res.resume(); resolve(res.statusCode < 500); }); r.on('error', () => resolve(false)); r.setTimeout(2000, () => { r.destroy(); resolve(false); }); });
async function waitUp(url, child, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child && child.exitCode !== null) return false;
    if (await ping(url)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
const killTree = (child) => { if (!child?.pid) return; try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref(); };

async function launchBrowser() {
  try { return await chromium.launch(); } catch { /* try system Chrome */ }
  try { return await chromium.launch({ channel: 'chrome' }); } catch { /* fall through */ }
  throw new Error('No browser found for screenshots. Install one with: npx playwright-core install chromium');
}

function thumbOf(buf, width = 360) {
  const src = PNG.sync.read(buf);
  const w = Math.min(width, src.width); const h = Math.max(1, Math.round((src.height * w) / src.width));
  const dst = new PNG({ width: w, height: h });
  const fx = src.width / w; const fy = src.height / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx)), y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * src.width + xx) * 4; r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; n++; }
    const o = (y * w + x) * 4; dst.data[o] = r / n; dst.data[o + 1] = g / n; dst.data[o + 2] = b / n; dst.data[o + 3] = 255;
  }
  return { png: PNG.sync.write(dst), width: src.width, height: src.height };
}

/** How much of the screenshot is one flat colour (0..1), sampled. */
export function flatness(buf) {
  const png = PNG.sync.read(buf);
  const total = png.width * png.height;
  const step = Math.max(1, Math.floor(total / 40000));
  const counts = new Map(); let n = 0;
  for (let p = 0; p < total; p += step) {
    const i = p * 4;
    const k = ((png.data[i] >> 3) << 10) | ((png.data[i + 1] >> 3) << 5) | (png.data[i + 2] >> 3);
    counts.set(k, (counts.get(k) || 0) + 1); n++;
  }
  return Math.max(...counts.values()) / n;
}

const ASSET = /\.(m?js|css)(\?|$)/i;

export async function captureRoutes(job, baseUrl, cfg, outDir) {
  const browser = await launchBrowser();
  const results = [];
  const origin = new URL(baseUrl).origin;
  try {
    const ctx = await browser.newContext({ viewport: cfg.viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const st = cfg.storage || {};
    if (Object.keys(st.localStorage || {}).length || Object.keys(st.sessionStorage || {}).length) {
      await ctx.addInitScript((s) => {
        try { for (const [k, v] of Object.entries(s.localStorage || {})) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch { /* blocked */ }
        try { for (const [k, v] of Object.entries(s.sessionStorage || {})) sessionStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch { /* blocked */ }
      }, st);
    }
    for (const r of cfg.routes) {
      job.step = `Capturing ${r.path}`;
      const page = await ctx.newPage();
      const pageErrs = []; const consoleErrs = []; const badAssets = [];
      page.on('pageerror', (e) => pageErrs.push(String(e.message || e).split('\n')[0].slice(0, 220)));
      page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) consoleErrs.push(m.text().split('\n')[0].slice(0, 220)); });
      page.on('response', (res) => {
        const u = res.url(); if (!u.startsWith(origin) || !ASSET.test(u)) return;
        const ct = res.headers()['content-type'] || '';
        if (res.status() >= 400 || ct.includes('text/html')) badAssets.push(`${new URL(u).pathname} (${res.status() >= 400 ? `HTTP ${res.status()}` : 'got HTML, not code'})`);
      });
      page.on('requestfailed', (rq) => { if (rq.url().startsWith(origin) && ASSET.test(rq.url())) badAssets.push(`${new URL(rq.url()).pathname} (request failed)`); });
      const entry = { slug: r.slug, path: r.path, name: r.name, ok: false };
      try {
        let resp;
        try { resp = await page.goto(baseUrl + r.path, { waitUntil: 'networkidle', timeout: 20000 }); } catch (e) { if (/ERR_|net::/.test(String(e.message))) throw e; resp = await page.goto(baseUrl + r.path, { waitUntil: 'load', timeout: 20000 }); }
        if (resp && resp.status() >= 400) throw new Error(`Page returned HTTP ${resp.status()}`);
        await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
        if (r.waitFor) await page.waitForSelector(r.waitFor, { timeout: 15000 });
        await page.waitForTimeout(cfg.waitMs);
        const buf = await page.screenshot({ fullPage: cfg.fullPage });
        fs.writeFileSync(path.join(outDir, `${r.slug}.png`), buf);
        const flat = flatness(buf);
        const blank = flat > 0.99 || buf.length < 2500;
        const why = [...pageErrs.slice(0, 1), ...(badAssets.length ? [`assets failed to load: ${badAssets.slice(0, 2).join(', ')}`] : []), ...(blank && !pageErrs.length ? consoleErrs.slice(0, 1) : [])];
        if (blank) entry.error = `blank: ${why[0] || 'the page rendered a single flat colour'}${why.length > 1 ? ` (+${why.length - 1} more)` : ''}`;
        else if (why.length) entry.error = `errors: ${why.join('; ')}`;
        else {
          const t = thumbOf(buf);
          fs.writeFileSync(path.join(outDir, `${r.slug}.thumb.png`), t.png);
          Object.assign(entry, { ok: true, width: t.width, height: t.height });
        }
        entry.flat = Math.round(flat * 1000) / 1000;
        if (consoleErrs.length) entry.consoleErrors = consoleErrs.slice(0, 3);
      } catch (e) { entry.error = String(e.message || e).split('\n')[0]; }
      results.push(entry);
      await page.close();
    }
  } finally { await browser.close(); }
  return results;
}

async function runJob(job) {
  const { _cfg: cfg, _top: top, repoName, sha } = job;
  job.state = 'running'; job.startedAt = Date.now();
  const wtRoot = path.join(os.tmpdir(), 'repo-map-wt');
  fs.mkdirSync(wtRoot, { recursive: true });
  const wt = path.join(wtRoot, `${repoName}-${sha.slice(0, 10)}-${crypto.randomBytes(2).toString('hex')}`);
  let server = null; let child = null; let wtMade = false; let prefix = '';
  const fail = (msg) => { throw new Error(msg); };
  try {
    job.step = 'Creating a temporary copy of that commit';
    if (!(await runCmd(job, `git worktree add --detach ${wt} ${sha.slice(0, 10)}`, `git worktree add --detach ${JSON.stringify(wt)} ${sha}`, { cwd: top }))) fail('Couldn’t check out that commit into a temporary folder.');
    wtMade = true;

    const deps = await depsStrategy(top, sha, cfg);
    if (deps === 'link') {
      job.log.push({ cmd: `ln -s ${top}/node_modules ${wt}/node_modules`, status: 'ok', out: 'Same lockfile as your checkout, reusing its node_modules.', ms: 0 });
      fs.symlinkSync(path.join(top, 'node_modules'), path.join(wt, 'node_modules'), 'dir');
    } else if (deps === 'install') {
      job.step = 'Installing dependencies';
      if (!(await runCmd(job, cfg.install, cfg.install, { cwd: wt, env: cfg.env }))) fail(`Install failed (${cfg.install}). See the log.`);
    }

    let baseUrl;
    if (cfg.mode === 'build') {
      job.step = 'Building';
      const strat = baseStrategy(wt, cfg.build);
      if (strat.note) job.log.push({ cmd: `# ${strat.note}`, status: 'ok', out: '', ms: 0 });
      prefix = strat.prefix;
      if (!(await runCmd(job, strat.cmd, strat.cmd, { cwd: wt, env: { ...cfg.env, NODE_ENV: 'production' } }))) fail(`Build failed (${strat.cmd}). See the log.`);
      const dir = path.join(wt, cfg.outDir);
      if (!fs.existsSync(dir)) fail(`Build finished but “${cfg.outDir}” doesn’t exist. Check outDir in ${CONFIG_FILE}.`);
      job.step = 'Starting a local server';
      const app = express();
      const mount = (...a) => (prefix ? app.use(prefix, ...a) : app.use(...a));
      mount(express.static(dir));
      // Safety net for builds that use relative asset URLs: /deep/route/assets/x.js -> /assets/x.js
      app.use((req, res, next) => {
        const p = prefix ? req.path.slice(prefix.length) : req.path;
        if (!/\.[a-z0-9]{1,6}$/i.test(p)) return next();
        const parts = p.split('/').filter(Boolean);
        for (let i = 1; i < parts.length; i++) { const f = path.join(dir, ...parts.slice(i)); if (fs.existsSync(f) && fs.statSync(f).isFile()) return res.sendFile(f); }
        return res.status(404).end();
      });
      app.get('*', (_q, res) => res.sendFile(path.join(dir, 'index.html')));
      const port = await freePort(cfg.port + 100);
      server = await new Promise((resolve) => { const s = app.listen(port, '127.0.0.1', () => resolve(s)); });
      baseUrl = `http://127.0.0.1:${port}${prefix}`;
      job.log.push({ cmd: `serve ${path.join('$TMP', path.relative(os.tmpdir(), dir))} → ${baseUrl}`, status: 'ok', out: '', ms: 0 });
    } else {
      job.step = 'Starting the dev server';
      const port = await freePort(cfg.port + 100);
      const cmd = cfg.dev.replace(/\{port\}/g, String(port));
      const entry = { cmd, status: 'running', out: '' }; job.log.push(entry);
      child = spawn('sh', ['-c', cmd], { cwd: wt, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...cfg.env, PORT: String(port), BROWSER: 'none' } });
      const add = (d) => { entry.out = (entry.out + d.toString()).slice(-3000); };
      child.stdout.on('data', add); child.stderr.on('data', add);
      baseUrl = `http://127.0.0.1:${port}`;
      if (!(await waitUp(baseUrl, child))) { entry.status = 'failed'; fail('The dev server didn’t come up. See the log.'); }
      entry.status = 'ok';
    }

    const outDir = shotDir(repoName, sha);
    fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });
    const routes = await captureRoutes(job, baseUrl, cfg, outDir);
    const okN = routes.filter((r) => r.ok).length;
    const bad = routes.filter((r) => !r.ok);
    job.failures = bad.map((r) => ({ path: r.path, error: r.error }));
    job.hints = bad.length ? envHints(top, bad, cfg) : [];
    fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({ sha, at: new Date().toISOString(), configHash: configHash(cfg), viewport: cfg.viewport, routes, hints: job.hints }, null, 2));
    await record(top, { intent: 'screenshot', branch: job.label, cmd: `playwright: ${okN}/${routes.length} routes OK at ${cfg.viewport.width}×${cfg.viewport.height}`, ok: bad.length === 0, output: bad.map((r) => `${r.path}: ${r.error}`).join('\n') });
    if (!okN) fail(`Every route came out blank or broken — ${bad[0].error}`);
    try { fs.rmSync(failFile(repoName, sha), { force: true }); } catch { /* ignore */ }
    job.state = 'done'; job.warn = bad.length > 0;
    job.step = bad.length ? `${okN} of ${routes.length} routes OK — ${bad.length} blank or broken` : `Captured ${okN}/${routes.length} routes`;
  } catch (e) {
    job.state = 'error'; job.error = e.message; job.step = 'Failed';
    if (job.failures?.length && !job.hints) job.hints = envHints(top, job.failures, cfg);
    try { fs.mkdirSync(shotDir(repoName, sha), { recursive: true }); fs.writeFileSync(failFile(repoName, sha), JSON.stringify({ at: new Date().toISOString(), error: e.message, configHash: configHash(cfg) })); } catch { /* ignore */ }
  } finally {
    killTree(child);
    if (server) server.close();
    if (wtMade) {
      job.log.push({ cmd: `git worktree remove --force ${wt}`, status: 'running', out: '' });
      const last = job.log[job.log.length - 1];
      try { await execp('git', ['worktree', 'remove', '--force', wt], { cwd: top }); last.status = 'ok'; } catch (e) { last.status = 'failed'; last.out = e.message; }
      fs.rmSync(wt, { recursive: true, force: true });
      await execp('git', ['worktree', 'prune'], { cwd: top }).catch(() => {});
    }
  }
}

// ---- automatic capture ------------------------------------------------------
let paused = false;
export const setPaused = (v) => { paused = !!v; if (paused) jobs.filter((j) => j.auto && j.state === 'queued').forEach((j) => { j.state = 'cancelled'; j.step = 'Paused'; }); };
export const isPaused = () => paused;
const BOT = /^(dependabot|renovate)\//;

/** Pick the tips worth photographing, newest-relevance first. */
export function autoCandidates(rows, cfg) {
  const cutoff = Date.now() - cfg.autoDays * 864e5;
  const ranked = [];
  for (const r of rows) {
    if (r.merged || BOT.test(r.name)) continue;
    const sha = r.local?.full || r.remote?.fullSha;
    if (!sha) continue;
    const date = new Date(r.local?.date || r.remote?.date || 0).getTime();
    const score = r.local?.current ? 0 : r.isDefault ? 1 : r.pr && !r.pr.fork ? 2 : date >= cutoff ? 3 : null;
    if (score === null) continue;
    ranked.push({ sha, label: r.name, score, date });
  }
  ranked.sort((a, b) => a.score - b.score || b.date - a.date);
  const seen = new Set();
  return ranked.filter((x) => (seen.has(x.sha) ? false : seen.add(x.sha)));
}

export function autoCapture(top, repoName, rows, cfg) {
  const base = { enabled: cfg.autoCapture, paused, queued: 0 };
  if (!cfg.autoCapture || paused) return base;
  const pick = autoCandidates(rows, cfg).filter((x) => !isCached(repoName, x.sha, cfg) && !hasFailed(repoName, x.sha, cfg)).slice(0, cfg.autoMax);
  base.queued = enqueue(top, repoName, pick, cfg, false, true).length;
  return base;
}

/** Drop cached screenshots older than 30 days that no current branch tip needs. */
export function pruneCache(repoName, keepShas) {
  const root = cacheRoot(repoName);
  if (!fs.existsSync(root)) return 0;
  const cutoff = Date.now() - 30 * 864e5; let n = 0;
  for (const d of fs.readdirSync(root)) {
    const full = path.join(root, d);
    try {
      const old = fs.statSync(full).mtimeMs < cutoff;
      if (d === 'diffs') { for (const k of fs.readdirSync(full)) { const kp = path.join(full, k); if (fs.statSync(kp).mtimeMs < cutoff) { fs.rmSync(kp, { recursive: true, force: true }); n++; } } }
      else if (/^[0-9a-f]{40}$/.test(d) && old && !keepShas.has(d)) { fs.rmSync(full, { recursive: true, force: true }); n++; }
    } catch { /* ignore */ }
  }
  return n;
}

// ---- config hygiene ----------------------------------------------------------
/** Keep .repo-map.json out of `git status` via .git/info/exclude (local only, never committed). */
export async function excludeConfigFromGit(top) {
  const tracked = await execp('git', ['ls-files', '--error-unmatch', CONFIG_FILE], { cwd: top }).then(() => true, () => false);
  if (tracked) return { done: false, reason: `${CONFIG_FILE} is already tracked by git, so it can’t be hidden that way.` };
  const rel = await git(top, 'rev-parse', '--git-path', 'info/exclude');
  if (!rel) return { done: false, reason: 'Couldn’t find .git/info/exclude.' };
  const f = path.resolve(top, rel);
  let cur = ''; try { cur = fs.readFileSync(f, 'utf8'); } catch { /* new file */ }
  if (cur.split('\n').some((l) => l.trim() === CONFIG_FILE || l.trim() === `/${CONFIG_FILE}`)) return { done: true, already: true, file: f };
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, `${cur && !cur.endsWith('\n') ? '\n' : ''}/${CONFIG_FILE}\n`);
  return { done: true, file: f };
}
export const isExcluded = async (top) => {
  const r = await execp('git', ['check-ignore', '-q', CONFIG_FILE], { cwd: top }).then(() => true, () => false);
  return r;
};
