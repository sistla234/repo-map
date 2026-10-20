import { loadMap } from './git.js';
import { operationState } from './actions.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Plain-text status of the repo, plus a single recommended next step. */
export async function summarize(repoPath) {
  const map = await loadMap(repoPath, { fetch: true });
  const op = await operationState(repoPath);
  const cur = map.rows.find((r) => r.local?.current);
  const wc = map.workingCopy;
  const lines = [];
  lines.push(`Repo: ${map.repo.name}  (${map.repo.path})`);
  lines.push(`Branch: ${wc.detached ? '(detached HEAD)' : wc.branch}${cur ? ` — ${cur.state.replace(/-/g, ' ')}` : ''}`);
  if (cur?.local?.vsUpstream) { const u = cur.local.vsUpstream; lines.push(`  vs GitHub (${cur.local.upstream}): ${plural(u.ahead, 'commit')} not pushed (ahead), ${plural(u.behind, 'commit')} to get (behind)`); }
  if (cur?.local?.vsMain) { const m = cur.local.vsMain; lines.push(`  vs ${map.repo.mainRef}: ${m.ahead} ahead, ${m.behind} behind`); }
  if (cur?.mergeStatus) lines.push(`  Merging into main would: ${cur.mergeStatus.kind === 'conflict' ? `conflict in ${cur.mergeStatus.conflicts.join(', ')}` : cur.mergeStatus.kind === 'behind' ? 'work, but main has moved on' : cur.mergeStatus.kind === 'clean' ? 'merge cleanly' : 'add nothing new'}`);
  lines.push(`Uncommitted changes: ${wc.changes ? `${wc.changes} (${[wc.staged && `${wc.staged} staged`, wc.modified && `${wc.modified} modified`, wc.untracked && `${wc.untracked} new`].filter(Boolean).join(', ')})` : 'none'}`);
  const prs = map.rows.filter((r) => r.pr);
  lines.push(`Open PRs: ${prs.length ? prs.slice(0, 8).map((r) => `#${r.pr.number} ${r.pr.title}${r.pr.draft ? ' (draft)' : ''}`).join('; ') + (prs.length > 8 ? `; …+${prs.length - 8} more` : '') : 'none'}`);
  const attention = map.rows.filter((r) => r.local && ['local-ahead', 'remote-ahead', 'diverged'].includes(r.state) && !r.local.current);
  if (attention.length) lines.push(`Other branches needing attention: ${attention.slice(0, 6).map((r) => `${r.name} (${r.state.replace(/-/g, ' ')})`).join(', ')}${attention.length > 6 ? ', …' : ''}`);
  for (const w of map.warnings) lines.push(`Note: ${w}`);

  let next;
  if (op) next = `A rebase is paused on ${op.branch} with ${plural(op.conflicts.length, 'conflicted file')}${op.conflicts.length ? ` (${op.conflicts.join(', ')})` : ''}. Resolve and continue, or abort, in Repo Map.`;
  else if (!cur) next = 'Switch onto a branch to get a recommendation.';
  else if (cur.state === 'diverged') next = '“Catch up with teammates’ version” (rebase) — you and GitHub both have new commits on this branch.';
  else if (cur.state === 'remote-ahead') next = '“Get teammates’ changes” (pull) — GitHub has commits you don’t.';
  else if (cur.state === 'local-ahead' || cur.state === 'no-upstream') next = wc.changes ? 'Commit your uncommitted changes, then “Share my work”.' : '“Share my work” (push) — your commits aren’t on GitHub yet.';
  else if (wc.changes) next = 'Commit your uncommitted changes (Repo Map doesn’t commit for you), then share them.';
  else if (cur.mergeStatus && ['behind', 'conflict'].includes(cur.mergeStatus.kind)) next = '“Catch up with main” — main has moved on since you branched.';
  else if (cur.mergeStatus?.kind === 'clean' && !cur.pr && !cur.isDefault) next = '“Open a PR” — this branch is on GitHub, merges cleanly, and has no PR yet.';
  else next = 'Nothing needed — you’re up to date.';
  lines.push(`Recommended next step: ${next}`);
  return lines.join('\n');
}
