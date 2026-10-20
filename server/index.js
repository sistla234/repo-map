import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadMap } from './git.js';
import { execFileSync, spawn } from 'node:child_process';
import { plan, run, rebaseControl, getHistory, operationState } from './actions.js';
import { readConfig, detectConfig, writeConfig, normalizeConfig, planShots, enqueue, listJobs, shotsIndex, shotDir, cacheRoot, autoCapture, setPaused, isPaused, pruneCache, clearFailures, excludeConfigFromGit, isExcluded } from './shots.js';
import { analyze } from './detect.js';
import { resolveRev, mergeBase, describeCommit, compareShots, diffFiles, diffPatch } from './compare.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../dist');

function findPort(start) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(findPort(start + 1)));
    s.once('listening', () => s.close(() => resolve(start)));
    s.listen(start, '127.0.0.1');
  });
}

export async function start({ repoPath, port }) {
  const app = express();
  app.use(express.json());
  const top = execFileSync('git', ['-C', repoPath, 'rev-parse', '--show-toplevel']).toString().trim();
  const repoName = path.basename(top);
  const startedAt = Date.now();
  const version = JSON.parse(fs.readFileSync(path.resolve(here, '../package.json'), 'utf8')).version;
  const newest = (dir, re) => { let m = 0; try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) m = Math.max(m, newest(p, re)); else if (re.test(e.name)) m = Math.max(m, fs.statSync(p).mtimeMs); } } catch { /* missing */ } return m; };
  const appInfo = () => {
    const uiBuiltAt = newest(dist, /./); const serverChangedAt = newest(here, /\.js$/);
    return { version, startedAt, uiBuiltAt, stale: serverChangedAt > startedAt + 1000 || uiBuiltAt > startedAt + 1000, staleReason: serverChangedAt > startedAt + 1000 ? 'The server code changed after this server started.' : uiBuiltAt > startedAt + 1000 ? 'The interface was rebuilt after this server started.' : null };
  };
  const HEX = /^[0-9a-f]{40}$/;

  // Mutating endpoints: JSON only, and only from this app's own origin (blocks drive-by requests from other sites)
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET') return next();
    const origin = req.get('origin');
    const ok = req.is('application/json') && (!origin || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin));
    return ok ? next() : res.status(403).json({ error: 'Forbidden' });
  });
  const wrap = (fn) => async (req, res) => {
    try { const r = await fn(req); res.status(r.status || 200).json(r.body); } catch (e) { res.status(500).json({ error: e.message }); }
  };
  app.post('/api/plan', wrap(async (req) => { const { _exec, ...p } = await plan(repoPath, req.body); return { body: p }; }));
  app.post('/api/run', wrap((req) => run(repoPath, req.body.params, req.body.token)));
  app.post('/api/rebase', wrap((req) => rebaseControl(repoPath, req.body.action === 'abort' ? 'abort' : 'continue')));
  app.get('/api/history', wrap(async () => ({ body: await getHistory(repoPath) })));

  app.get('/api/ping', (_q, res) => res.json({ app: 'repo-map', repo: top, ...appInfo() }));

  // ---- screenshots & compare ----
  const items = async (list) => {
    const out = [];
    for (const it of (Array.isArray(list) ? list : []).slice(0, 40)) {
      const sha = await resolveRev(repoPath, it?.sha);
      if (sha) out.push({ sha, label: String(it.label || sha.slice(0, 7)).slice(0, 80) });
    }
    return out;
  };
  const cfgOrErr = () => {
    const c = readConfig(top);
    if (!c.exists) return { err: { status: 409, body: { error: `No ${'.repo-map.json'} yet. Confirm the detected settings first.` } } };
    if (c.error) return { err: { status: 400, body: { error: c.error } } };
    return { cfg: c.config };
  };
  app.get('/api/shots/config', wrap(async () => {
    const c = readConfig(top);
    const hints = analyze(top);
    return { body: { exists: c.exists, error: c.error || null, path: c.path, config: c.config || null, hints, excluded: c.exists ? await isExcluded(top) : null, detected: c.exists ? null : normalizeConfig(detectConfig(top, hints)) } };
  }));
  app.post('/api/shots/config', wrap(async (req) => {
    const cfg = normalizeConfig(req.body.config);
    if (cfg.mode === 'build' && !cfg.build) return { status: 400, body: { error: 'Build mode needs a build command.' } };
    if (cfg.mode === 'dev' && !cfg.dev) return { status: 400, body: { error: 'Dev mode needs a dev command (use {port} where the port goes).' } };
    writeConfig(top, { ...cfg, routes: cfg.routes });
    clearFailures(repoName);
    const ex = req.body.exclude === false ? null : await excludeConfigFromGit(top);
    return { body: { ok: true, config: readConfig(top).config, exclude: ex } };
  }));
  app.post('/api/shots/env', wrap(async (req) => {
    const c = readConfig(top);
    if (!c.exists || c.error) return { status: 409, body: { error: 'No valid .repo-map.json yet.' } };
    const vars = Object.fromEntries(Object.entries(req.body.vars || {}).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string'));
    if (!Object.keys(vars).length) return { status: 400, body: { error: 'No variables to add.' } };
    writeConfig(top, { ...c.config, env: { ...c.config.env, ...vars } });
    clearFailures(repoName);
    return { body: { ok: true, env: readConfig(top).config.env } };
  }));
  app.post('/api/restart', wrap(async () => {
    const args = [path.resolve(here, '../bin/repo-map.js'), top, '--no-open'];
    setTimeout(() => {
      spawn('sh', ['-c', `sleep 1; exec "$0" "$@" >/dev/null 2>&1`, process.execPath, ...args], { detached: true, stdio: 'ignore', env: { ...process.env, PORT: String(app.get('port')) } }).unref();
      process.exit(0);
    }, 300);
    return { body: { restarting: true } };
  }));
  app.post('/api/shots/plan', wrap(async (req) => {
    const { cfg, err } = cfgOrErr(); if (err) return err;
    return { body: { config: cfg, items: await planShots(top, repoName, await items(req.body.items), cfg, !!req.body.force) } };
  }));
  app.post('/api/shots/run', wrap(async (req) => {
    const { cfg, err } = cfgOrErr(); if (err) return err;
    return { body: { queued: enqueue(top, repoName, await items(req.body.items), cfg, !!req.body.force) } };
  }));
  app.get('/api/shots/status', wrap(async () => ({ body: listJobs() })));
  app.post('/api/shots/auto', wrap(async (req) => { setPaused(req.body.paused); return { body: { paused: isPaused() } }; }));
  app.get('/api/shot/:sha/:file', (req, res) => {
    if (!HEX.test(req.params.sha) || !/^[\w.-]+\.png$/.test(req.params.file)) return res.status(400).end();
    res.set('Cache-Control', 'no-cache').sendFile(req.params.file, { root: shotDir(repoName, req.params.sha) }, (e) => e && !res.headersSent && res.status(404).end());
  });
  app.get('/api/diffimg/:key/:file', (req, res) => {
    if (!/^[0-9a-f]{12}_[0-9a-f]{12}$/.test(req.params.key) || !/^[\w.-]+\.png$/.test(req.params.file)) return res.status(400).end();
    res.set('Cache-Control', 'no-cache').sendFile(req.params.file, { root: path.join(cacheRoot(repoName), 'diffs', req.params.key) }, (e) => e && !res.headersSent && res.status(404).end());
  });
  app.get('/api/resolve', wrap(async (req) => {
    const sha = await resolveRev(repoPath, req.query.rev);
    return sha ? { body: await describeCommit(repoPath, sha) } : { status: 404, body: { error: `“${req.query.rev}” isn’t a commit in this repo.` } };
  }));
  app.get('/api/mergebase', wrap(async (req) => {
    const [a, b] = [await resolveRev(repoPath, req.query.a), await resolveRev(repoPath, req.query.b)];
    if (!a || !b) return { status: 404, body: { error: 'Unknown commit.' } };
    const mb = await mergeBase(repoPath, a, b);
    return mb ? { body: await describeCommit(repoPath, mb) } : { status: 404, body: { error: 'No common ancestor.' } };
  }));
  app.post('/api/compare', wrap(async (req) => {
    const [a, b] = [await resolveRev(repoPath, req.body.a), await resolveRev(repoPath, req.body.b)];
    if (!a || !b) return { status: 404, body: { error: 'Unknown commit.' } };
    return { body: { a: await describeCommit(repoPath, a), b: await describeCommit(repoPath, b), ...compareShots(repoName, a, b) } };
  }));
  app.get('/api/diff/files', wrap(async (req) => {
    const [a, b] = [await resolveRev(repoPath, req.query.a), await resolveRev(repoPath, req.query.b)];
    if (!a || !b) return { status: 404, body: { error: 'Unknown commit.' } };
    const files = await diffFiles(repoPath, a, b, req.query.three === '1');
    return files ? { body: { files, command: `git diff --name-status ${a.slice(0, 7)}${req.query.three === '1' ? '...' : '..'}${b.slice(0, 7)}` } } : { status: 500, body: { error: 'git diff failed.' } };
  }));
  app.get('/api/diff/patch', wrap(async (req) => {
    const [a, b] = [await resolveRev(repoPath, req.query.a), await resolveRev(repoPath, req.query.b)];
    if (!a || !b) return { status: 404, body: { error: 'Unknown commit.' } };
    const patch = await diffPatch(repoPath, a, b, req.query.three === '1', String(req.query.path || ''));
    return patch === null ? { status: 404, body: { error: 'That file isn’t part of this diff.' } } : { body: { patch } };
  }));

  app.get('/api/map', async (req, res) => {
    try {
      const map = await loadMap(repoPath, { fetch: req.query.fetch !== '0' });
      const tips = map.rows.flatMap((r) => [r.local?.full, r.remote?.fullSha, r.pr?.headSha]);
      const operation = await operationState(repoPath);
      const conf = readConfig(top);
      let auto = { enabled: false, paused: isPaused(), queued: 0 };
      if (conf.exists && conf.config && !operation && req.query.auto !== '0') {
        auto = autoCapture(top, repoName, map.rows, conf.config);
        pruneCache(repoName, new Set(tips.filter(Boolean)));
      } else if (conf.config) auto.enabled = conf.config.autoCapture;
      res.json({ ...map, operation, shots: shotsIndex(repoName, tips), shotsConfigured: conf.exists, auto, app: appInfo() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  const p = await findPort(port || Number(process.env.PORT) || 4747);
  app.set('port', p);
  await new Promise((r) => app.listen(p, '127.0.0.1', r));
  const reg = path.join(os.homedir(), '.repo-map', 'servers');
  fs.mkdirSync(reg, { recursive: true });
  const regFile = path.join(reg, `${path.basename(top)}-${crypto.createHash('sha1').update(top).digest('hex').slice(0, 6)}.json`);
  fs.writeFileSync(regFile, JSON.stringify({ repo: top, port: p, pid: process.pid }));
  const bye = () => { try { fs.unlinkSync(regFile); } catch { /* gone */ } process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye); process.on('exit', () => { try { fs.unlinkSync(regFile); } catch { /* gone */ } });
  return { port: p, url: `http://localhost:${p}` };
}

// Dev mode: `REPO_PATH=... node server/index.js`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await start({ repoPath: path.resolve(process.env.REPO_PATH || process.cwd()), port: 4747 });
  console.log(`Repo Map API on ${url}`);
}
