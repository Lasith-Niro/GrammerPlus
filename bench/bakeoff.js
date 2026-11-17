// Phase 0 bake-off: correction quality and latency of candidate models on a JFLEG sample.
// Usage: node bench/bakeoff.js [config.json]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { correct } from '../extension/lib/ollama.js';
import { diffEdits } from '../extension/lib/diff.js';

const configPath = process.argv[2] ?? 'bench/config.json';
const config = JSON.parse(readFileSync(configPath, 'utf8'));

// JFLEG is tokenized ("society ."); models see and produce normal text.
const detok = (s) => s
  .replace(/ ([.,!?;:%)\]}])/g, '$1')
  .replace(/([(\[{$]) /g, '$1')
  .replace(/ (n't|'s|'re|'ve|'ll|'d|'m)\b/gi, '$1')
  .replace(/\s+/g, ' ')
  .trim();

const lines = (f) => readFileSync(`${config.dataDir}/${f}`, 'utf8').split('\n').slice(0, -1).map(detok);
const src = lines('test.src');
const refs = [0, 1, 2, 3].map((k) => lines(`test.ref${k}`));

// Seeded shuffle (mulberry32) so every run uses the same sample.
let seed = config.seed;
const rand = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const idx = src.map((_, i) => i);
for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
const sample = idx.slice(0, config.sampleSize);

// Edit-level scoring (the usual GEC approach): compare the model's word edits on the source
// with each reference's edits; per sentence keep the reference that gives the best F0.5.
// shortcut: exact edit match only (merged/split edits count as misses), upgrade to ERRANT if scores look off.
const editSet = (a, b) => new Set(diffEdits(a, b).map((e) => `${e.start}:${e.end}:${e.replacement}`));
const refEdits = (i) => refs.map((r) => editSet(src[i], r[i]));
const f05 = (tp, fp, fn) => { const p = tp + fp ? tp / (tp + fp) : 1, r = tp + fn ? tp / (tp + fn) : 1; return p + r ? (1.25 * p * r) / (0.25 * p + r) : 0; };
function score(out, i) {
  const mine = editSet(src[i], out);
  let best = null;
  for (const ref of refEdits(i)) {
    const tp = [...mine].filter((e) => ref.has(e)).length;
    const c = { tp, fp: mine.size - tp, fn: ref.size - tp };
    if (!best || f05(c.tp, c.fp, c.fn) > f05(best.tp, best.fp, best.fn)) best = c;
  }
  return best;
}
const exact = (out, i) => refs.some((r) => r[i] === out);
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)];

const baseline = { exactMatch: sample.filter((i) => exact(src[i], i)).length / sample.length };
console.log(`sample=${sample.length} baseline: unchanged input matches a reference ${baseline.exactMatch * 100}% of the time`);

const dir = `runs/${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(dir, { recursive: true });
let gitHash = 'unknown';
try { gitHash = execSync('git rev-parse HEAD').toString().trim(); } catch {}
writeFileSync(`${dir}/config.json`, JSON.stringify({ ...config, gitHash }, null, 2));

const results = [];
const opts = (model) => ({ model, url: config.ollamaUrl, ...(config.builtinPrompt.includes(model) && { system: null }) });
const outputs = {};
for (const model of config.models) {
  try {
    await correct('This are a warm up.', opts(model)); // load model; not timed
  } catch (err) {
    console.log(`${model}: skipped (${err.message})`);
    continue;
  }
  const times = [], exacts = [];
  const tot = { tp: 0, fp: 0, fn: 0 };
  outputs[model] = [];
  try {
    for (const i of sample) {
      const t0 = performance.now();
      const out = await correct(src[i], opts(model));
      times.push(performance.now() - t0);
      const c = score(out, i);
      tot.tp += c.tp; tot.fp += c.fp; tot.fn += c.fn;
      exacts.push(exact(out, i));
      outputs[model].push({ src: src[i], out });
    }
  } catch (err) {
    console.log(`${model}: failed mid-run (${err.message})`);
    continue;
  }
  const row = {
    model,
    precision: +(tot.tp / (tot.tp + tot.fp || 1)).toFixed(3),
    recall: +(tot.tp / (tot.tp + tot.fn || 1)).toFixed(3),
    f05: +f05(tot.tp, tot.fp, tot.fn).toFixed(3),
    exactMatch: +(exacts.filter(Boolean).length / exacts.length).toFixed(3),
    p50ms: Math.round(pct(times, 0.5)),
    p95ms: Math.round(pct(times, 0.95)),
  };
  results.push(row);
  console.log(JSON.stringify(row));
  // Save after every model so a crash keeps finished results.
  writeFileSync(`${dir}/metrics.json`, JSON.stringify({ baseline, results }, null, 2));
  writeFileSync(`${dir}/outputs.json`, JSON.stringify(outputs, null, 2));
}

console.table(results);
console.log(`saved to ${dir}`);
