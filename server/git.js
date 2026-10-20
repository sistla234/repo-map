import simpleGit from 'simple-git';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
const SEP = '\x1f';

/** Run async fn over items with limited concurrency, keeping order. */
async function pmap(items, fn, limit = 8) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); }
  }));
  return res;
}

/** Collects the raw commands we run so the UI can show them. */
function makeRunner(repoPath) {
  const git = simpleGit(repoPath);
  const commands = [];
  const raw = async (...args) => {
    if (commands.length < 60) commands.push({ cmd: `git ${args.join(' ')}` });
    return git.raw(args);
  };
  return { git, raw, commands };
}

async function counts(raw, a, b) {
  // left = commits only in a (ahead), right = commits only in b (behind)
  try {
    const out = await raw('rev-list', '--left-right', '--count', `${a}...${b}`);
    const [ahead, behind] = out.trim().split(/\s+/).map(Number);
    return { ahead, behind };
  } catch {
    return null;
  }
}

export function classify(upstream, c) {
  if (!upstream || !c) return 'no-upstream';
  if (c.ahead && c.behind) return 'diverged';
  if (c.ahead) return 'local-ahead';
  if (c.behind) return 'remote-ahead';
  return 'in-sync';
}

async function ghJson(repoPath, commands, args) {
  commands.push({ cmd: `gh ${args.join(' ')}` });
  try {
    const { stdout } = await exec('gh', args, { cwd: repoPath, timeout: 30000 });
    return { data: JSON.parse(stdout) };
  } catch (e) {
    return { error: (e.stderr || e.message || 'gh failed').toString().trim().split('\n')[0] };
  }
}

export async function loadMap(repoPath, { fetch = true } = {}) {
  const { git, raw, commands } = makeRunner(repoPath);
  const warnings = [];

  const toplevel = (await raw('rev-parse', '--show-toplevel')).trim();
  const name = path.basename(toplevel);

  const remotes = (await raw('remote')).split('\n').filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0] || null;

  let fetched = false;
  if (fetch && remote) {
    try {
      commands.push({ cmd: `git fetch ${remote} --prune` });
      await git.fetch([remote, '--prune']);
      fetched = true;
    } catch (e) {
      warnings.push(`Couldn't fetch from ${remote}: ${e.message.split('\n')[0]}`);
    }
  } else if (!remote) {
    warnings.push('This repo has no remote, so there is nothing to compare against on GitHub.');
  }

  // Default branch
  let defaultBranch = null;
  if (remote) {
    try {
      const ref = (await raw('symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`)).trim();
      defaultBranch = ref.replace(`${remote}/`, '');
    } catch { /* fall through */ }
  }
  const verify = async (ref) => {
    try { await raw('rev-parse', '--verify', '--quiet', ref); return true; } catch { return false; }
  };
  if (!defaultBranch) {
    for (const c of ['main', 'master']) {
      if ((remote && (await verify(`refs/remotes/${remote}/${c}`))) || (await verify(`refs/heads/${c}`))) {
        defaultBranch = c; break;
      }
    }
  }
  const mainRef = defaultBranch
    ? (remote && (await verify(`refs/remotes/${remote}/${defaultBranch}`)) ? `${remote}/${defaultBranch}` : defaultBranch)
    : null;

  // Local branches
  const fmt = ['%(refname:short)', '%(objectname:short)', '%(upstream:short)', '%(upstream:track)',
    '%(committerdate:iso-strict)', '%(HEAD)', '%(authorname)', '%(objectname)', '%(subject)'].join(SEP);
  const localOut = await raw('for-each-ref', `--format=${fmt}`, 'refs/heads');
  const locals = await pmap(localOut.split('\n').filter(Boolean), async (line) => {
    const [bname, sha, upstream, track, date, head, author, full, subject] = line.split(SEP);
    const gone = track.includes('gone');
    const up = gone ? '' : upstream;
    const [vsUpstream, vsMain] = await Promise.all([
      up ? counts(raw, bname, up) : null,
      mainRef && bname !== defaultBranch ? counts(raw, bname, mainRef) : null,
    ]);
    return {
      name: bname, sha, full, upstream: up || null, upstreamGone: gone, date, author, subject,
      current: head === '*', vsUpstream, vsMain,
      state: classify(up, vsUpstream),
    };
  });

  // Remote branches
  const remotes_ = [];
  if (remote) {
    const rOut = await raw('for-each-ref', `--format=%(refname:short)${SEP}%(objectname:short)${SEP}%(committerdate:iso-strict)${SEP}%(authorname)${SEP}%(objectname)${SEP}%(subject)`, `refs/remotes/${remote}`);
    const lines = rOut.split('\n').filter(Boolean).filter((l) => { const f = l.split(SEP)[0]; return f !== remote && f !== `${remote}/HEAD`; });
    remotes_.push(...await pmap(lines, async (line) => {
      const [full, sha, date, author, fullSha, subject] = line.split(SEP);
      const bname = full.slice(remote.length + 1);
      const vsMain = mainRef && bname !== defaultBranch ? await counts(raw, full, mainRef) : null;
      return { name: bname, full, sha, fullSha, date, author, subject, vsMain };
    }));
  }

  // Working copy
  const st = await git.status();
  commands.push({ cmd: 'git status --porcelain=v1' });
  const workingCopy = {
    branch: st.current,
    detached: st.detached,
    changes: st.files.length,
    staged: st.staged.length,
    modified: st.modified.length + st.renamed.length + st.deleted.length,
    untracked: st.not_added.length,
    files: st.files.slice(0, 30).map((f) => ({ path: f.path, status: (f.index + f.working_dir).trim() || '?' })),
  };

  // PRs via gh
  let prs = [];
  let ghError = null;
  if (remote) {
    const r = await ghJson(repoPath, commands, ['pr', 'list', '--state', 'open', '--limit', '100', '--json',
      'number,title,headRefName,headRefOid,baseRefName,url,isCrossRepository,headRepositoryOwner,author,isDraft,updatedAt,reviewDecision']);
    if (r.error) ghError = r.error;
    else prs = r.data.map((p) => ({
      number: p.number, title: p.title, head: p.headRefName, headSha: p.headRefOid, base: p.baseRefName, url: p.url,
      fork: p.isCrossRepository, forkOwner: p.headRepositoryOwner?.login || null,
      author: p.author?.login || null, draft: p.isDraft, updatedAt: p.updatedAt, review: p.reviewDecision || null,
    }));
  }
  if (ghError) warnings.push(`GitHub PRs unavailable: ${ghError}`);

  // Build rows: one per logical branch, spanning the three lanes
  const rows = [];
  const claimedRemote = new Set();
  const byKey = new Map();
  for (const l of locals) {
    const row = { key: l.name, name: l.name, local: l, remote: null, pr: null };
    if (l.upstream && remote && l.upstream.startsWith(`${remote}/`)) {
      const rn = l.upstream.slice(remote.length + 1);
      const r = remotes_.find((x) => x.name === rn);
      if (r) { row.remote = r; claimedRemote.add(rn); }
    }
    rows.push(row); byKey.set(l.name, row);
  }
  for (const r of remotes_) {
    if (claimedRemote.has(r.name)) continue;
    const same = byKey.get(r.name);
    if (same && !same.remote) { same.remote = r; same.sameNameNoTracking = true; claimedRemote.add(r.name); continue; }
    const row = { key: `remote:${r.name}`, name: r.name, local: null, remote: r, pr: null };
    rows.push(row); byKey.set(row.key, row);
  }
  for (const p of prs) {
    if (!p.fork) {
      const row = rows.find((x) => x.local?.name === p.head || x.remote?.name === p.head);
      if (row) { row.pr = p; continue; }
    }
    rows.push({ key: `pr:${p.number}`, name: p.fork ? `${p.forkOwner}:${p.head}` : p.head, local: null, remote: null, pr: p });
  }
  for (const row of rows) {
    row.isDefault = row.name === defaultBranch;
    row.state = row.local ? row.local.state : row.remote ? 'remote-only' : 'pr-only';
  }

  // Commit graph: for each row, the commits that make up its track
  const mainFull = mainRef ? (remote && mainRef.startsWith(`${remote}/`) ? `refs/remotes/${mainRef}` : `refs/heads/${mainRef}`) : null;
  const sha = async (rev) => { try { return (await raw('rev-parse', rev)).trim(); } catch { return null; } };
  const mb = async (a, b) => { try { return (await raw('merge-base', a, b)).trim(); } catch { return null; } };
  const logList = async (range, n = 60, extra = []) => {
    try { return (await raw('log', '--format=%H', '-n', String(n), ...extra, range)).split('\n').filter(Boolean).reverse(); } catch { return []; }
  };
  const need = new Set();
  const mainExtra = new Set();
  await pmap(rows, async (row) => {
    const L = row.local ? `refs/heads/${row.local.name}` : null;
    const R = row.remote ? `refs/remotes/${row.remote.full}` : null;
    const refs = [L, R].filter(Boolean);
    if (!refs.length) return;
    const common = L && R ? await mb(L, R) : await sha(refs[0]);
    if (!common) return;
    let forkBase = null; let shared;
    if (row.isDefault) {
      shared = await logList(common, 30, ['--first-parent']);
    } else {
      forkBase = mainFull ? await mb(refs[0], mainFull) : null;
      shared = forkBase && forkBase !== common ? await logList(`${forkBase}..${common}`) : forkBase ? [] : await logList(common, 20);
      if (forkBase) mainExtra.add(forkBase);
    }
    const localOnly = L && R ? await logList(`${R}..${L}`) : [];
    const remoteOnly = L && R ? await logList(`${L}..${R}`) : [];
    const cap = (a) => (a.length > 10 ? a.slice(-10) : a);
    row.track = { forkBase, common, shared: row.isDefault ? shared : cap(shared), localOnly: cap(localOnly), remoteOnly: cap(remoteOnly), hiddenLocal: Math.max(0, localOnly.length - 10), hiddenRemote: Math.max(0, remoteOnly.length - 10) };
    shared = row.track.shared; localOnly.splice(0, localOnly.length, ...row.track.localOnly); remoteOnly.splice(0, remoteOnly.length, ...row.track.remoteOnly);
    [forkBase, common, ...shared, ...localOnly, ...remoteOnly].filter(Boolean).forEach((x) => need.add(x));
    });
  // Where would each open branch land? (clean / behind main / conflicts)
  await pmap(rows, async (row) => {
    if (row.isDefault || !row.track || !mainFull) return;
    const ref = row.local ? `refs/heads/${row.local.name}` : `refs/remotes/${row.remote.full}`;
    const vs = row.local ? row.local.vsMain : row.remote.vsMain;
    if (!vs) return;
    if (!vs.ahead) { row.mergeStatus = { kind: 'no-changes', ahead: 0, behind: vs.behind }; return; }
    let conflicts = null;
    try { await exec('git', ['merge-tree', '--write-tree', '--name-only', ref, mainFull], { cwd: repoPath }); } catch (e) {
      if (e.code === 1) {
        conflicts = (e.stdout || '').split('\n').slice(1).join('\n').split('\n\n')[0].split('\n').filter(Boolean);
      }
    }
    row.mergeStatus = { kind: conflicts ? 'conflict' : vs.behind ? 'behind' : 'clean', ahead: vs.ahead, behind: vs.behind, conflicts: conflicts || [] };
    });

  // Merged work: loops that leave main and come back (merge commits, plus squash/rebase merges known from GitHub PRs)
  let mergedPrs = [];
  if (remote && !ghError && mainFull) {
    const r = await ghJson(repoPath, commands, ['pr', 'list', '--state', 'merged', '--limit', '30', '--json', 'number,title,headRefName,mergeCommit,mergedAt,author,baseRefName,url']);
    if (r.data) mergedPrs = r.data.filter((p) => p.baseRefName === defaultBranch);
  }
  if (mainFull) {
    const bySha = new Map(mergedPrs.filter((p) => p.mergeCommit?.oid).map((p) => [p.mergeCommit.oid, p]));
    let trunk = [];
    try { trunk = (await raw('log', '--first-parent', `--format=%H${SEP}%P${SEP}%cI${SEP}%s`, '-n', '30', mainFull)).split('\n').filter(Boolean); } catch { /* ignore */ }
    for (const line of trunk) {
      const [m, ps, date, subject] = line.split(SEP);
      const parents = ps.split(' ').filter(Boolean);
      const pr = bySha.get(m);
      const parsed = subject.match(/^Merge pull request #(\d+) from [^/]+\/(.+)$/) || subject.match(/^Merge branch '(.+?)'/);
      if (parents.length < 2 && !pr) continue;
      let forkBase = parents[0]; let shared = []; let common = null; const squash = parents.length < 2;
      if (!squash) {
        common = parents[1];
        forkBase = await mb(parents[0], parents[1]);
        shared = forkBase && forkBase !== common ? await logList(`${forkBase}..${common}`, 30) : [];
      }
      if (!forkBase) continue;
      const hiddenShared = Math.max(0, shared.length - 6);
      if (hiddenShared) shared = shared.slice(-6);
      const number = pr?.number || (parsed && /^\d+$/.test(parsed[1]) ? Number(parsed[1]) : null);
      const bname = pr?.headRefName || (parsed ? (parsed[2] || parsed[1]) : 'merged branch');
      rows.push({
        key: `merged:${m}`, name: bname, local: null, remote: null, pr: null, state: 'merged',
        merged: { sha: m, number, title: pr?.title || subject, date: pr?.mergedAt || date, url: pr?.url || null, author: pr?.author?.login || null, squash },
        track: { forkBase, common, shared, localOnly: [], remoteOnly: [], mergeInto: m, hiddenShared },
      });
      [m, forkBase, common, ...shared].filter(Boolean).forEach((x) => need.add(x));
      mainExtra.add(forkBase); mainExtra.add(m);
    }
  }
  const mainRow = rows.find((r) => r.isDefault && r.track);
  if (mainRow) for (const f of mainExtra) if (!mainRow.track.shared.includes(f)) mainRow.track.shared.push(f);
  const commits = {};
  if (need.size) {
    const out = await raw('log', '--no-walk=unsorted', `--format=%H${SEP}%h${SEP}%P${SEP}%cI${SEP}%an${SEP}%s`, ...need);
    for (const line of out.split('\n').filter(Boolean)) {
      const [full, short, parents, date, author, subject] = line.split(SEP);
      commits[full] = { sha: full, short, parents: parents.split(' ').filter(Boolean), date, author, subject };
    }
  }

  return {
    repo: { name, path: toplevel, remote, defaultBranch, mainRef, mainFull, fetched },
    workingCopy, rows, commits, warnings, commands,
    generatedAt: new Date().toISOString(),
  };
}
