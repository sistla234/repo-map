import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './Actions.jsx';

const pctTone = (p) => (p === undefined ? '' : p < 0.01 ? 'same' : p < 2 ? 'small' : p < 15 ? 'mid' : 'big');
const fmtPct = (p) => (p < 0.01 ? 'no change' : p < 0.1 ? '<0.1% changed' : `${p.toFixed(p < 10 ? 1 : 0)}% changed`);

function PointSelect({ label, value, points, onPick, onCustom }) {
  const [custom, setCustom] = useState('');
  const [err, setErr] = useState(null);
  const groups = [...new Set(points.map((p) => p.group))];
  const resolve = async () => {
    const r = await api(`/api/resolve?rev=${encodeURIComponent(custom.trim())}`);
    if (r.ok) { onCustom({ sha: r.data.sha, label: `${r.data.short} ${r.data.subject.slice(0, 40)}`, group: 'Other commits' }); setCustom(''); setErr(null); } else setErr(r.data.error);
  };
  return (
    <div className="pt">
      <div className="ptlabel">{label}</div>
      <select value={value?.sha || ''} onChange={(e) => onPick(points.find((p) => p.sha === e.target.value))}>
        {!value && <option value="">Choose…</option>}
        {groups.map((g) => <optgroup key={g} label={g}>{points.filter((p) => p.group === g).map((p) => <option key={p.sha + p.label} value={p.sha}>{p.label} · {p.sha.slice(0, 7)}</option>)}</optgroup>)}
      </select>
      <div className="ptcustom">
        <input value={custom} placeholder="or any commit / branch / tag" onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && custom && resolve()} />
        <button onClick={resolve} disabled={!custom}>Use</button>
      </div>
      {err && <div className="note warn">{err}</div>}
    </div>
  );
}

function Patch({ patch }) {
  return <pre className="patch">{patch.split('\n').map((l, i) => <div key={i} className={l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff') || l.startsWith('index') ? 'ph' : l.startsWith('@@') ? 'pk' : l[0] === '+' ? 'pa' : l[0] === '-' ? 'pd' : ''}>{l || ' '}</div>)}</pre>;
}

function FilesTab({ a, b, three }) {
  const [res, setRes] = useState(null);
  const [open, setOpen] = useState({});
  useEffect(() => { setRes(null); setOpen({}); api(`/api/diff/files?a=${a.sha}&b=${b.sha}&three=${three ? 1 : 0}`).then((r) => setRes(r.ok ? r.data : { error: r.data.error })); }, [a.sha, b.sha, three]);
  const toggle = async (f) => {
    if (open[f.path]) { setOpen({ ...open, [f.path]: null }); return; }
    setOpen({ ...open, [f.path]: { loading: true } });
    const r = await api(`/api/diff/patch?a=${a.sha}&b=${b.sha}&three=${three ? 1 : 0}&path=${encodeURIComponent(f.path)}`);
    setOpen((o) => ({ ...o, [f.path]: r.ok ? { patch: r.data.patch } : { error: r.data.error } }));
  };
  if (!res) return <div className="muted">Reading the diff…</div>;
  if (res.error) return <div className="outcome failed">{res.error}</div>;
  return (
    <div className="files-tab">
      <div className="muted small"><code>{res.command}</code> · {res.files.length} file{res.files.length === 1 ? '' : 's'} changed</div>
      {res.files.length === 0 && <div className="empty">No file differences.</div>}
      {res.files.map((f) => (
        <div key={f.path} className="fentry">
          <div className="fhead" onClick={() => toggle(f)}>
            <code className={`fs ${f.status === 'A' ? 'add' : f.status === 'D' ? 'del' : 'mod'}`}>{f.status}</code>
            <span className="fpath">{f.path}</span>
            <span className="fstat"><b className="pa">{f.added === null ? 'bin' : `+${f.added}`}</b> <b className="pd">{f.deleted === null ? '' : `−${f.deleted}`}</b></span>
          </div>
          {open[f.path]?.loading && <div className="muted small">Loading…</div>}
          {open[f.path]?.patch && <Patch patch={open[f.path].patch} />}
          {open[f.path]?.error && <div className="note warn">{open[f.path].error}</div>}
        </div>
      ))}
    </div>
  );
}

function RouteCard({ r, mode, a, b, big, setBig }) {
  return (
    <div className={`rcard ${pctTone(r.changedPct)}`}>
      <div className="rhead">
        <b>{r.name || r.path}</b> {r.name !== r.path && <code className="muted">{r.path}</code>}
        {r.error ? <span className="pct err">{r.error}</span> : <span className={`pct ${pctTone(r.changedPct)}`} title={`${r.pixelsChanged.toLocaleString()} pixels differ`}>{fmtPct(r.changedPct)}</span>}
        {r.sizeMismatch && <span className="muted small" title={`A is ${r.sizeA.join('×')}, B is ${r.sizeB.join('×')}. The shorter one is padded with white.`}>different page heights</span>}
      </div>
      {!r.error && (mode === 'side' ? (
        <div className="pair">
          <figure><figcaption>A · {a.label}</figcaption><img src={r.a} alt="" onClick={() => setBig(r.a)} /></figure>
          <figure><figcaption>B · {b.label}</figcaption><img src={r.b} alt="" onClick={() => setBig(r.b)} /></figure>
        </div>
      ) : (
        <figure className="ov"><figcaption>Overlay — pink/yellow marks what differs between A and B</figcaption><img src={r.diff} alt="" onClick={() => setBig(r.diff)} /></figure>
      ))}
    </div>
  );
}

export default function Compare({ data, points: basePoints, initial, onBack, onCapture }) {
  const [extra, setExtra] = useState([]);
  const points = useMemo(() => [...basePoints, ...extra], [basePoints, extra]);
  const [a, setA] = useState(initial?.a || null);
  const [b, setB] = useState(initial?.b || null);
  const [three, setThree] = useState(initial?.three ?? false);
  const [tab, setTab] = useState('screens');
  const [mode, setMode] = useState('side');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [big, setBig] = useState(null);
  const [branchKey, setBranchKey] = useState(initial?.rowKey || '');

  const run = useCallback(async () => {
    if (!a || !b) return;
    setLoading(true); setRes(null);
    const r = await api('/api/compare', { a: a.sha, b: b.sha });
    setLoading(false); setRes(r.ok ? r.data : { error: r.data.error });
  }, [a, b]);
  useEffect(() => { run(); }, [run, data.shots]);

  const rows = data.rows.filter((r) => r.local || r.remote);
  const row = data.rows.find((r) => r.key === branchKey);
  const mainPoint = basePoints.find((p) => p.isMain);
  const tip = (r, which) => basePoints.find((p) => p.rowKey === r.key && p.which === which);
  const preset = async (kind) => {
    if (!row) return;
    const loc = tip(row, 'local'); const rem = tip(row, 'remote'); const mine = loc || rem;
    if (kind === 'sync' && loc && rem) { setA(rem); setB(loc); setThree(false); }
    if ((kind === 'main-then' || kind === 'pr') && mine && mainPoint) {
      const base = kind === 'pr' ? (rem || mine) : mine;
      const r = await api(`/api/mergebase?a=${base.sha}&b=${mainPoint.sha}`);
      if (r.ok) { const p = { sha: r.data.sha, label: `main when it branched (${r.data.short})`, group: 'Other commits' }; setExtra((x) => [...x, p]); setA(p); setB(base); setThree(true); }
    }
    if (kind === 'main-now' && mine && mainPoint) { setA(mainPoint); setB(mine); setThree(false); }
  };

  const missing = res?.missing || [];
  const labelFor = (sha) => (points.find((p) => p.sha === sha) || {}).label || sha.slice(0, 7);
  const shown = (res?.routes || []).filter((r) => !onlyChanged || r.error || r.changedPct > 0.01);

  return (
    <div className="compare">
      <div className="chead"><button onClick={onBack}>← Back to the map</button><h2>Compare</h2></div>

      <div className="presets">
        <span className="muted">Quick compare for</span>
        <select value={branchKey} onChange={(e) => setBranchKey(e.target.value)}>
          <option value="">pick a branch…</option>
          {rows.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
        </select>
        <button disabled={!row || !tip(row, 'local') || !tip(row, 'remote')} onClick={() => preset('sync')} title="What’s different between your copy and GitHub’s copy of this branch.">My copy vs GitHub</button>
        <button disabled={!row} onClick={() => preset('main-then')} title="Only what this branch changed, compared with main at the moment it branched off (like a PR diff).">This branch vs main (what it changes)</button>
        <button disabled={!row} onClick={() => preset('main-now')} title="Compared with today’s main, including anything main has gained since.">vs latest main</button>
        <button disabled={!row?.pr} onClick={() => preset('pr')} title="The PR’s head compared with where it branched from its base.">PR vs base</button>
      </div>

      <div className="pickers">
        <PointSelect label="A (before)" value={a} points={points} onPick={setA} onCustom={(p) => { setExtra((x) => [...x, p]); setA(p); }} />
        <button className="swap" onClick={() => { setA(b); setB(a); }} title="Swap A and B">⇄</button>
        <PointSelect label="B (after)" value={b} points={points} onPick={setB} onCustom={(p) => { setExtra((x) => [...x, p]); setB(p); }} />
      </div>

      {a && b && (
        <>
          <div className="tabs">
            <button className={tab === 'screens' ? 'on' : ''} onClick={() => setTab('screens')}>Screens</button>
            <button className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>Files</button>
            <span className="grow-fill" />
            {tab === 'screens' && (
              <>
                <div className="seg">
                  <button className={mode === 'side' ? 'on' : ''} onClick={() => setMode('side')}>Side by side</button>
                  <button className={mode === 'overlay' ? 'on' : ''} onClick={() => setMode('overlay')}>Overlay</button>
                </div>
                <label className="check"><input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> Only changed screens</label>
              </>
            )}
            {tab === 'files' && <label className="check" title="Hide changes that came from main after B branched off (what a PR would show)."><input type="checkbox" checked={three} onChange={(e) => setThree(e.target.checked)} /> Only what B changed since the two diverged</label>}
          </div>

          {tab === 'files' && <FilesTab a={a} b={b} three={three} />}
          {tab === 'screens' && (
            <>
              {loading && <div className="muted">Comparing…</div>}
              {res?.error && <div className="outcome failed">{res.error}</div>}
              {missing.length > 0 && (
                <div className="outcome blocked">
                  No screenshots yet for {missing.map((s) => <b key={s}>{labelFor(s)} </b>)}.
                  <div><button className="act primary" onClick={() => onCapture(missing.map((s) => ({ sha: s, label: labelFor(s) })))}>Capture them…</button></div>
                </div>
              )}
              {res?.summary && (
                <div className="muted small">{res.summary.changed} of {res.summary.routes} screens changed{res.summary.errors ? ` · ${res.summary.errors} couldn’t be captured` : ''}. <button className="link" onClick={() => onCapture([a, b].map((p) => ({ sha: p.sha, label: p.label })), true)}>Re-capture</button></div>
              )}
              {shown.map((r) => <RouteCard key={r.slug} r={r} mode={mode} a={a} b={b} setBig={setBig} />)}
              {res?.routes && !shown.length && <div className="empty">No screens changed. 🎉</div>}
            </>
          )}
        </>
      )}
      {(!a || !b) && <div className="empty">Pick two points above, or choose a branch and a quick compare.</div>}
      {big && <div className="lightbox" onClick={() => setBig(null)}><img src={big} alt="" /></div>}
    </div>
  );
}
