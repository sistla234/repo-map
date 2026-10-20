// Project analysis for screenshot capture: routes, env hints, first-run storage flags, vite base path.
// Never reads real secret env files (.env.local etc.).
import fs from 'node:fs';
import path from 'node:path';

const SRC = /\.(jsx|tsx|js|ts|mjs)$/;

function sources(top, limit = 500) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 6 || out.length >= limit || !fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'dist' || e.name === 'build') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (SRC.test(e.name) && !/\.(test|spec)\./.test(e.name)) { try { out.push({ file: path.relative(top, p), src: fs.readFileSync(p, 'utf8').slice(0, 300000) }); } catch { /* skip */ } }
    }
  };
  walk(path.join(top, 'src'), 0);
  if (!out.length) walk(top, 3);
  return out;
}

// ---- routes ----------------------------------------------------------------
function routeTags(src) {
  const out = [];
  const re = /<Route\b|<\/Route\s*>/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[0].startsWith('</')) { out.push({ type: 'close' }); continue; }
    let i = m.index + m[0].length; let depth = 0; let q = null;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (q) { if (ch === q && src[i - 1] !== '\\') q = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
      if (ch === '{') depth++; else if (ch === '}') depth--; else if (ch === '>' && depth === 0) break;
    }
    out.push({ type: 'open', text: src.slice(m.index, i + 1), selfClosing: src[i - 1] === '/' });
    re.lastIndex = i + 1;
  }
  return out;
}
const attrPath = (t) => { const m = t.match(/\bpath\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(?:"([^"]*)"|'([^']*)'|`([^`$]*)`)\s*\})/); return m ? (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]) : null; };
const WRAPPER = /(Provider|Gate|Guard|Suspense|Layout|Wrapper|Protected|Boundary|Shell)$/;
/** The element={...} expression, so two routes only count as "the same page" when they render the same thing. */
function elementExpr(t) {
  const i = t.search(/\b(?:element|Component|component)\s*=\s*\{/);
  if (i < 0) return null;
  let j = t.indexOf('{', i); let depth = 0; const start = j;
  for (; j < t.length; j++) { if (t[j] === '{') depth++; else if (t[j] === '}') { depth--; if (!depth) break; } }
  return t.slice(start + 1, j).replace(/\s+/g, ' ').trim();
}
const pageName = (expr) => { const names = [...(expr || '').matchAll(/<\s*([A-Z][A-Za-z0-9_.]*)/g)].map((m) => m[1]); return names.find((n) => !WRAPPER.test(n)) || names[0] || null; };
const joinPath = (prefix, p) => { const full = p.startsWith('/') ? p : `${prefix}/${p}`; const n = full.replace(/\/+/g, '/').replace(/(.)\/$/, '$1'); return n || '/'; };

function parseJsxRoutes(src) {
  const found = []; const stack = [{ full: '', kids: 0 }];
  for (const tok of routeTags(src)) {
    if (tok.type === 'close') {
      const n = stack.pop();
      if (n && n.kids === 0 && n.rec) found.push(n.rec);
      continue;
    }
    const p = attrPath(tok.text); const isIndex = /\sindex(\s|\/|>|=\{?true)/.test(tok.text);
    const parent = stack[stack.length - 1];
    const full = p !== null ? joinPath(parent.full || '', p) : parent.full || '/';
    const expr = elementExpr(tok.text);
    const comp = pageName(expr) || (tok.text.match(/(?:Component|component)\s*=\s*\{\s*([A-Za-z0-9_.]+)/) || [])[1] || null;
    const nav = /^<\s*Navigate\b/.test(expr || '') || /<Navigate\b/.test(tok.text) || /Redirect$/.test(comp || '');
    const to = (tok.text.match(/<Navigate[^>]*\bto\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*["'`]([^"'`]*))/) || []).slice(1).find(Boolean) || null;
    const rec = (p !== null || isIndex) ? { path: full || '/', component: nav ? null : comp, identity: nav ? null : (expr || comp), redirect: nav, to } : null;
    parent.kids += 1;
    if (tok.selfClosing) { if (rec) found.push(rec); } else stack.push({ full: full || '', kids: 0, rec });
  }
  return found;
}

function parseObjectRoutes(src) {
  const out = [];
  for (const m of src.matchAll(/\bpath\s*:\s*["'`](\/[^"'`$]*)["'`]/g)) {
    const win = src.slice(m.index, m.index + 220);
    const nav = /Navigate\b/.test(win);
    const comp = (win.match(/element\s*:\s*<\s*([A-Za-z0-9_.]+)/) || [])[1] || null;
    out.push({ path: m[1].replace(/(.)\/$/, '$1'), component: nav ? null : comp, identity: nav ? null : win.match(/element\s*:\s*(<[^,}]*)/)?.[1] || comp, redirect: nav, to: (win.match(/\bto\s*[=:]\s*["'`]([^"'`]+)/) || [])[1] || null });
  }
  return out;
}

export function detectRoutes(srcs) {
  let all = [];
  for (const s of srcs) if (/<Route\b/.test(s.src)) all.push(...parseJsxRoutes(s.src));
  if (!all.length) for (const s of srcs) if (/createBrowserRouter|createHashRouter|useRoutes|RouterProvider/.test(s.src)) all.push(...parseObjectRoutes(s.src));
  const selected = []; const skipped = []; const seenPath = new Set(); const seenComp = new Map();
  for (const r of all) {
    if (seenPath.has(r.path)) continue;
    seenPath.add(r.path);
    if (r.redirect) { skipped.push({ path: r.path, reason: `redirects${r.to ? ` to ${r.to}` : ''}` }); continue; }
    if (/:|\*/.test(r.path)) { skipped.push({ path: r.path, reason: r.path.includes('*') ? 'wildcard route' : 'has a parameter (needs a real id)' }); continue; }
    if (r.identity && seenComp.has(r.identity)) { skipped.push({ path: r.path, reason: `renders the same thing as ${seenComp.get(r.identity)}` }); continue; }
    if (r.identity) seenComp.set(r.identity, r.path);
    selected.push({ path: r.path, component: r.component });
  }
  if (!selected.length) selected.push({ path: '/', component: null });
  return { selected: selected.slice(0, 12), overflow: Math.max(0, selected.length - 12), skipped, found: all.length };
}

// ---- env -------------------------------------------------------------------
const SECRETISH = /SECRET|PASSWORD|PRIVATE|TOKEN|API_?KEY|CREDENTIAL/i;
const BYPASS = /(NO|SKIP|DISABLE|DISABLED|BYPASS|MOCK|DEMO|FAKE)_[A-Z0-9_]*(LOGIN|AUTH|SSO|ENTRA|OIDC|MSAL)|(LOGIN|AUTH|SSO|ENTRA|OIDC|MSAL)_[A-Z0-9_]*(DISABLED?|BYPASS|OFF|MOCK|SKIP)/;

function parseEnvFile(f) {
  const vars = {};
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    vars[m[1]] = m[2].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
  }
  return vars;
}

export function detectEnv(top, srcs) {
  const out = [];
  for (const [file, defaultOn] of [['.env.no-auth', true], ['.env.test', true], ['.env.example', false]]) {
    const f = path.join(top, file);
    if (!fs.existsSync(f)) continue;
    let all; try { all = parseEnvFile(f); } catch { continue; }
    const vars = {}; const withheld = [];
    for (const [k, v] of Object.entries(all)) { if (SECRETISH.test(k)) withheld.push(k); else vars[k] = v; }
    if (Object.keys(vars).length) out.push({ source: file, vars, withheld, defaultOn, note: file === '.env.example' ? 'Placeholder values — usually not enough to render anything real.' : 'Meant for running without real credentials.' });
  }
  const flags = new Set();
  for (const s of srcs) for (const m of s.src.matchAll(/(?:import\.meta\.env|process\.env)\.((?:VITE|REACT_APP|NEXT_PUBLIC)_[A-Z0-9_]+)/g)) if (BYPASS.test(m[1])) flags.add(m[1]);
  if (flags.size) out.push({ source: 'the code', vars: Object.fromEntries([...flags].map((k) => [k, 'true'])), withheld: [], defaultOn: true, note: 'The code reads these and they look like login bypass switches.' });
  return out;
}

// ---- first-run storage flags ----------------------------------------------
export function detectStorage(srcs) {
  const keys = new Map();
  for (const s of srcs) for (const m of s.src.matchAll(/\b(local|session)Storage\s*\.\s*(?:getItem|setItem)\(\s*["'`]([^"'`$]+)["'`]/g)) {
    if (/onboard|tour|welcome|intro|dismiss|seen|first|walkthrough|tutorial|coach|announce|hint/i.test(m[2])) keys.set(`${m[1]}:${m[2]}`, { store: `${m[1]}Storage`, key: m[2], file: s.file });
  }
  return [...keys.values()].slice(0, 12);
}

// ---- vite base path ----------------------------------------------------------
export function viteBase(dir) {
  for (const f of ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    const m = src.match(/\bbase\s*:\s*["'`]([^"'`]*)["'`]/);
    return { config: f, base: m ? m[1] : '/', explicit: !!m };
  }
  return null;
}

/** For vite builds with a relative or non-root base, work out how to render deep routes. */
export function baseStrategy(dir, buildCmd) {
  const v = viteBase(dir);
  if (!v || v.base === '/' || /--base\b/.test(buildCmd || '')) return { cmd: buildCmd, prefix: '', note: null };
  if (v.base === '' || v.base === './' || v.base === '.') {
    const cmd = /^npm (run|run-script)\b/.test(buildCmd) && !/\s--\s/.test(buildCmd) ? `${buildCmd} -- --base=/` : `${buildCmd} --base=/`;
    return { cmd, prefix: '', note: `${v.config} sets base: '${v.base}', so deep routes would load assets from the wrong folder. Building with --base=/ for captures.` };
  }
  const prefix = `/${v.base.replace(/^\/+|\/+$/g, '')}`;
  return { cmd: buildCmd, prefix, note: `${v.config} sets base: '${v.base}'. Serving the build under ${prefix}/.` };
}

export function analyze(top) {
  const srcs = sources(top);
  return { routes: detectRoutes(srcs), env: detectEnv(top, srcs), storage: detectStorage(srcs), base: viteBase(top) };
}

/** After a capture, turn "missing env var" style failures into a one-click config fix. */
export function envHints(top, failures, cfg) {
  const text = failures.map((f) => f.error || '').join(' | ');
  if (!/missing|undefined|not set|not defined|required|must be set/i.test(text)) return [];
  if (!/env|environment|VITE_|REACT_APP_|NEXT_PUBLIC_|variable/i.test(text)) return [];
  const a = analyze(top);
  const vars = {};
  for (const c of a.env) if (c.source === 'the code') for (const [k, v] of Object.entries(c.vars)) if (!(k in (cfg.env || {}))) vars[k] = v;
  for (const m of text.matchAll(/\b((?:VITE|REACT_APP|NEXT_PUBLIC)_[A-Z0-9_]+)\b/g)) if (!(m[1] in (cfg.env || {})) && !(m[1] in vars)) vars[m[1]] = '';
  if (!Object.keys(vars).length) return [];
  return [{ type: 'env', vars, label: `Add ${Object.entries(vars).map(([k, v]) => `${k}=${v || '…'}`).join(', ')} to the config and re-capture` }];
}
