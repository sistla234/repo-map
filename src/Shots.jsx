import React, { useEffect, useRef, useState } from 'react';
import { api } from './Actions.jsx';

const envToText = (env) => Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
const textToEnv = (t) => Object.fromEntries(t.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

function initialRoutes(initial, hints, existing) {
  const rows = initial.routes.map((r) => ({ path: r.path, name: r.name && r.name !== r.path ? r.name : '', waitFor: r.waitFor || '', on: true }));
  const have = new Set(rows.map((r) => r.path));
  for (const r of hints?.routes?.selected || []) if (!have.has(r.path)) { rows.push({ path: r.path, name: r.component || '', waitFor: '', on: false, note: existing ? 'found in your router' : '' }); have.add(r.path); }
  for (const r of hints?.routes?.skipped || []) if (!have.has(r.path)) { rows.push({ path: r.path, name: '', waitFor: '', on: false, note: `skipped: ${r.reason}` }); have.add(r.path); }
  return rows;
}

function ConfigForm({ initial, hints, onSaved, saving, setSaving, existing }) {
  const [c, setC] = useState(() => ({ ...initial }));
  const [routes, setRoutes] = useState(() => initialRoutes(initial, hints, existing));
  const [envText, setEnvText] = useState(() => envToText(initial.env));
  const [storageText, setStorageText] = useState(() => (initial.storage && (Object.keys(initial.storage.localStorage || {}).length || Object.keys(initial.storage.sessionStorage || {}).length) ? JSON.stringify(initial.storage, null, 2) : ''));
  const [newRoute, setNewRoute] = useState('');
  const [exclude, setExclude] = useState(true);
  const [err, setErr] = useState(null);
  const set = (k, v) => setC((x) => ({ ...x, [k]: v }));
  const setRoute = (i, patch) => setRoutes((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const envNow = textToEnv(envText);
  const base = hints?.base && hints.base.base !== '/' ? hints.base : null;

  const addEnv = (vars) => setEnvText((t) => `${t.trim() ? `${t.trim()}\n` : ''}${Object.entries(vars).filter(([k]) => !(k in textToEnv(t))).map(([k, v]) => `${k}=${v}`).join('\n')}`);
  const addStorage = (cand) => {
    let cur = {}; try { cur = storageText ? JSON.parse(storageText) : {}; } catch { /* keep */ }
    cur[cand.store] = { ...(cur[cand.store] || {}), [cand.key]: 'true' };
    setStorageText(JSON.stringify(cur, null, 2));
  };

  const save = async () => {
    setErr(null);
    let storage = {};
    if (storageText.trim()) { try { storage = JSON.parse(storageText); } catch { setErr('The storage presets aren’t valid JSON.'); return; } }
    const chosen = routes.filter((r) => r.on && r.path.startsWith('/'));
    if (!chosen.length) { setErr('Pick at least one route (paths start with “/”).'); return; }
    setSaving(true);
    const r = await api('/api/shots/config', {
      exclude,
      config: {
        ...c, env: envNow, storage, port: Number(c.port), waitMs: Number(c.waitMs),
        routes: chosen.map((x) => ({ path: x.path, ...(x.name ? { name: x.name } : {}), ...(x.waitFor ? { waitFor: x.waitFor } : {}) })),
        viewport: { width: Number(c.vw ?? c.viewport.width), height: Number(c.vh ?? c.viewport.height) },
      },
    });
    setSaving(false);
    if (r.ok) onSaved(r.data); else setErr(r.data.error);
  };

  return (
    <div className="form cfg">
      {!existing && <div className="note">No <code>.repo-map.json</code> in this repo yet. I worked these settings out from <code>package.json</code>, your router and any <code>.env.no-auth</code>/<code>.env.test</code>. Check them, then save.</div>}

      <h4>How to render</h4>
      <label>Mode
        <select value={c.mode} onChange={(e) => set('mode', e.target.value)}>
          <option value="build">Build it, then serve the output (faster, steadier)</option>
          <option value="dev">Run the dev server</option>
        </select>
      </label>
      <label>Install command <input value={c.install} onChange={(e) => set('install', e.target.value)} placeholder="npm ci   (only used if the lockfile differs from your checkout)" /></label>
      {c.mode === 'build' ? (
        <div className="row2">
          <label>Build command <input value={c.build} onChange={(e) => set('build', e.target.value)} placeholder="npm run build" /></label>
          <label>Output folder <input value={c.outDir} onChange={(e) => set('outDir', e.target.value)} placeholder="dist" /></label>
        </div>
      ) : (
        <label>Dev command <span className="muted">({'{port}'} is replaced with a free port)</span><input value={c.dev} onChange={(e) => set('dev', e.target.value)} placeholder="npm run dev -- --port {port}" /></label>
      )}
      {base && c.mode === 'build' && <div className="note">✓ <code>{base.config}</code> sets <code>base: '{base.base}'</code>. Repo Map handles this automatically for captures (building with <code>--base=/</code> or serving under the base path), so deep routes won’t come out blank.</div>}

      <h4>Pages to photograph</h4>
      <div className="routes-table">
        <div className="rrow muted"><span /><span>Route</span><span>Label</span><span>Wait for selector</span></div>
        {routes.map((r, i) => (
          <React.Fragment key={r.path + i}>
            <div className={`rrow ${r.on ? '' : 'off'}`}>
              <input type="checkbox" checked={r.on} onChange={(e) => setRoute(i, { on: e.target.checked })} />
              <code>{r.path}</code>
              <input value={r.name} placeholder="label" onChange={(e) => setRoute(i, { name: e.target.value })} />
              <input value={r.waitFor} placeholder="e.g. [data-ready]" onChange={(e) => setRoute(i, { waitFor: e.target.value })} />
              {r.note && <div className="rreason">{r.note}</div>}
            </div>
          </React.Fragment>
        ))}
        <div className="ptcustom"><input value={newRoute} placeholder="add a route, e.g. /settings" onChange={(e) => setNewRoute(e.target.value)} /><button disabled={!newRoute.startsWith('/')} onClick={() => { setRoutes((rs) => [...rs, { path: newRoute, name: '', waitFor: '', on: true }]); setNewRoute(''); }}>Add</button></div>
        {hints?.routes?.overflow > 0 && <div className="muted small">{hints.routes.overflow} more distinct routes were found; add the ones you want.</div>}
      </div>

      <h4>Environment for the build</h4>
      <div className="muted small">Variables set here are used when building each commit. Your real <code>.env.local</code> is never read or copied.</div>
      <textarea rows={Math.max(2, Object.keys(envNow).length + 1)} value={envText} placeholder="VITE_NO_ENTRA_LOGIN=true" onChange={(e) => setEnvText(e.target.value)} />
      {hints?.env?.length > 0 && (
        <div className="cands">
          {hints.env.map((e) => (
            <div key={e.source}>Found in <code>{e.source}</code>: {Object.entries(e.vars).map(([k, v]) => `${k}=${v}`).join(', ')} <button onClick={() => addEnv(e.vars)}>Add</button> <span>{e.note}</span>
              {e.withheld?.length > 0 && <span> (left out as secret-looking: {e.withheld.join(', ')})</span>}</div>
          ))}
        </div>
      )}

      <h4>First-run state (optional)</h4>
      <div className="muted small">Pre-set browser storage so welcome tours and modals don’t cover the page. JSON, e.g. <code>{'{"localStorage": {"onboarding-seen": "true"}}'}</code></div>
      <textarea rows={storageText ? 4 : 2} value={storageText} placeholder='{"localStorage": {"welcome-dismissed": "true"}}' onChange={(e) => setStorageText(e.target.value)} />
      {hints?.storage?.length > 0 && <div className="cands">{hints.storage.map((x) => <div key={x.store + x.key}>The code uses <code>{x.store}.{x.key}</code> <span>({x.file})</span> <button onClick={() => addStorage(x)}>Set to “true”</button></div>)}</div>}

      <h4>Screenshot settings</h4>
      <div className="row3">
        <label>Width <input value={c.vw ?? c.viewport.width} onChange={(e) => set('vw', e.target.value)} /></label>
        <label>Height <input value={c.vh ?? c.viewport.height} onChange={(e) => set('vh', e.target.value)} /></label>
        <label>Port (start) <input value={c.port} onChange={(e) => set('port', e.target.value)} /></label>
      </div>
      <div className="row3">
        <label>Extra wait (ms) <input value={c.waitMs} onChange={(e) => set('waitMs', e.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={!!c.fullPage} onChange={(e) => set('fullPage', e.target.checked)} /> Capture the full page</label>
      </div>
      <label className="check"><input type="checkbox" checked={exclude} onChange={(e) => setExclude(e.target.checked)} /> Keep <code>.repo-map.json</code> out of git status <span className="muted">(adds it to .git/info/exclude — local to you, never committed)</span></label>
      {err && <div className="outcome failed">{err}</div>}
      <div className="mfoot"><button className="act primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : existing ? 'Save changes' : 'Save .repo-map.json and continue'}</button></div>
    </div>
  );
}

async function applyHint(hint, job) {
  const r = await api('/api/shots/env', { vars: hint.vars });
  if (!r.ok) return r.data.error;
  await api('/api/shots/run', { items: [{ sha: job.sha, label: job.label }], force: true });
  return null;
}

function JobRow({ j, open, toggle }) {
  const [msg, setMsg] = useState(null);
  return (
    <div className={`job ${j.state} ${j.warn ? 'warn' : ''}`}>
      <div className="jhead" onClick={toggle}>
        <span className="jstate">{j.state === 'done' ? (j.warn ? '⚠' : '✓') : j.state === 'error' ? '✗' : j.state === 'running' ? '…' : j.state === 'cancelled' ? '–' : '·'}</span>
        <b>{j.label}</b> <code>{j.sha.slice(0, 7)}</code> {j.auto && <span className="pill alt">auto</span>} <span className="muted">{j.state === 'error' ? j.error : j.step}</span>
      </div>
      {j.failures?.length > 0 && (
        <div className="jfail">{j.failures.slice(0, open ? 30 : 4).map((f) => <div key={f.path}><code>{f.path}</code> {f.error}</div>)}{!open && j.failures.length > 4 && <div className="muted">…and {j.failures.length - 4} more</div>}</div>
      )}
      {j.warnings?.length > 0 && <div className="jfail warn">{j.warnings.map((w) => <div key={w.path}>⚠ <code>{w.path}</code> {w.warning}</div>)}</div>}
      {open && j.notes?.length > 0 && <div className="jfail">{j.notes.map((n) => <div key={n} className="muted">ⓘ {n}</div>)}</div>}
      {j.hints?.length > 0 && (
        <div className="jhints">{j.hints.map((h) => <button key={h.label} className="act primary" onClick={async () => setMsg(await applyHint(h, j))}>{h.label}</button>)}</div>
      )}
      {msg && <div className="note warn">{msg}</div>}
      {(open || j.state === 'error') && j.log.map((l, i) => (
        <div key={i} className="jlog"><code className={`cmdline ${l.status}`}>{l.status === 'ok' ? '✓' : l.status === 'failed' ? '✗' : '…'} {l.cmd}</code>{l.out && (l.status === 'failed' || open) && <pre>{l.out.slice(-1200)}</pre>}</div>
      ))}
    </div>
  );
}

export function JobsModal({ onClose, paused, onTogglePause }) {
  const [jobs, setJobs] = useState([]);
  const [open, setOpen] = useState({});
  useEffect(() => {
    const load = async () => { const r = await api('/api/shots/status'); if (r.ok) setJobs([...r.data].reverse()); };
    load(); const t = setInterval(load, 1500); return () => clearInterval(t);
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <div className="mhead"><h2>Screenshot activity</h2><button className="link" onClick={onClose}>✕</button></div>
        <div className="muted">Screenshots are captured in the background for your current branch, main, open PRs and recently active branches. Each runs in a temporary copy, never in your working folder.</div>
        <div><button onClick={onTogglePause}>{paused ? '▶ Resume auto-capture' : '⏸ Pause auto-capture'}</button></div>
        {jobs.length === 0 && <div className="muted">Nothing has run yet.</div>}
        {jobs.map((j) => <JobRow key={j.id} j={j} open={open[j.id]} toggle={() => setOpen({ ...open, [j.id]: !open[j.id] })} />)}
      </div>
    </div>
  );
}

export function CaptureModal({ items, initialForce = false, onClose, onDone }) {
  const [cfg, setCfg] = useState(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [plan, setPlan] = useState(null);
  const [force, setForce] = useState(initialForce);
  const [jobs, setJobs] = useState(null);
  const [open, setOpen] = useState({});
  const [err, setErr] = useState(null);
  const [savedMsg, setSavedMsg] = useState(false);
  const shas = useRef(new Set(items.map((i) => i.sha)));

  const loadCfg = async () => { const r = await api('/api/shots/config'); setCfg(r.data); setEditing(!r.data.exists); };
  useEffect(() => { loadCfg(); }, []);
  useEffect(() => {
    if (!cfg?.exists || editing || jobs) return;
    (async () => { const r = await api('/api/shots/plan', { items, force }); if (r.ok) setPlan(r.data); else setErr(r.data.error); })();
  }, [cfg, editing, force, items, jobs]);
  useEffect(() => {
    if (!jobs) return undefined;
    const t = setInterval(async () => { const r = await api('/api/shots/status'); if (r.ok) setJobs(r.data.filter((j) => shas.current.has(j.sha))); }, 1200);
    return () => clearInterval(t);
  }, [jobs]);

  const todo = plan?.items.filter((i) => !i.cached) || [];
  const active = jobs?.some((j) => ['queued', 'running'].includes(j.state));
  const start = async () => {
    const r = await api('/api/shots/run', { items: todo.map((i) => ({ sha: i.sha, label: i.label })), force });
    if (!r.ok) { setErr(r.data.error); return; }
    const s = await api('/api/shots/status'); setJobs(s.data.filter((j) => shas.current.has(j.sha)));
  };
  const finished = jobs && !active;
  useEffect(() => { if (finished) onDone(); }, [finished]); // eslint-disable-line

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !active && onClose()}>
      <div className="modal wide">
        <div className="mhead"><h2>Capture screenshots</h2><button className="link" onClick={onClose} disabled={active}>✕</button></div>

        {!cfg && <div className="muted">Looking at your project…</div>}
        {cfg?.error && <div className="outcome failed">{cfg.error}</div>}
        {cfg && editing && !jobs && <ConfigForm key={cfg.exists ? 'e' : 'n'} initial={cfg.config || cfg.detected} hints={cfg.hints} existing={cfg.exists} saving={saving} setSaving={setSaving} onSaved={async () => { await loadCfg(); setEditing(false); setPlan(null); if (!items.length) { setSavedMsg(true); onDone(); } }} />}

        {savedMsg && <><div className="outcome">Saved <code>.repo-map.json</code>. From now on, screenshots of your current branch, main, open PRs and recently active branches are captured automatically in the background. You can pause this from the header.</div><div className="mfoot"><button className="act primary" onClick={onClose}>Got it</button></div></>}
        {cfg?.exists && !editing && !jobs && !savedMsg && items.length > 0 && (
          <>
            {err && <div className="outcome failed">{err}</div>}
            {!plan && !err && <div className="muted">Checking what’s already captured…</div>}
            {plan && (
              <>
                <div className="muted">Each commit is checked out into a temporary folder (your working copy is never touched), built, photographed, and the folder is deleted. Settings come from <code>.repo-map.json</code>. <button className="link" onClick={() => setEditing(true)}>Edit settings</button></div>
                <div className="dgroup">
                  <div className="dtitle">Commits ({plan.items.length})</div>
                  {plan.items.map((i) => <div key={i.sha} className="dcommit"><code>{i.sha.slice(0, 7)}</code> {i.label} {i.cached ? <span className="ok-tag">already captured</span> : <span className="muted">· {i.deps === 'link' ? 'reuses your node_modules' : i.deps === 'install' ? 'needs its own install' : 'no install'}</span>}</div>)}
                </div>
                {todo.length > 0 && (
                  <>
                    <div className="dtitle">Commands that will run for each new commit</div>
                    <pre className="cmdblock">{todo[0].steps.join('\n')}</pre>
                    <div className="note">{todo.length} commit{todo.length > 1 ? 's' : ''}, one after another. {plan.config.mode === 'build' ? 'Builds can take a minute each.' : ''} Routes: {plan.config.routes.map((r) => r.path).join(', ')}</div>
                  </>
                )}
                {todo.length === 0 && <div className="outcome">Everything here is already captured.</div>}
                <label className="check"><input type="checkbox" checked={force} onChange={(e) => { setForce(e.target.checked); setPlan(null); }} /> Re-capture even if already cached</label>
                <div className="mfoot">
                  <button onClick={onClose}>Cancel</button>
                  <button className="act primary" disabled={!todo.length} onClick={start}>Capture {todo.length || ''} commit{todo.length === 1 ? '' : 's'}</button>
                </div>
              </>
            )}
          </>
        )}

        {jobs && (
          <>
            {jobs.map((j) => <JobRow key={j.id} j={j} open={open[j.id]} toggle={() => setOpen({ ...open, [j.id]: !open[j.id] })} />)}
            <div className="mfoot"><button className="act primary" disabled={active} onClick={onClose}>{active ? 'Working…' : 'Done'}</button></div>
          </>
        )}
      </div>
    </div>
  );
}
