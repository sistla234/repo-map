import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Graph from './Graph.jsx';
import { ActionBar, ActionModal, ConflictBanner, HistoryPanel, api } from './Actions.jsx';
import { CaptureModal, JobsModal } from './Shots.jsx';
import Compare from './Compare.jsx';

const STATES = {
  'in-sync':      { label: 'In sync',               hint: 'Local and GitHub match.' },
  'local-ahead':  { label: 'Unpushed work',         hint: 'You have commits GitHub does not have yet.' },
  'remote-ahead': { label: 'Needs pull',            hint: 'GitHub has commits you do not have locally.' },
  'diverged':     { label: 'Diverged — rebase',     hint: 'Both sides have new commits. Needs a rebase.' },
  'no-upstream':  { label: 'Not on GitHub',         hint: 'No upstream set — this branch only exists on your machine.' },
  'remote-only':  { label: 'Not checked out',       hint: 'Exists on GitHub; you have no local copy.' },
  'merged':       { label: 'Merged into main',      hint: 'Finished: this work already landed on main.' },
  'pr-only':      { label: 'Fork PR',               hint: 'A PR from a fork — the branch lives in someone else’s repo.' },
};

const timeAgo = (iso) => {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso)) / 1000;
  for (const [n, u] of [[86400 * 30, 'mo'], [86400, 'd'], [3600, 'h'], [60, 'm']]) if (s >= n) return `${Math.floor(s / n)}${u} ago`;
  return 'just now';
};

const tipsOf = (row) => {
  const out = []; const seen = new Set();
  const add = (sha, label) => { if (sha && !seen.has(sha)) { seen.add(sha); out.push({ sha, label }); } };
  add(row.local?.full, row.local && row.remote ? `${row.name} (your copy)` : row.name);
  add(row.remote?.fullSha, row.local ? `${row.name} (GitHub)` : row.name);
  add(row.pr?.headSha, `PR #${row.pr?.number}`);
  return out;
};

function ShotStrip({ row, shots }) {
  const sha = row.local?.full || row.remote?.fullSha;
  const e = sha && shots[sha];
  if (!e) return <div className="muted small">No screenshots yet for this branch.</div>;
  return (
    <div className="strip">{e.routes.map((r) => r.ok
      ? <a key={r.slug} href={`/api/shot/${sha}/${r.slug}.png`} target="_blank" rel="noreferrer" title={`${r.name} · opens full size`}><img src={`/api/shot/${sha}/${r.slug}.thumb.png`} alt={r.name} /><span>{r.name}</span></a>
      : <div key={r.slug} className="shot-fail" title={r.error || 'Couldn’t capture this route'}>{r.name} ✗ <span>{(r.error || '').slice(0, 90)}</span></div>)}</div>
  );
}

function Detail({ row, data, onOpen, onCapture, onCompare }) {
  const c = data.commits;
  const t = row.track;
  const list = (ids, tone, title) => ids?.length > 0 && (
    <div className="dgroup">
      <div className={`dtitle ${tone}`}>{title} ({ids.length})</div>
      {[...ids].reverse().map((id) => c[id] && <div key={id} className="dcommit"><code>{c[id].short}</code> {c[id].subject} <span className="muted">· {c[id].author}</span></div>)}
    </div>
  );
  return (
    <div className="detail">
      <div className="dhead"><b>{row.name}</b> <span className="state-tag" style={{ color: `var(--c)` }}>{STATES[row.state].label}</span></div>
      <div className="muted">{STATES[row.state].hint}</div>
      {t && list(t.localOnly, 'ahead', 'Only on your machine — will go out on push')}
      {t && list(t.remoteOnly, 'behind', 'Only on GitHub — will come in on pull')}
      {row.merged && <div>Merged{row.merged.number ? <> as <a href={row.merged.url || '#'} target="_blank" rel="noreferrer">PR #{row.merged.number}</a></> : ''}: {row.merged.title}{row.merged.squash ? <span className="muted"> · squash/rebase merge (original commits folded into one)</span> : null}</div>}
      {row.mergeStatus && (
        <div className={`mstat ${row.mergeStatus.kind}`}>
          <b>Landing on {data.repo.mainRef}:</b>{' '}
          {row.mergeStatus.kind === 'no-changes' ? 'nothing new compared to main.'
            : row.mergeStatus.kind === 'clean' ? `would merge cleanly (${row.mergeStatus.ahead} commit${row.mergeStatus.ahead > 1 ? 's' : ''} to add).`
            : row.mergeStatus.kind === 'behind' ? `would merge, but main has moved on by ${row.mergeStatus.behind} commit${row.mergeStatus.behind > 1 ? 's' : ''} — catch up with main first.`
            : `would conflict in ${row.mergeStatus.conflicts.join(', ')} — catch up with main and resolve first.`}
        </div>
      )}
      {row.local?.vsMain && <div className="muted">vs {data.repo.mainRef}: <b>{row.local.vsMain.ahead}</b> ahead, <b>{row.local.vsMain.behind}</b> behind</div>}
      {!row.merged && (row.local || row.remote) && (
        <div className="dgroup">
          <div className="dtitle">Screens</div>
          <ShotStrip row={row} shots={data.shots} />
          <div className="actionbar">
            <button className="act" title="Renders this branch in a throwaway copy and photographs each page." onClick={() => onCapture(tipsOf(row))}>Capture screenshots<span className="cmd">git worktree add + playwright</span></button>
            <button className="act" title="Side-by-side screens and a file diff between any two points." onClick={() => onCompare(row.key)}>Compare…<span className="cmd">git diff</span></button>
          </div>
        </div>
      )}
      {!row.merged && <ActionBar row={row} disabled={!!data.operation} onOpen={onOpen} />}
      {row.pr && <div>PR <a href={row.pr.url} target="_blank" rel="noreferrer">#{row.pr.number} {row.pr.title}</a> <span className="muted">· {row.pr.author}{row.pr.draft ? ' · draft' : ''}</span></div>}
    </div>
  );
}

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('all');
  const [showCmds, setShowCmds] = useState(false);
  const [selected, setSelected] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [modal, setModal] = useState(null);
  const [capture, setCapture] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [staleFlag, setStaleFlag] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [bannerOff, setBannerOff] = useState(() => { try { return localStorage.getItem('rm-auto-banner') === '1'; } catch { return false; } });
  const [view, setView] = useState('map');
  const [cmpInit, setCmpInit] = useState(null);
  const [history, setHistory] = useState([]);
  const loadHistory = useCallback(async () => { const r = await api('/api/history'); if (r.ok) setHistory(r.data); }, []);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const load = useCallback(async (fetch = true) => {
    setLoading(true); setError(null);
    try {
      const r = await window.fetch(`/api/map?fetch=${fetch ? 1 : 0}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setData(j);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, []);
  useEffect(() => { load(true); }, [load]);
  const afterAction = useCallback(() => { load(true); loadHistory(); }, [load, loadHistory]);

  const { rows, hiddenCount } = useMemo(() => {
    if (!data) return { rows: [], hiddenCount: 0 };
    const rank = (r) => (r.local?.current ? 0 : r.isDefault ? 1 : r.merged ? 3 : 2);
    const t = (r) => new Date(r.merged?.date || r.local?.date || r.remote?.date || r.pr?.updatedAt || 0).getTime();
    const old = (r) => (Date.now() - new Date(r.local?.date || r.remote?.date || 0)) / 864e5 > 45;
    const bot = (r) => /^(dependabot|renovate)\//.test(r.name);
    const quiet = (r) => !r.merged && !r.isDefault && !r.local?.current && (bot(r) || (!r.pr && (r.state === 'remote-only' || old(r))));
    const merged = data.rows.filter((r) => r.merged).sort((x, y) => new Date(y.merged.date) - new Date(x.merged.date)).slice(0, 8).map((r) => r.key);
    const declutter = !showAll && (filter === 'all' || filter === 'attention');
    const hiddenCount = declutter ? data.rows.filter((r) => (r.merged ? !merged.includes(r.key) : quiet(r))).length : 0;
    const rows = [...data.rows]
      .filter((r) => !declutter || r.key === selected || (r.merged ? merged.includes(r.key) : !quiet(r)))
      .filter((r) => filter === 'all' || r.state === filter || (filter === 'attention' && ['local-ahead', 'remote-ahead', 'diverged'].includes(r.state)))
      .sort((a, b) => rank(a) - rank(b) || t(b) - t(a));
    return { rows, hiddenCount };
  }, [data, filter, showAll, selected]);

  useEffect(() => { if (data?.auto) setPaused(data.auto.paused); }, [data?.auto?.paused]); // eslint-disable-line
  const activeJobs = jobs.filter((j) => ['queued', 'running'].includes(j.state));
  const doneCount = jobs.filter((j) => j.state === 'done').length;
  const lastDone = useRef(0);
  useEffect(() => {
    if (!data?.shotsConfigured) return undefined;
    const tick = async () => { const r = await api('/api/shots/status'); if (r.ok) setJobs(r.data); };
    tick(); const t = setInterval(tick, 2500); return () => clearInterval(t);
  }, [data?.shotsConfigured]);
  useEffect(() => { if (doneCount > lastDone.current) { load(false); } lastDone.current = doneCount; }, [doneCount]); // eslint-disable-line
  const togglePause = async () => { const r = await api('/api/shots/auto', { paused: !paused }); if (r.ok) { setPaused(r.data.paused); const s = await api('/api/shots/status'); if (s.ok) setJobs(s.data); } };

  useEffect(() => { const f = () => setStaleFlag(true); window.addEventListener('rm-stale', f); return () => window.removeEventListener('rm-stale', f); }, []);
  const uiBuilt = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 0; // eslint-disable-line no-undef
  const stale = staleFlag || data?.app?.stale || (data?.app && uiBuilt > data.app.startedAt + 1000);
  const restart = async () => {
    setRestarting(true);
    const before = data?.app?.startedAt;
    const r = await api('/api/restart', {});
    if (!r.ok) { setRestarting(false); return; }
    for (let i = 0; i < 40; i++) {
      await new Promise((res) => setTimeout(res, 700));
      try { const p = await (await fetch('/api/ping')).json(); if (p.startedAt && p.startedAt !== before) { window.location.reload(); return; } } catch { /* still restarting */ }
    }
    setRestarting(false);
  };

  const points = useMemo(() => {
    if (!data) return [];
    const ps = [];
    const def = data.rows.find((r) => r.isDefault);
    const mainSha = def?.remote?.fullSha || def?.local?.full;
    if (def?.remote?.fullSha) ps.push({ sha: def.remote.fullSha, label: `${data.repo.mainRef} (GitHub)`, group: 'main', rowKey: def.key, which: 'remote', isMain: true });
    if (def?.local?.full && def.local.full !== def.remote?.fullSha) ps.push({ sha: def.local.full, label: `${def.name} (your copy)`, group: 'main', rowKey: def.key, which: 'local', isMain: !def.remote });
    for (const r of data.rows) {
      if (r.merged || r.isDefault) continue;
      if (r.local?.full) ps.push({ sha: r.local.full, label: `${r.name} (your copy)`, group: 'Your branches', rowKey: r.key, which: 'local' });
      if (r.remote?.fullSha) ps.push({ sha: r.remote.fullSha, label: `${r.name} (GitHub)`, group: 'On GitHub', rowKey: r.key, which: 'remote' });
    }
    for (const r of data.rows) if (r.pr?.headSha && !r.pr.fork && !ps.some((p) => p.sha === r.pr.headSha && p.group === 'Open PRs')) ps.push({ sha: r.pr.headSha, label: `PR #${r.pr.number} ${r.pr.title.slice(0, 30)}`, group: 'Open PRs', rowKey: r.key, which: 'pr' });
    if (mainSha && !ps.length) ps.push({ sha: mainSha, label: 'main', group: 'main', isMain: true });
    return ps;
  }, [data]);

  const tally = useMemo(() => {
    const c = {};
    (data?.rows || []).forEach((r) => { c[r.state] = (c[r.state] || 0) + 1; });
    return c;
  }, [data]);

  return (
    <div className="app">
      <header>
        <div>
          <h1>Repo Map</h1>
          {data && <div className="muted">{data.repo.name} · <code>{data.repo.path}</code></div>}
        </div>
        <div className="actions">
          {data && <span className="muted small">{data.repo.fetched ? 'Fetched' : 'Not fetched'} {timeAgo(data.generatedAt)}</span>}
          {data?.shotsConfigured && (
            <span className={`autochip ${activeJobs.length ? 'busy' : ''}`}>
              <button className="link" onClick={() => setJobsOpen(true)} title="See what the screenshot capture is doing">
                {activeJobs.length ? `📷 Capturing ${activeJobs.length} more… ${activeJobs.find((j) => j.state === 'running')?.label || ''}` : paused ? '📷 Auto-capture paused' : data.auto?.enabled ? '📷 Auto-capture on' : '📷 Auto-capture off'}
              </button>
              {data.auto?.enabled && <button className="link" onClick={togglePause} title={paused ? 'Resume capturing automatically' : 'Pause automatic capture'}>{paused ? '▶' : '⏸'}</button>}
            </span>
          )}
          {data && <button onClick={() => { setCmpInit(null); setView('compare'); }} title="Side-by-side screens and file diffs between any two points">Compare</button>}
          {data && <button onClick={() => setCapture({ items: rows.filter((r) => !r.merged && (r.local || r.remote)).flatMap((r) => tipsOf(r).slice(0, 1)) })} title="Photograph every branch shown on the map">Capture screenshots</button>}
          {data && <button onClick={() => setModal({ intent: 'newBranch', branch: data.workingCopy.branch })} disabled={!!data.operation} title="Branch: a separate line of work, so you can try ideas without touching main.">＋ Start a new exploration</button>}
          <button onClick={() => load(true)} disabled={loading}>{loading ? 'Refreshing…' : '↻ Refresh'}</button>
        </div>
      </header>

      {stale && (
        <div className="banner stale"><span><b>Repo Map needs a restart.</b> {data?.app?.staleReason || 'This server is older than the interface you’re looking at, so some features will misbehave.'}</span>
          <span><button className="act primary" disabled={restarting} onClick={restart}>{restarting ? 'Restarting…' : 'Restart Repo Map'}</button></span>
          {staleFlag && !restarting && <div className="muted small">If the button doesn’t work, stop it in the terminal (or run <code>pkill -f repo-map/bin/repo-map.js</code>) and start it again.</div>}
        </div>
      )}
      {error && <div className="banner error">{error}</div>}
      {data && !data.shotsConfigured && !bannerOff && data.rows.some((r) => r.local || r.remote) && (
        <div className="banner setup">See your branches as screens. Set up once, then Repo Map photographs your current branch, main and open PRs automatically.
          <span><button className="act primary" onClick={() => setCapture({ items: [] })}>Set up screenshots</button> <button onClick={() => { setBannerOff(true); try { localStorage.setItem('rm-auto-banner', '1'); } catch { /* ignore */ } }}>Not now</button></span>
        </div>
      )}
      {data?.operation && <ConflictBanner op={data.operation} repoName={data.repo.name} onDone={afterAction} />}
      {data?.warnings.map((w) => <div key={w} className="banner">{w}</div>)}

      {data && view === 'compare' && <Compare data={data} points={points} initial={cmpInit} onBack={() => setView('map')} onCapture={(items, force) => setCapture({ items, force })} />}
      {data && view === 'map' && (
        <>
          <div className="legend">
            <label className="chip" title="Dependabot/Renovate branches and GitHub branches nobody has checked out are hidden by default"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show everything{!showAll && hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ''}</label>
            <button className={`chip ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>All {data.rows.length}</button>
            <button className={`chip ${filter === 'attention' ? 'on' : ''}`} onClick={() => setFilter('attention')}>Needs attention</button>
            {Object.entries(STATES).filter(([k]) => tally[k]).map(([k, v]) => (
              <button key={k} className={`chip s-${k} ${filter === k ? 'on' : ''}`} onClick={() => setFilter(filter === k ? 'all' : k)} title={v.hint}>
                <i /> {v.label} {tally[k]}
              </button>
            ))}
          </div>

          <Graph rows={rows} commits={data.commits} workingCopy={data.workingCopy} shots={data.shots} selected={selected} onSelect={(k) => setSelected(selected === k ? null : k)} />
          {data.rows.find((r) => r.key === selected) && (
            <div className={`s-${data.rows.find((r) => r.key === selected).state}`}>
              <Detail row={data.rows.find((r) => r.key === selected)} data={data} onOpen={setModal} onCapture={(items, force) => setCapture({ items, force })} onCompare={(rowKey) => { setCmpInit({ rowKey }); setView('compare'); }} />
            </div>
          )}
          {data.rows.some((r) => !r.track && r.pr) && (
            <div className="forkprs"><div className="lane-head">PRs from forks (branch lives in someone else’s repo)</div>
              {data.rows.filter((r) => !r.track && r.pr).map((r) => <a key={r.key} href={r.pr.url} target="_blank" rel="noreferrer"><b>#{r.pr.number}</b> {r.pr.title} <span className="muted">· {r.name} → {r.pr.base}</span></a>)}
            </div>
          )}

          <HistoryPanel entries={history} />
          <div className="cmds">
            <button className="link" onClick={() => setShowCmds(!showCmds)}>{showCmds ? '▾' : '▸'} Read-only commands behind this view ({data.commands.length})</button>
            {showCmds && <pre>{data.commands.map((c) => c.cmd).join('\n')}</pre>}
          </div>
        </>
      )}
      {jobsOpen && <JobsModal paused={paused} onTogglePause={togglePause} onClose={() => setJobsOpen(false)} />}
      {capture && <CaptureModal key={capture.items.map((i) => i.sha).join() || 'setup'} items={capture.items} initialForce={!!capture.force} onClose={() => setCapture(null)} onDone={() => load(false)} />}
      {modal && <ActionModal key={JSON.stringify(modal.intent) + modal.branch} req={modal} onClose={() => setModal(null)} onDone={afterAction} />}
      {data?.app && <footer className="foot">Repo Map v{data.app.version} · interface built {uiBuilt ? new Date(uiBuilt).toLocaleString() : '?'} · server started {new Date(data.app.startedAt).toLocaleString()}</footer>}
      {!data && !error && <div className="muted">Fetching from GitHub…</div>}
    </div>
  );
}
