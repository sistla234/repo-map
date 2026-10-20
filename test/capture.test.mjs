// End-to-end check that capture is trustworthy: an auth-gated app with `base: './'`
// must (1) be reported as blank, with the reason, when env is missing and
// (2) produce real, non-blank images on deep routes once configured.
// Run: npm test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { analyze, envHints } from '../server/detect.js';
import express from 'express';
import { enqueue, listJobs, normalizeConfig, flatness, shotDir, captureRoutes } from '../server/shots.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'test', 'fixture-app');
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  ${extra}`}`); if (!ok) failed++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-fixture-'));
const top = path.join(tmp, 'fixture');
fs.cpSync(fixture, top, { recursive: true });
const git = (...a) => execFileSync('git', a, { cwd: top, stdio: 'pipe' }).toString().trim();
git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'T');
git('add', '.'); git('commit', '-qm', 'fixture');
const sha = git('rev-parse', 'HEAD');
const repoName = `fixture-test-${process.pid}`;

const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const baseCfg = { mode: 'build', build: `node ${vite} build`, outDir: 'dist', install: '', port: 5900, viewport: { width: 1000, height: 600 }, waitMs: 200, routes: ['/', '/insights/dashboards', '/settings'] };

async function capture(cfgIn) {
  const cfg = normalizeConfig(cfgIn);
  enqueue(top, repoName, [{ sha, label: 'fixture' }], cfg, true);
  for (let i = 0; i < 120; i++) {
    const j = listJobs().filter((x) => x.sha === sha).pop();
    if (j && !['queued', 'running'].includes(j.state)) return j;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('capture timed out');
}

try {
  // --- detection
  const a = analyze(top);
  check('routes: finds real pages', ['/', '/insights/dashboards', '/settings'].every((p) => a.routes.selected.some((r) => r.path === p)), JSON.stringify(a.routes.selected));
  check('routes: skips redirects', a.routes.skipped.some((s) => s.path === '/old' && /redirect/.test(s.reason)) && !a.routes.selected.some((r) => r.path === '/old' || r.path === '/insights'));
  check('routes: skips :params and wildcards', a.routes.skipped.some((s) => s.path === '/item/:id') && a.routes.skipped.some((s) => s.path === '*' || s.path === '/*'));
  const noAuth = a.env.find((e) => e.source === '.env.no-auth');
  check('env: offers .env.no-auth, withholds secrets', noAuth?.vars.VITE_NO_ENTRA_LOGIN === 'true' && !('CLIENT_SECRET' in noAuth.vars) && noAuth.withheld.includes('CLIENT_SECRET'), JSON.stringify(a.env));
  check('env: spots the login-bypass flag in code', a.env.some((e) => e.source === 'the code' && 'VITE_NO_ENTRA_LOGIN' in e.vars));
  check('base: detects relative base', a.base?.base === './');
  check('flatness: a white page counts as blank', (() => { const p = new PNG({ width: 400, height: 300 }); p.data.fill(255); return flatness(PNG.sync.write(p)) > 0.99; })());

  // --- 1. no env: must be reported as blank, with the reason, never as a success
  const bad = await capture(baseCfg);
  const reasons = (bad.failures || []).map((f) => f.error).join(' | ');
  check('missing env: not reported as a success', bad.state === 'error' || bad.warn, `${bad.state} / ${bad.step}`);
  check('missing env: step text never says "Captured N/N"', !/^Captured \d+\/\d+/.test(bad.step), bad.step);
  check('missing env: every route flagged blank with the page error', (bad.failures || []).length === 3 && (bad.failures || []).every((f) => /^blank: .*Missing Entra authentication/.test(f.error)), reasons);
  check('missing env: offers the one-click env fix', (bad.hints || []).some((h) => h.type === 'env' && h.vars.VITE_NO_ENTRA_LOGIN === 'true'), JSON.stringify(bad.hints));
  check('missing env: build used --base=/ automatically', bad.log.some((l) => /--base=\//.test(l.cmd)), bad.log.map((l) => l.cmd).join(' ; '));

  // --- 2. env applied (what the hint does): deep routes must be real pages
  const good = await capture({ ...baseCfg, env: { VITE_NO_ENTRA_LOGIN: 'true' }, storage: { localStorage: { 'welcome-seen': 'true' } } });
  check('with env: every route OK', good.state === 'done' && !good.warn && /^Captured 3\/3/.test(good.step), `${good.state} / ${good.step} / ${JSON.stringify(good.failures)}`);
  for (const slug of ['home', 'insights-dashboards', 'settings']) {
    const f = path.join(shotDir(repoName, sha), `${slug}.png`);
    const ok = fs.existsSync(f) && flatness(fs.readFileSync(f)) < 0.9;
    check(`with env: ${slug} is a real, non-blank image`, ok, fs.existsSync(f) ? `flatness ${flatness(fs.readFileSync(f))}` : 'missing');
  }
  const meta = JSON.parse(fs.readFileSync(path.join(shotDir(repoName, sha), 'meta.json'), 'utf8'));
  check('with env: deep route had no failed assets', meta.routes.every((r) => r.ok && !r.error));

  // --- 3. without the storage preset the first-run modal covers the page, which is still a real page (not blank)
  const hint = envHints(top, [{ error: 'blank: Missing Entra authentication environment variables' }], normalizeConfig(baseCfg));
  check('hint generator: proposes VITE_NO_ENTRA_LOGIN=true', hint[0]?.vars?.VITE_NO_ENTRA_LOGIN === 'true');

  // --- 4. the failed-asset check itself: serve a relative-base build with NO fallback, deep route must be caught
  {
    const proj = path.join(tmp, 'rel'); fs.cpSync(fixture, proj, { recursive: true });
    execFileSync('node', [vite, 'build'], { cwd: proj, env: { ...process.env, VITE_NO_ENTRA_LOGIN: 'true' }, stdio: 'pipe' });
    const dist = path.join(proj, 'dist');
    const app = express(); app.use(express.static(dist)); app.get('*', (_q, res) => res.sendFile(path.join(dist, 'index.html')));
    const srv = await new Promise((r) => { const s2 = app.listen(0, '127.0.0.1', () => r(s2)); });
    const out = path.join(tmp, 'out'); fs.mkdirSync(out);
    const res = await captureRoutes({ step: '' }, `http://127.0.0.1:${srv.address().port}`, normalizeConfig({ ...baseCfg, routes: ['/', '/insights/dashboards'] }), out);
    srv.close();
    const home = res.find((r) => r.path === '/'); const deep = res.find((r) => r.path === '/insights/dashboards');
    check('asset check: top-level route of a relative-base build loads', home.ok, home.error);
    check('asset check: deep route with broken asset URLs is flagged, naming the asset', !deep.ok && /assets failed to load: \/insights\/assets\/.*got HTML/.test(deep.error), deep.error);
  }

  check('no temp worktrees left behind', git('worktree', 'list').split('\n').length === 1, git('worktree', 'list'));
} catch (e) {
  console.error(e); failed++;
} finally {
  fs.rmSync(path.join(os.homedir(), '.repo-map', 'cache', repoName), { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
