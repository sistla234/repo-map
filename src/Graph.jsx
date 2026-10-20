import React, { useEffect, useMemo, useRef } from 'react';

const COL = 38;       // px per commit step
const ROW = 72;       // px per branch row
const SUB = 22;       // offset of the GitHub-only sub-track when diverged
const PAD_X = 28;
const HEAD = 34;      // date axis height
const STATE_COLOR = {
  'in-sync': 'var(--sync)', 'local-ahead': 'var(--ahead)', 'remote-ahead': 'var(--behind)',
  'diverged': 'var(--diverged)', merged: 'var(--merged)', 'no-upstream': 'var(--none)', 'remote-only': 'var(--remote)', 'pr-only': 'var(--remote)',
};

/** Place every commit on a shared left→right axis: by date, but never left of a parent. */
function layoutX(commits) {
  const list = Object.values(commits).sort((a, b) => new Date(a.date) - new Date(b.date));
  const x = {};
  list.forEach((c, i) => { x[c.sha] = i; });
  for (let pass = 0; pass < 3; pass++) {
    for (const c of list) for (const p of c.parents) if (x[p] !== undefined && x[c.sha] <= x[p]) x[c.sha] = x[p] + 1;
  }
  // dense-rank so there are no big gaps
  const uniq = [...new Set(Object.values(x))].sort((a, b) => a - b);
  const rank = new Map(uniq.map((v, i) => [v, i]));
  Object.keys(x).forEach((k) => { x[k] = PAD_X + rank.get(x[k]) * COL; });
  return x;
}

const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const R = 10;
/** down from the fork commit, then right along the lane (like `git log --graph`) */
const railDown = (xf, yf, xt, yt) => (xt - xf > R + 2 ? `M${xf},${yf} L${xf},${yt - R} Q${xf},${yt} ${xf + R},${yt} L${xt},${yt}` : `M${xf},${yf} L${xf},${yt}`);
/** along the lane, then up into the merge commit */
const railUp = (xl, yl, xm, ym) => (xm - xl > R + 2 ? `M${xl},${yl} L${xm - R},${yl} Q${xm},${yl} ${xm},${yl - R} L${xm},${ym}` : `M${xl},${yl} L${xm},${ym}`);
const curve = (x1, y1, x2, y2) => { const m = Math.min(24, Math.abs(x2 - x1) / 2 + 8); return `M${x1},${y1} C${x1 + m},${y1} ${x2 - m},${y2} ${x2},${y2}`; };

/** Keep the axis tight: only commits that visible rows need, and only recent main history. */
function useView(rows, allCommits) {
  return useMemo(() => {
    const mainRow = rows.find((r) => r.isDefault && r.track);
    const need = new Set();
    rows.forEach((r) => { if (r !== mainRow && r.track) [r.track.forkBase, r.track.mergeInto].filter(Boolean).forEach((x) => need.add(x)); });
    let trimmedMain = mainRow;
    if (mainRow) {
      const byDate = [...mainRow.track.shared].filter((x) => allCommits[x]).sort((a, b) => new Date(allCommits[a].date) - new Date(allCommits[b].date));
      const keep = new Set([...byDate.slice(-14), ...need]);
      trimmedMain = { ...mainRow, track: { ...mainRow.track, shared: byDate.filter((x) => keep.has(x)) } };
    }
    const outRows = rows.map((r) => (r === mainRow ? trimmedMain : r));
    const used = new Set();
    outRows.forEach((r) => { const t = r.track; if (t) [t.forkBase, t.common, t.mergeInto, ...t.shared, ...t.localOnly, ...t.remoteOnly].filter(Boolean).forEach((x) => used.add(x)); });
    const commits = {};
    used.forEach((x) => { if (allCommits[x]) commits[x] = allCommits[x]; });
    return { rows: outRows, commits };
  }, [rows, allCommits]);
}

export default function Graph({ rows: inRows, commits: allCommits, workingCopy, shots = {}, selected, onSelect }) {
  const scroller = useRef(null);
  const { rows, commits } = useView(inRows, allCommits);
  const xs = useMemo(() => layoutX(commits), [commits]);
  const mainRow = rows.find((r) => r.isDefault && r.track);
  const width = Math.max(600, Math.max(0, ...Object.values(xs)) + 260);
  const height = HEAD + rows.length * ROW;

  useEffect(() => { const sc = scroller.current; if (sc) sc.scrollLeft = Math.max(0, sc.scrollWidth - sc.clientWidth - 120); }, [rows.length, width]);

  // Row order: main first, then the rest as given by parent (already sorted)
  const ordered = mainRow ? [mainRow, ...rows.filter((r) => r !== mainRow)] : rows;
  const mainY = HEAD + ROW / 2;
  const mainXs = mainRow ? [mainRow.track.common, ...mainRow.track.shared, ...mainRow.track.localOnly, ...mainRow.track.remoteOnly].filter((x) => xs[x] !== undefined).map((x) => xs[x]) : [];
  const ghostX = Math.max(0, ...mainXs) + COL * 1.4;
  const MERGE_COLOR = { clean: 'var(--sync)', behind: 'var(--ahead)', conflict: 'var(--diverged)' };

  // date ticks
  const ticks = [];
  let lastDay = '';
  Object.values(commits).sort((a, b) => xs[a.sha] - xs[b.sha]).forEach((c) => {
    const d = fmtDay(c.date);
    if (d !== lastDay) { ticks.push({ x: xs[c.sha], label: d }); lastDay = d; }
  });

  const dot = (c, y, color, extra = {}) => (
    <circle key={`${c.sha}-${y}`} cx={xs[c.sha]} cy={y} r={extra.r || 5} fill={extra.hollow ? 'var(--bg)' : color} stroke={color} strokeWidth={2}>
      <title>{`${c.short} · ${c.author}\n${c.subject}`}</title>
    </circle>
  );
  const line = (pts, color, dashed) => pts.length > 1 && (
    <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" strokeDasharray={dashed ? '2 6' : undefined} />
  );

  const renderMerged = (row, i) => {
    const t = row.track;
    const y = HEAD + i * ROW + ROW / 2;
    const f = commits[t.forkBase]; const m = commits[t.mergeInto];
    if (!f || !m) return null;
    const shared = t.shared.map((x) => commits[x]).filter(Boolean).sort((a, b) => xs[a.sha] - xs[b.sha]);
    const xf = xs[f.sha]; const xm = xs[m.sha];
    const col = 'var(--merged)';
    const pts = shared.length ? shared.map((c) => [xs[c.sha], y]) : [[(xf + xm) / 2, y]];
    const last = pts[pts.length - 1];
    const els = [
      <path key="out" d={railDown(xf, mainY, pts[0][0], y)} fill="none" stroke={col} strokeWidth={3} opacity={0.75} />,
      line(pts, col),
      <path key="in" d={railUp(last[0], y, xm, mainY)} fill="none" stroke={col} strokeWidth={3} opacity={0.75} />,
      <g key="mnode"><circle cx={xm} cy={mainY} r={8} fill="var(--bg)" stroke={col} strokeWidth={3} /><circle cx={xm} cy={mainY} r={3} fill={col} />
        <title>{`Merged${row.merged.number ? ` PR #${row.merged.number}` : ''}: ${row.merged.title}`}</title></g>,
    ];
    if (shared.length) shared.forEach((c) => els.push(dot(c, y, col)));
    else els.push(<g key="sq"><rect x={pts[0][0] - 16} y={y - 9} width={32} height={18} rx={9} fill={col} /><text x={pts[0][0]} y={y + 4} textAnchor="middle" className="sq-text">{row.merged.number ? `#${row.merged.number}` : 'PR'}</text><title>{`Squash/rebase merge — the original commits are folded into one commit on main\n${row.merged.title}`}</title></g>);
    els.push(<text key="lbl" x={last[0] + 14} y={y + 4} className="svg-note" fill={col}>{row.merged.title.length > 38 ? `${row.merged.title.slice(0, 38)}…` : row.merged.title}</text>);
    return <g key={row.key} className="grow" onClick={() => onSelect(row.key)} opacity={0.9}>{els}</g>;
  };

  const renderRow = (row, i) => {
    if (row.merged) return renderMerged(row, i);
    const t = row.track;
    if (!t) return null;
    const y = HEAD + i * ROW + ROW / 2;
    const color = STATE_COLOR[row.state];
    const isMain = row.isDefault;
    const lane = isMain ? mainY : y;
    const sel = selected === row.key;
    const sharedC = t.shared.map((s) => commits[s]).filter(Boolean).sort((a, b) => xs[a.sha] - xs[b.sha]);
    const localC = t.localOnly.map((s) => commits[s]).filter(Boolean);
    const remoteC = t.remoteOnly.map((s) => commits[s]).filter(Boolean);
    const common = commits[t.common];
    const split = localC.length && remoteC.length;
    const forkC = t.forkBase && commits[t.forkBase];
    const trunk = isMain ? sharedC : sharedC.filter((c) => c.sha !== t.forkBase);
    const base = common ? [common] : [];
    const lastShared = [...trunk].pop() || common;
    const laneColor = isMain ? 'var(--ink)' : 'var(--lane)';

    const els = [];
    // fork-out curve from main to the first commit on this lane
    if (!isMain && forkC) {
      const first = trunk[0] || common;
      if (first) els.push(<path key="fork" d={railDown(xs[forkC.sha], mainY, xs[first.sha], lane)} fill="none" stroke={laneColor} strokeWidth={3} opacity={sel ? 1 : 0.7} />);
    }
    if (isMain) els.push(<line key="now" x1={Math.max(...sharedC.map((c) => xs[c.sha]), 0)} x2={width - 24} y1={lane} y2={lane} stroke="var(--ink)" strokeWidth={3} strokeDasharray="2 6" opacity={0.45} />);
    // shared segment
    const sharedPts = [...(isMain ? sharedC : trunk)].map((c) => [xs[c.sha], lane]);
    if (!isMain && common && !trunk.find((c) => c.sha === common.sha) && common.sha !== t.forkBase) sharedPts.push([xs[common.sha], lane]);
    els.push(<g key="shared" opacity={sel ? 1 : 0.8}>{line(sharedPts, laneColor)}</g>);
    // local-only
    const anchor = lastShared || forkC;
    const lPts = [[xs[(anchor || common).sha], lane], ...localC.map((c) => [xs[c.sha], lane])];
    els.push(line(lPts, 'var(--ahead)'));
    // GitHub-only (own sub-track if diverged)
    const ry = split ? lane + SUB : lane;
    if (remoteC.length) {
      const a = [xs[(anchor || common).sha], lane];
      const r0 = [xs[remoteC[0].sha], ry];
      els.push(split ? <path key="rsplit" d={curve(a[0], a[1], r0[0], r0[1])} fill="none" stroke="var(--behind)" strokeWidth={3} /> : null);
      els.push(line(split ? remoteC.map((c) => [xs[c.sha], ry]) : [a, ...remoteC.map((c) => [xs[c.sha], ry])], 'var(--behind)'));
    }
    // dots
    const shown = isMain ? sharedC : trunk;
    shown.forEach((c) => els.push(dot(c, lane, isMain ? 'var(--ink)' : 'var(--lane)', { r: isMain ? 4 : 4.5 })));
    if (!isMain && common && !trunk.find((c) => c.sha === common.sha) && common.sha !== t.forkBase) els.push(dot(common, lane, 'var(--lane)'));
    localC.forEach((c) => els.push(dot(c, lane, 'var(--ahead)')));
    remoteC.forEach((c) => els.push(dot(c, ry, 'var(--behind)')));

    // tips
    const tipLocal = row.local ? (localC.at(-1) || common) : null;
    const tipRemote = row.remote ? (remoteC.at(-1) || common) : null;
    const tipX = Math.max(...[tipLocal, tipRemote, common].filter(Boolean).map((c) => xs[c.sha]));
    if (tipRemote) {
      const tyr = remoteC.length ? ry : lane;
      els.push(<g key="oring"><circle cx={xs[tipRemote.sha]} cy={tyr} r={9} fill="none" stroke="var(--behind)" strokeWidth={2} strokeDasharray="3 2" /><title>{`GitHub tip: ${row.remote.full}`}</title></g>);
    }
    if (tipLocal) {
      els.push(<g key="ltip"><circle cx={xs[tipLocal.sha]} cy={lane} r={8} fill={color} stroke="var(--bg)" strokeWidth={2} /><title>{`Local tip: ${row.name}`}</title></g>);
    }
    // screenshot thumbnail above the tip
    const shaT = (tipLocal || tipRemote)?.sha;
    const shot = shaT && shots[shaT];
    if (shot?.first) {
      const tx = xs[shaT];
      els.push(
        <g key="thumb"><rect x={tx - 25} y={lane - 36} width={50} height={29} rx={4} fill="var(--panel)" stroke={color} strokeWidth={1.5} />
          <image href={`/api/shot/${shaT}/${shot.first}.thumb.png`} x={tx - 23} y={lane - 34} width={46} height={25} preserveAspectRatio="xMidYMin slice" />
          <title>{`Screenshot of ${row.name} at ${(tipLocal || tipRemote).short}`}</title></g>,
      );
    }
    // where this branch would land on main
    const ms = row.mergeStatus;
    if (!isMain && ms && ms.kind !== 'no-changes' && mainRow) {
      const mc = MERGE_COLOR[ms.kind];
      els.push(<path key="proj" className="proj" d={railUp(tipX, lane, ghostX + ((i % 3) - 1) * 5, mainY)} fill="none" stroke={mc} strokeWidth={2.5} strokeDasharray="5 5" opacity={sel ? 1 : 0.28}><title>{`If merged into main: ${ms.kind === 'clean' ? 'merges cleanly' : ms.kind === 'behind' ? `main has ${ms.behind} newer commit(s); merges, but catch up first` : `conflicts in ${ms.conflicts.join(', ')}`}`}</title></path>);
    }
    // state flags
    let fx = tipX + 22;
    if (row.local?.current && workingCopy.changes) {
      els.push(
        <g key="wc"><line x1={tipX} y1={lane} x2={fx} y2={lane} stroke="var(--ahead)" strokeDasharray="3 4" strokeWidth={2} />
          <circle cx={fx} cy={lane} r={8} fill="var(--bg)" stroke="var(--ahead)" strokeWidth={2} strokeDasharray="3 3" />
          <text x={fx + 14} y={lane + 4} className="svg-note" fill="var(--ahead)">{workingCopy.changes} uncommitted</text>
          <title>Working copy — changes not yet committed</title></g>,
      );
      fx += 118;
    }
    if (row.pr) {
      const label = `#${row.pr.number}`;
      els.push(
        <a key="pr" href={row.pr.url} target="_blank" rel="noreferrer">
          <g transform={`translate(${fx},${lane - 11})`} className="pr-flag"><rect width={46} height={22} rx={11} /><text x={23} y={15} textAnchor="middle">{label}</text></g>
          <title>{row.pr.title}</title>
        </a>,
      );
    }
    if (!isMain && ms && ms.kind !== 'no-changes') {
      const txt = ms.kind === 'clean' ? 'ready to merge' : ms.kind === 'behind' ? `main moved on by ${ms.behind} — catch up first` : `conflicts in ${ms.conflicts.slice(0, 2).join(', ')}`;
      els.push(<text key="mtxt" x={fx + (row.pr ? 54 : 0)} y={lane + (row.state === 'no-upstream' ? 20 : 4)} className="svg-note" fill={MERGE_COLOR[ms.kind]}>→ {txt}</text>);
    }
    if (row.state === 'no-upstream' && !isMain) els.push(<text key="nu" x={tipX + 16} y={lane + 4} className="svg-note" fill="var(--none)">only on your machine</text>);
    return <g key={row.key} className="grow" onClick={() => onSelect(row.key)} style={{ '--lane': STATE_COLOR[row.state] === 'var(--remote)' ? 'var(--remote)' : 'var(--laneclr)' }}>{els}</g>;
  };

  return (
    <div className="graph">
      <div className="labels" style={{ paddingTop: HEAD }}>
        {ordered.map((row) => {
          const l = row.local;
          return (
            <div key={row.key} className={`label ${selected === row.key ? 'sel' : ''}`} style={{ height: ROW }} onClick={() => onSelect(row.key)}>
              <i style={{ background: STATE_COLOR[row.state] }} />
              <div>
                <div className="lname"><span className="ltext" title={row.name}>{row.name}</span>{l?.current && <span className="pill">here</span>}</div>
                <div className="lsub">
                  {row.local && row.remote && (l.vsUpstream?.ahead || l.vsUpstream?.behind)
                    ? <>{l.vsUpstream.ahead > 0 && <b className="up" title="Ahead: commits you have that GitHub doesn’t">{l.vsUpstream.ahead} not on GitHub yet (ahead {l.vsUpstream.ahead})</b>}{l.vsUpstream.ahead > 0 && l.vsUpstream.behind > 0 && ' · '}{l.vsUpstream.behind > 0 && <b className="down" title="Behind: commits GitHub has that you don’t">{l.vsUpstream.behind} to get (behind {l.vsUpstream.behind})</b>}</>
                    : row.merged ? `merged${row.merged.number ? ` #${row.merged.number}` : ''} · ${fmtDay(row.merged.date)}`
                    : row.state === 'in-sync' ? 'in sync with GitHub' : row.state === 'no-upstream' ? 'only on your machine' : row.state === 'remote-only' ? 'on GitHub, not checked out' : ''}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="scroll" ref={scroller}>
        <svg width={width} height={height} style={{ '--laneclr': 'var(--lane-base)' }}>
          {ticks.map((t) => (
            <g key={t.x}><line x1={t.x} x2={t.x} y1={HEAD - 6} y2={height} className="grid" /><text x={t.x + 4} y={16} className="svg-tick">{t.label}</text></g>
          ))}
          {ordered.map((row, i) => (selected === row.key ? <rect key={`sel-${row.key}`} x={0} y={HEAD + i * ROW} width={width} height={ROW} className="selrow" /> : null))}
          {ordered.map((row, i) => renderRow(row, i))}
          {mainRow && (
            <g><circle cx={ghostX} cy={mainY} r={9} fill="var(--bg)" stroke="var(--ink)" strokeWidth={2} strokeDasharray="3 3" /><text x={ghostX + 14} y={mainY + 4} className="svg-note" fill="var(--muted)">main · next merge</text>
              <title>Where branches land when they’re merged</title></g>
          )}
        </svg>
      </div>
    </div>
  );
}
