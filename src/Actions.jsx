import React, { useCallback, useEffect, useRef, useState } from 'react';

export const INTENTS = [
  { id: 'share', label: 'Share my work', cmd: 'git push', hint: 'Push: uploads your commits to GitHub so others can see them.' },
  { id: 'pull', label: 'Get teammates’ changes', cmd: 'git pull --ff-only', hint: 'Pull (fast-forward only): brings in new GitHub commits without ever creating a merge.' },
  { id: 'catchup', label: 'Catch up with main', cmd: 'git rebase origin/main', hint: 'Rebase: replays your commits on top of the latest main, as if you had just branched.' },
  { id: 'pr', label: 'Open a PR', cmd: 'gh pr create', hint: 'Pull request: asks teammates to review your branch before it joins main.' },
];

export async function api(path, body) {
  let r;
  try { r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined); } catch { return { ok: false, status: 0, data: { error: 'Couldn’t reach Repo Map. Is it still running?' } }; }
  if (!(r.headers.get('content-type') || '').includes('json')) {
    // A stale server answers unknown /api paths with the app's HTML page.
    window.dispatchEvent(new Event('rm-stale'));
    return { ok: false, status: r.status, stale: true, data: { error: 'This Repo Map server is out of date and doesn’t know this request. Restart Repo Map.' } };
  }
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: j };
}

const FILE_TONE = { A: 'add', M: 'mod', D: 'del', R: 'mod', C: 'add' };

export function ActionBar({ row, current, onOpen, disabled }) {
  const primary = { 'local-ahead': 'share', 'no-upstream': 'share', 'remote-ahead': 'pull', diverged: 'catchup' }[row.state];
  const name = row.local?.name || row.remote?.name;
  const items = row.pr && !row.local && !row.remote ? [] : INTENTS;
  return (
    <div className="actionbar">
      {!row.local && row.remote && (
        <button className="act" title="Switch: creates a local copy of this GitHub branch and checks it out." onClick={() => onOpen({ intent: 'switch', branch: name })}>Start working on this branch<span className="cmd">git switch {name}</span></button>
      )}
      {row.local && !row.local.current && (
        <button className="act" title="Switch: makes this the branch you’re working on." onClick={() => onOpen({ intent: 'switch', branch: name })} disabled={disabled}>Switch to this branch<span className="cmd">git switch {name}</span></button>
      )}
      {row.local && items.map((it) => (
        <button key={it.id} className={`act ${primary === it.id ? 'primary' : ''}`} title={it.hint} disabled={disabled}
          onClick={() => onOpen({ intent: it.id, branch: name })}>
          {it.label}<span className="cmd">{it.cmd}</span>
        </button>
      ))}
      {!row.local && row.remote && !row.isDefault && (
        <button className="act" title={INTENTS[3].hint} disabled={disabled} onClick={() => onOpen({ intent: 'pr', branch: name })}>Open a PR<span className="cmd">gh pr create</span></button>
      )}
    </div>
  );
}

function CommitList({ g }) {
  return (
    <div className="dgroup">
      <div className={`dtitle ${g.tone}`}>{g.label} ({g.commits.length})</div>
      {g.commits.map((c) => <div key={c.short} className="dcommit"><code>{c.short}</code> {c.subject} <span className="muted">· {c.author}</span></div>)}
    </div>
  );
}

export function ActionModal({ req: initial, onClose, onDone }) {
  const [req, setReq] = useState(initial);
  const [pl, setPl] = useState(null);
  const [typed, setTyped] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const seq = useRef(0);

  useEffect(() => {
    const id = ++seq.current;
    const t = setTimeout(async () => {
      const r = await api('/api/plan', req);
      if (id === seq.current) { setPl(r.data); setErr(r.ok ? null : r.data.error); }
    }, 150);
    return () => clearTimeout(t);
  }, [req]);
  useEffect(() => { if (pl?.defaults?.title && req.intent === 'pr' && req.title === undefined) setReq((r) => ({ ...r, title: pl.defaults.title })); }, [pl, req.intent, req.title]);
  useEffect(() => { setTyped(''); }, [req.intent]);

  const set = (k, v) => setReq((r) => ({ ...r, [k]: v }));
  const canRun = pl && !pl.blocked && !pl.invalid && (!pl.confirmText || typed === pl.confirmText) && !running;

  const run = async () => {
    setRunning(true);
    const r = await api('/api/run', { params: req, token: pl.token });
    setRunning(false);
    setResult(r.ok ? r.data : { outcome: { kind: 'failed', message: r.data.error }, results: [] });
    onDone();
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="modal">
        <div className="mhead">
          <h2>{pl?.label || '…'}{req.branch && req.intent !== 'newBranch' ? <span className="muted"> · {req.branch}</span> : null}</h2>
          <button className="link" onClick={onClose} disabled={running}>✕</button>
        </div>

        {result ? (
          <>
            <div className={`outcome ${result.outcome.kind}`}>{result.outcome.message}</div>
            {result.results.map((s, i) => (
              <div key={i} className="step">
                <code className="cmdline">{s.ok ? '✓' : '✗'} {s.display}</code>
                {s.output && <pre>{s.output}</pre>}
              </div>
            ))}
            {result.outcome.kind === 'conflict' && <p className="muted">The banner at the top of the page has the conflicted files and your options.</p>}
            <div className="mfoot">
              {result.outcome.suggest && <button className="act primary" onClick={() => { setResult(null); setPl(null); setReq({ ...result.outcome.suggest }); }}>{result.outcome.suggest.label}</button>}
              <button onClick={onClose}>Close</button>
            </div>
          </>
        ) : (
          <>
            {req.intent === 'newBranch' && (
              <div className="form">
                <label>Name<input autoFocus value={req.name || ''} placeholder="e.g. pricing-page-v2" onChange={(e) => set('name', e.target.value)} /></label>
                <label>Start from
                  <select value={req.base || 'here'} onChange={(e) => set('base', e.target.value)}>
                    <option value="here">where I am now</option>
                    <option value="main">the latest main</option>
                  </select>
                </label>
              </div>
            )}
            {req.intent === 'pr' && !pl?.blocked && (
              <div className="form">
                <label>Title<input value={req.title ?? ''} onChange={(e) => set('title', e.target.value)} /></label>
                <label>Description<textarea rows={3} value={req.body || ''} placeholder="What changed and what should reviewers look at?" onChange={(e) => set('body', e.target.value)} /></label>
                <label className="check"><input type="checkbox" checked={!!req.draft} onChange={(e) => set('draft', e.target.checked)} /> Open as draft</label>
              </div>
            )}
            {req.intent === 'catchup' && pl && (
              <div className="form">
                <label>Catch up with
                  <select value={req.onto || pl.onto || 'main'} onChange={(e) => set('onto', e.target.value)}>
                    <option value="main">main</option>
                    <option value="upstream">teammates’ version of this branch on GitHub</option>
                  </select>
                </label>
              </div>
            )}

            {err && <div className="outcome failed">{err}</div>}
            {!pl && !err && <div className="muted">Checking…</div>}
            {pl?.blocked && (
              <div className="outcome blocked">
                {pl.blocked.reason}
                {pl.blocked.suggest && <div><button className="act primary" onClick={() => { setPl(null); setReq({ ...pl.blocked.suggest }); }}>{pl.blocked.suggest.label}</button></div>}
              </div>
            )}
            {pl && !pl.blocked && (
              <>
                <div className="dtitle">Commands that will run</div>
                <pre className="cmdblock">{pl.steps.map((s) => s.display).join('\n')}</pre>
                {pl.notes.map((n) => <div key={n} className={`note ${n.startsWith('⚠') ? 'warn' : ''}`}>{n}</div>)}
                {pl.groups.map((g) => <CommitList key={g.label} g={g} />)}
                {pl.files.length > 0 && (
                  <div className="dgroup">
                    <div className="dtitle">{pl.filesLabel} ({pl.files.length})</div>
                    <div className="files">{pl.files.map((f) => <div key={f.path}><code className={`fs ${FILE_TONE[f.status] || 'mod'}`}>{f.status}</code> {f.path}</div>)}</div>
                  </div>
                )}
                {pl.invalid && <div className="note warn">{pl.invalid}</div>}
                {pl.confirmText && <label className="form"><span>Type <b>{pl.confirmText}</b> to confirm</span><input value={typed} onChange={(e) => setTyped(e.target.value)} /></label>}
              </>
            )}
            <div className="mfoot">
              <button onClick={onClose}>Cancel</button>
              <button className="act primary" disabled={!canRun} onClick={run}>{running ? 'Running…' : 'Run these commands'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function ConflictBanner({ op, repoName, onDone }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [copied, setCopied] = useState(false);
  const prompt = `I'm in the middle of a git rebase on branch "${op.branch}" in ${repoName} and these files have conflicts: ${op.conflicts.join(', ') || '(none left)'}. Please look at the conflict markers, explain what each side changed, and help me resolve them.`;
  const go = useCallback(async (action) => {
    setBusy(true); setMsg(null);
    const r = await api('/api/rebase', { action });
    setBusy(false);
    setMsg(r.ok ? r.data.outcome.message : r.data.error);
    onDone();
  }, [onDone]);
  return (
    <div className="conflict">
      <div className="chead">⏸ Rebase paused on <b>{op.branch}</b> — {op.conflicts.length ? `${op.conflicts.length} file${op.conflicts.length > 1 ? 's' : ''} need your attention` : 'all conflicts resolved'}</div>
      {op.conflicts.length > 0 && <ul>{op.conflicts.map((f) => <li key={f}><code>{f}</code></li>)}</ul>}
      <p>Edit each file to keep the version you want, then stage it (<code>git add &lt;file&gt;</code>) and press continue. Or back out completely.</p>
      <p className="muted">Stuck? Ask Claude Code in your terminal — it can read the conflicts and help.{' '}
        <button className="link" onClick={() => { navigator.clipboard?.writeText(prompt); setCopied(true); }}>{copied ? 'Copied ✓' : 'Copy a ready-made prompt'}</button></p>
      <div className="mfoot left">
        <button className="act primary" disabled={busy} onClick={() => go('continue')} title="git rebase --continue — finishes this step and moves to the next commit.">I resolved it, continue<span className="cmd">git rebase --continue</span></button>
        <button className="act" disabled={busy} onClick={() => go('abort')} title="git rebase --abort — puts the branch back exactly as it was before the rebase.">Abort rebase<span className="cmd">git rebase --abort</span></button>
      </div>
      {msg && <div className="note warn">{msg}</div>}
    </div>
  );
}

export function HistoryPanel({ entries }) {
  const [open, setOpen] = useState(true);
  const [exp, setExp] = useState(null);
  return (
    <div className="history">
      <button className="link" onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} History of actions I ran ({entries.length})</button>
      {open && (entries.length === 0
        ? <div className="muted small">Nothing yet. Every command this app runs for you will be listed here.</div>
        : entries.map((e, i) => (
          <div key={e.t + i} className="hrow" onClick={() => setExp(exp === i ? null : i)}>
            <span className={e.ok ? 'ok' : 'bad'}>{e.ok ? '✓' : '✗'}</span>
            <span className="muted small">{new Date(e.t).toLocaleTimeString()}</span>
            <code>{e.cmd}</code>
            {exp === i && e.output && <pre>{e.output}</pre>}
          </div>
        )))}
    </div>
  );
}
