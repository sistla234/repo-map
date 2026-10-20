import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const execp = promisify(execFile);
const SEP = '\x1f';

export const INTENTS = {
  share: 'Share my work',
  pull: 'Get teammates’ changes',
  catchup: 'Catch up with main',
  newBranch: 'Start a new exploration',
  pr: 'Open a PR',
  switch: 'Switch to this branch',
};

async function sh(bin, args, cwd) {
  try {
    const { stdout, stderr } = await execp(bin, args, {
      cwd, maxBuffer: 10 * 1024 * 1024, timeout: 120000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout || '', stderr: e.stderr || e.message };
  }
}
const git = (cwd, ...a) => sh('git', a, cwd);
const out = async (cwd, ...a) => { const r = await git(cwd, ...a); return r.code === 0 ? r.stdout.trim() : null; };
const q = (a) => (/^[\w@%+=:,./~^-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
const step = (bin, args) => ({ bin, args, display: [bin, ...args.map(q)].join(' ') });

async function basics(cwd) {
  const remotes = (await out(cwd, 'remote') || '').split('\n').filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0] || null;
  const has = async (ref) => (await git(cwd, 'rev-parse', '--verify', '--quiet', ref)).code === 0;
  let def = null;
  if (remote) { const r = await out(cwd, 'symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`); if (r) def = r.slice(remote.length + 1); }
  if (!def) for (const c of ['main', 'master']) if ((remote && await has(`refs/remotes/${remote}/${c}`)) || await has(`refs/heads/${c}`)) { def = c; break; }
  const mainRef = def ? (remote && await has(`refs/remotes/${remote}/${def}`) ? `${remote}/${def}` : def) : null;
  return { remote, def, mainRef, has };
}

async function commitsIn(cwd, ...range) {
  const o = await out(cwd, 'log', `--format=%h${SEP}%s${SEP}%an${SEP}%cI`, '-n', '50', ...range);
  return (o || '').split('\n').filter(Boolean).map((l) => { const [short, subject, author, date] = l.split(SEP); return { short, subject, author, date }; });
}
async function filesIn(cwd, spec) {
  const o = await out(cwd, 'diff', '--name-status', spec);
  return (o || '').split('\n').filter(Boolean).slice(0, 100).map((l) => { const [status, ...p] = l.split('\t'); return { status: status[0], path: p.join(' → ') }; });
}
async function counts(cwd, a, b) {
  const o = await out(cwd, 'rev-list', '--left-right', '--count', `${a}...${b}`);
  if (!o) return null;
  const [ahead, behind] = o.split(/\s+/).map(Number);
  return { ahead, behind };
}

export async function operationState(cwd) {
  for (const n of ['rebase-merge', 'rebase-apply']) {
    const p = await out(cwd, 'rev-parse', '--git-path', n);
    if (p && fs.existsSync(path.resolve(cwd, p))) {
      let branch = null;
      try { branch = fs.readFileSync(path.resolve(cwd, p, 'head-name'), 'utf8').trim().replace('refs/heads/', ''); } catch { /* ignore */ }
      const conflicts = (await out(cwd, 'diff', '--name-only', '--diff-filter=U') || '').split('\n').filter(Boolean);
      return { type: 'rebase', branch, conflicts };
    }
  }
  return null;
}

const blocked = (reason, suggest) => ({ blocked: { reason, suggest: suggest || null }, steps: [], groups: [], files: [], notes: [] });

async function buildPlan(cwd, p) {
  const bs = await basics(cwd);
  const b = p.branch;
  const label = INTENTS[p.intent];
  if (!label) return blocked('Unknown action.');
  if (await operationState(cwd)) return blocked('A rebase is paused. Finish or abort it first (see the banner at the top).');
  if (!bs.remote && !['newBranch', 'switch'].includes(p.intent)) return blocked('This repo has no remote, so there is nothing to sync with.');

  const current = await out(cwd, 'branch', '--show-current');
  const dirty = ((await out(cwd, 'status', '--porcelain', '--untracked-files=no')) || '').split('\n').filter(Boolean).length;
  const local = b ? await bs.has(`refs/heads/${b}`) : false;
  let up = local ? await out(cwd, 'rev-parse', '--abbrev-ref', `${b}@{upstream}`) : null;
  const remoteRef = up || (b && bs.remote && await bs.has(`refs/remotes/${bs.remote}/${b}`) ? `${bs.remote}/${b}` : null);
  const c = up ? await counts(cwd, b, up) : null;
  const stashNote = dirty ? `Your ${dirty} uncommitted change${dirty > 1 ? 's' : ''} will be set aside (auto-stash) and put back afterwards.` : null;
  const mkSwitch = (why) => blocked(why, local || remoteRef ? { intent: 'switch', branch: b, label: 'Switch to this branch' } : null);

  if (p.intent === 'switch') {
    if (!local && !remoteRef) return blocked('That branch doesn’t exist.');
    if (b === current) return blocked('You’re already on this branch.');
    return { steps: [step('git', ['switch', b])], groups: [], files: [], notes: dirty ? [`Your ${dirty} uncommitted change${dirty > 1 ? 's' : ''} come along. If they conflict with the other branch, git will refuse and nothing changes.`] : [], head: b };
  }

  if (p.intent === 'share') {
    if (!local) return blocked('There’s no local copy of this branch to share.');
    if (!up) {
      const commits = b === bs.def ? await commitsIn(cwd, b, '--not', `--remotes=${bs.remote}`) : await commitsIn(cwd, `${bs.mainRef}..${b}`);
      return {
        steps: [step('git', ['push', '--set-upstream', bs.remote, b])],
        groups: [{ label: `Commits that will appear on GitHub as ${bs.remote}/${b}`, tone: 'ahead', commits }],
        files: b === bs.def ? [] : await filesIn(cwd, `${bs.mainRef}...${b}`), filesLabel: `Files changed vs ${bs.mainRef}`,
        notes: ['This creates the branch on GitHub and links your local branch to it (set upstream).'],
      };
    }
    if (c.behind && c.ahead) return blocked(`GitHub has ${c.behind} commit${c.behind > 1 ? 's' : ''} you don’t have, so a push would be rejected. This app never force-pushes.`, { intent: 'catchup', branch: b, onto: 'upstream', label: 'Catch up with teammates’ version (rebase)' });
    if (c.behind) return blocked('GitHub is ahead of you — you have nothing new to share.', { intent: 'pull', branch: b, label: 'Get teammates’ changes' });
    if (!c.ahead) return blocked('Nothing to share — GitHub already has everything on this branch.');
    const upBranch = up.slice(bs.remote.length + 1);
    return {
      steps: [step('git', ['push', bs.remote, upBranch === b ? b : `${b}:${upBranch}`])],
      groups: [{ label: 'Commits going out to GitHub', tone: 'ahead', commits: await commitsIn(cwd, `${up}..${b}`) }],
      files: await filesIn(cwd, `${up}...${b}`), filesLabel: 'Files affected',
      notes: [],
    };
  }

  if (p.intent === 'pull') {
    if (!local) return blocked('There’s no local copy of this branch.', remoteRef ? { intent: 'switch', branch: b, label: 'Switch to this branch' } : null);
    if (current !== b) return mkSwitch('You’re on a different branch. Switch to this one first.');
    if (!up) return blocked('This branch isn’t on GitHub yet, so there’s nothing to pull.', { intent: 'share', branch: b, label: 'Share my work' });
    if (c.ahead && c.behind) return blocked('Both you and GitHub have new commits, so a plain pull can’t fast-forward. A rebase puts your commits on top of theirs.', { intent: 'catchup', branch: b, onto: 'upstream', label: 'Catch up with teammates’ version (rebase)' });
    if (!c.behind) return blocked('Already up to date.');
    return {
      steps: [step('git', ['pull', '--ff-only', ...(dirty ? ['--autostash'] : [])])],
      groups: [{ label: 'Commits coming in from GitHub', tone: 'behind', commits: await commitsIn(cwd, `${b}..${up}`) }],
      files: await filesIn(cwd, `${b}...${up}`), filesLabel: 'Files affected',
      notes: [stashNote, '“--ff-only” means git only moves forward — it will never create a merge commit or rewrite anything.'].filter(Boolean),
    };
  }

  if (p.intent === 'catchup') {
    if (!local) return blocked('There’s no local copy of this branch.', remoteRef ? { intent: 'switch', branch: b, label: 'Switch to this branch' } : null);
    const onto = p.onto || (c?.ahead && c?.behind ? 'upstream' : 'main');
    const target = onto === 'upstream' ? up : bs.mainRef;
    if (!target) return blocked(onto === 'upstream' ? 'This branch has no GitHub counterpart to catch up with.' : 'Couldn’t find a main branch.');
    if (onto === 'main' && b === bs.def) return blocked('This is main itself — nothing to catch up with.');
    if (current !== b) return mkSwitch('You’re on a different branch. Switch to this one first.');
    const incoming = await commitsIn(cwd, `${b}..${target}`);
    if (!incoming.length) return blocked(`Already up to date with ${target}.`);
    const replay = await commitsIn(cwd, `${target}..${b}`);
    const notes = [stashNote, `A rebase replays your commits on top of ${target}, as if you had started from there.`].filter(Boolean);
    let confirmText = null;
    if (up && target !== up) {
      const mbU = await out(cwd, 'merge-base', b, up);
      const pushed = mbU ? Number(await out(cwd, 'rev-list', '--count', `${target}..${mbU}`)) : 0;
      if (pushed > 0) {
        confirmText = 'rebase';
        notes.push(`⚠ ${pushed} of your commit${pushed > 1 ? 's are' : ' is'} already on GitHub. Rebasing rewrites them, so GitHub will refuse your next push — and this app never force-pushes. Only continue if you know why.`);
      }
    }
    const mt = await git(cwd, 'merge-tree', '--write-tree', '--name-only', b, target);
    if (mt.code === 1) {
      const files = mt.stdout.split('\n').slice(1).join('\n').split('\n\n')[0].split('\n').filter(Boolean);
      notes.push(`Heads up: likely conflicts in ${files.join(', ') || 'some files'}. The rebase will pause and let you resolve them.`);
    }
    const base = await out(cwd, 'merge-base', b, target);
    return {
      steps: [step('git', ['fetch', bs.remote]), step('git', ['rebase', ...(dirty ? ['--autostash'] : []), target])],
      groups: [
        { label: `New on ${target} (coming in under your work)`, tone: 'behind', commits: incoming },
        { label: 'Your commits (will be replayed on top)', tone: 'ahead', commits: replay },
      ],
      files: base ? await filesIn(cwd, `${base}...${target}`) : [], filesLabel: `Files changed on ${target} since you branched`,
      notes, confirmText, onto,
    };
  }

  if (p.intent === 'newBranch') {
    const name = (p.name || '').trim();
    const fromMain = p.base === 'main' && bs.mainRef;
    const startRef = fromMain ? bs.mainRef : 'HEAD';
    const start = (await commitsIn(cwd, '-1', startRef))[0];
    const res = {
      steps: [step('git', ['switch', '-c', name || '<name>', ...(fromMain ? ['--no-track', bs.mainRef] : [])])],
      groups: start ? [{ label: `New branch starts at ${fromMain ? bs.mainRef : 'where you are now'}`, tone: 'neutral', commits: [start] }] : [],
      files: [], notes: [],
    };
    if (dirty) res.notes.push(`Your ${dirty} uncommitted change${dirty > 1 ? 's' : ''} will come with you to the new branch.`);
    if (!name) res.invalid = 'Give the exploration a name.';
    else if ((await git(cwd, 'check-ref-format', '--branch', name)).code !== 0) res.invalid = 'That isn’t a valid branch name (no spaces or ~ ^ : ? * [ \\).';
    else if (await bs.has(`refs/heads/${name}`)) res.invalid = 'You already have a branch with that name.';
    return res;
  }

  if (p.intent === 'pr') {
    if (!b || b === bs.def) return blocked('Pick a branch other than main to open a PR from.');
    if (!local && !remoteRef) return blocked('That branch doesn’t exist.');
    if (!remoteRef || (local && !up)) return blocked('This branch isn’t on GitHub yet. Share it first, then open a PR.', { intent: 'share', branch: b, label: 'Share my work' });
    if (c && c.ahead) return blocked(`You have ${c.ahead} commit${c.ahead > 1 ? 's' : ''} not on GitHub yet. A PR only includes what’s on GitHub — share first.`, { intent: 'share', branch: b, label: 'Share my work' });
    const base = p.base && p.base !== 'main' ? p.base : bs.def;
    const baseRef = bs.remote && (await bs.has(`refs/remotes/${bs.remote}/${base}`)) ? `${bs.remote}/${base}` : base;
    const exist = await sh('gh', ['pr', 'list', '--head', b, '--state', 'open', '--json', 'number,url'], cwd);
    if (exist.code === 0) { try { const l = JSON.parse(exist.stdout); if (l.length) return blocked(`PR #${l[0].number} is already open for this branch.`); } catch { /* ignore */ } }
    const commits = await commitsIn(cwd, `${baseRef}..${remoteRef}`);
    const defTitle = commits.length === 1 ? commits[0].subject : b.replace(/[-_/]+/g, ' ').replace(/^./, (m) => m.toUpperCase());
    const title = (p.title ?? '').trim() || defTitle;
    const res = {
      steps: [step('gh', ['pr', 'create', '--head', b, '--base', base, '--title', title, '--body', p.body || '', ...(p.draft ? ['--draft'] : [])])],
      groups: [{ label: `Commits in this PR (${remoteRef} vs ${baseRef})`, tone: 'ahead', commits }],
      files: await filesIn(cwd, `${baseRef}...${remoteRef}`), filesLabel: 'Files in this PR',
      notes: [], defaults: { title: defTitle, base: bs.def },
    };
    if (!commits.length) res.invalid = `There are no differences between ${b} and ${base}.`;
    return res;
  }
  return blocked('Unknown action.');
}

export async function plan(cwd, p) {
  const r = await buildPlan(cwd, p);
  const head = (await out(cwd, 'rev-parse', 'HEAD')) || '';
  const tips = (await out(cwd, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes')) || '';
  const token = crypto.createHash('sha1').update(JSON.stringify([r.steps?.map((s) => s.display), head, tips])).digest('hex').slice(0, 16);
  return { intent: p.intent, label: INTENTS[p.intent], branch: p.branch, ...r, steps: (r.steps || []).map((s) => ({ display: s.display })), _exec: r.steps, token };
}

// ---- history -------------------------------------------------------------
async function historyFile(cwd) {
  const top = (await out(cwd, 'rev-parse', '--show-toplevel')) || cwd;
  const dir = path.join(os.homedir(), '.repo-map', 'history');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${path.basename(top)}-${crypto.createHash('sha1').update(top).digest('hex').slice(0, 6)}.jsonl`);
}
export async function record(cwd, entry) {
  fs.appendFileSync(await historyFile(cwd), JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
}
export async function getHistory(cwd, n = 200) {
  const f = await historyFile(cwd);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-n).map((l) => JSON.parse(l)).reverse();
}

async function exec1(cwd, s, meta) {
  const r = await sh(s.bin, s.args, cwd);
  const output = `${r.stdout}${r.stderr}`.trim().slice(0, 4000);
  await record(cwd, { ...meta, cmd: s.display, ok: r.code === 0, output });
  return { display: s.display, ok: r.code === 0, output };
}

async function classify(cwd, p, results) {
  const last = results[results.length - 1];
  if (last.ok) return { kind: 'ok', message: 'Done.' };
  const text = last.output.toLowerCase();
  const op = await operationState(cwd);
  if (op) return { kind: 'conflict', message: `The rebase paused: ${op.conflicts.length} file${op.conflicts.length === 1 ? '' : 's'} need your attention.` };
  if (p.intent === 'share' && /rejected|non-fast-forward|fetch first|failed to push/.test(text)) {
    return { kind: 'rejected', message: 'GitHub refused the push because it has commits you don’t have yet. Pushing anyway would overwrite teammates’ work, so nothing was changed. Rebase onto their version first, then share again.', suggest: { intent: 'catchup', branch: p.branch, onto: 'upstream', label: 'Catch up with teammates’ version (rebase)' } };
  }
  if (p.intent === 'pull' && /fast-forward|diverg/.test(text)) {
    return { kind: 'rejected', message: 'A plain pull can’t combine both sides’ commits. Nothing was changed. A rebase puts yours on top of theirs.', suggest: { intent: 'catchup', branch: p.branch, onto: 'upstream', label: 'Catch up with teammates’ version (rebase)' } };
  }
  if (/would be overwritten|please commit your changes or stash/.test(text)) {
    return { kind: 'failed', message: 'Git refused because your uncommitted changes would be lost. Nothing was changed. Commit them (or set them aside) and try again.' };
  }
  return { kind: 'failed', message: 'git stopped with an error. Nothing further was run — see the output below.' };
}

export async function run(cwd, p, token) {
  const pl = await plan(cwd, p);
  if (pl.blocked) return { status: 409, body: { error: pl.blocked.reason } };
  if (pl.invalid) return { status: 400, body: { error: pl.invalid } };
  if (token !== pl.token) return { status: 409, body: { error: 'The repo changed since you reviewed this. Close and review again.' } };
  const results = [];
  for (const s of pl._exec) {
    const r = await exec1(cwd, s, { intent: p.intent, branch: p.branch });
    results.push(r);
    if (!r.ok) break;
  }
  return { status: 200, body: { results, outcome: await classify(cwd, p, results) } };
}

export async function rebaseControl(cwd, action) {
  const op = await operationState(cwd);
  if (!op) return { status: 409, body: { error: 'No rebase is in progress.' } };
  if (action === 'continue' && op.conflicts.length) {
    return { status: 409, body: { error: `Still unresolved: ${op.conflicts.join(', ')}. Fix them, then stage with “git add <file>”.` } };
  }
  const s = step('git', ['rebase', action === 'abort' ? '--abort' : '--continue']);
  const r = await exec1(cwd, s, { intent: action === 'abort' ? 'abort-rebase' : 'continue-rebase', branch: op.branch });
  const now = await operationState(cwd);
  return { status: 200, body: { results: [r], outcome: now ? { kind: 'conflict', message: 'Next commit also has conflicts.' } : r.ok ? { kind: 'ok', message: action === 'abort' ? 'Rebase aborted — your branch is back where it was.' : 'Rebase finished.' } : { kind: 'failed', message: 'git stopped with an error.' } } };
}
