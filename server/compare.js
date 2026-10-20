import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { readMeta, shotDir, cacheRoot } from './shots.js';

const execp = promisify(execFile);
const gitOut = async (cwd, args, max = 20 * 1024 * 1024) => {
  try { const { stdout } = await execp('git', args, { cwd, maxBuffer: max }); return stdout; } catch (e) { if (e.code === 1 && e.stdout) return e.stdout; return null; }
};

/** Turn a sha / branch / tag into a full commit sha, or null. Refuses anything that looks like an option. */
export async function resolveRev(cwd, rev) {
  if (typeof rev !== 'string' || !rev || rev.startsWith('-') || rev.length > 200) return null;
  const o = await gitOut(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return o ? o.trim() : null;
}
export async function mergeBase(cwd, a, b) {
  const o = await gitOut(cwd, ['merge-base', a, b]);
  return o ? o.trim() : null;
}
export async function describeCommit(cwd, sha) {
  const o = await gitOut(cwd, ['log', '-1', '--format=%h\x1f%s\x1f%an\x1f%cI', sha]);
  if (!o) return null;
  const [short, subject, author, date] = o.trim().split('\x1f');
  return { sha, short, subject, author, date };
}

// ---- visual compare -------------------------------------------------------
function padTo(png, w, h) {
  if (png.width === w && png.height === h) return png;
  const out = new PNG({ width: w, height: h });
  out.data.fill(255);
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0);
  return out;
}

export function compareShots(repoName, a, b) {
  const ma = readMeta(repoName, a); const mb = readMeta(repoName, b);
  const missing = [!ma && a, !mb && b].filter(Boolean);
  if (missing.length) return { missing };
  const dir = path.join(cacheRoot(repoName), 'diffs', `${a.slice(0, 12)}_${b.slice(0, 12)}`);
  fs.mkdirSync(dir, { recursive: true });
  const slugs = [...new Map([...ma.routes, ...mb.routes].map((r) => [r.slug, r])).values()];
  const routes = slugs.map((r) => {
    const ra = ma.routes.find((x) => x.slug === r.slug); const rb = mb.routes.find((x) => x.slug === r.slug);
    const base = { slug: r.slug, path: r.path, name: r.name };
    if (!ra?.ok || !rb?.ok) return { ...base, error: !ra?.ok && !rb?.ok ? `Couldn’t capture on either side${ra?.error ? ` (${ra.error})` : ''}` : `Couldn’t capture on the ${ra?.ok ? 'B' : 'A'} side${(ra?.ok ? rb : ra)?.error ? `: ${(ra?.ok ? rb : ra).error}` : ''}` };
    const statFile = path.join(dir, `${r.slug}.json`);
    const diffFile = path.join(dir, `${r.slug}.png`);
    let stat;
    try { stat = JSON.parse(fs.readFileSync(statFile, 'utf8')); if (!fs.existsSync(diffFile)) throw new Error('x'); } catch {
      const ia = PNG.sync.read(fs.readFileSync(path.join(shotDir(repoName, a), `${r.slug}.png`)));
      const ib = PNG.sync.read(fs.readFileSync(path.join(shotDir(repoName, b), `${r.slug}.png`)));
      const w = Math.max(ia.width, ib.width); const h = Math.max(ia.height, ib.height);
      const pa = padTo(ia, w, h); const pb = padTo(ib, w, h);
      const out = new PNG({ width: w, height: h });
      const changed = pixelmatch(pa.data, pb.data, out.data, w, h, { threshold: 0.1, alpha: 0.25, diffColor: [255, 40, 90], aaColor: [255, 190, 0] });
      fs.writeFileSync(diffFile, PNG.sync.write(out));
      stat = { changed, total: w * h, pct: (changed / (w * h)) * 100, sizeA: [ia.width, ia.height], sizeB: [ib.width, ib.height] };
      fs.writeFileSync(statFile, JSON.stringify(stat));
    }
    return { ...base, a: `/api/shot/${a}/${r.slug}.png`, b: `/api/shot/${b}/${r.slug}.png`, diff: `/api/diffimg/${a.slice(0, 12)}_${b.slice(0, 12)}/${r.slug}.png`, changedPct: stat.pct, pixelsChanged: stat.changed, sizeA: stat.sizeA, sizeB: stat.sizeB, sizeMismatch: stat.sizeA[0] !== stat.sizeB[0] || stat.sizeA[1] !== stat.sizeB[1] };
  });
  routes.sort((x, y) => (y.changedPct ?? -1) - (x.changedPct ?? -1));
  return { routes, summary: { routes: routes.length, changed: routes.filter((r) => r.changedPct > 0.01).length, errors: routes.filter((r) => r.error).length } };
}

// ---- file diff ------------------------------------------------------------
const range = (a, b, three) => (three ? `${a}...${b}` : `${a}..${b}`);

export async function diffFiles(cwd, a, b, three) {
  const rg = range(a, b, three);
  const [ns, num] = await Promise.all([
    gitOut(cwd, ['diff', '--no-renames', '--name-status', rg]),
    gitOut(cwd, ['diff', '--no-renames', '--numstat', rg]),
  ]);
  if (ns === null) return null;
  const stats = new Map((num || '').split('\n').filter(Boolean).map((l) => { const [ad, de, ...p] = l.split('\t'); return [p.join('\t'), { added: ad === '-' ? null : Number(ad), deleted: de === '-' ? null : Number(de) }]; }));
  return ns.split('\n').filter(Boolean).map((l) => {
    const [status, ...p] = l.split('\t'); const file = p.join('\t');
    return { status: status[0], path: file, ...(stats.get(file) || {}) };
  });
}

export async function diffPatch(cwd, a, b, three, file) {
  const files = await diffFiles(cwd, a, b, three);
  if (!files || !files.some((f) => f.path === file)) return null;
  const o = await gitOut(cwd, ['diff', '--no-color', '--no-renames', range(a, b, three), '--', file]);
  if (o === null) return null;
  return o.length > 300000 ? `${o.slice(0, 300000)}\n… (diff truncated)` : o;
}
