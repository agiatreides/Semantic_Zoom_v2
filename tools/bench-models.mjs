#!/usr/bin/env node
/**
 * Compare Claude models on the rebuild-levels pipeline.
 *
 * Runs L0-L4 regeneration end-to-end per model, on a seeded copy of the
 * tree + concepts, without touching the canonical files. Records wall-clock
 * timings, per-level word counts vs target, collapse warnings, anchor
 * coverage, and sample text for each level.
 *
 * Usage:
 *   node tools/bench-models.mjs <base-tree.json> <base-concepts.json> <model1> [<model2> ...]
 *
 * Example:
 *   node tools/bench-models.mjs data/the-voting-problem-auto.json \
 *        data/the-voting-problem-auto-concepts.json sonnet haiku
 *
 * Writes:
 *   bench/<model>/tree.json         — the variant's final tree
 *   bench/<model>/concepts.json     — the variant's anchor-updated concepts
 *   bench/<model>/rebuild.log       — full rebuild-levels stdout+stderr
 *   bench/<model>/levels/L{0..5}.txt — plain-text per-level output
 *   bench/REPORT.md                  — side-by-side comparison
 */

import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const args = process.argv.slice(2)
if (args.length < 3) {
  console.error('Usage: node tools/bench-models.mjs <tree.json> <concepts.json> <model1> [<model2> ...]')
  process.exit(1)
}
const [baseTreeArg, baseConceptsArg, ...models] = args
const baseTree = path.resolve(projectRoot, baseTreeArg)
const baseConcepts = path.resolve(projectRoot, baseConceptsArg)

const benchRoot = path.resolve(projectRoot, 'bench')
fs.mkdirSync(benchRoot, { recursive: true })

function runRebuild(model, treePath, conceptsPath, logPath) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const relTree = path.relative(projectRoot, treePath)
    const relConcepts = path.relative(projectRoot, conceptsPath)
    const logStream = fs.createWriteStream(logPath)
    const proc = spawn('node', ['tools/rebuild-levels.js', relTree, relConcepts], {
      cwd: projectRoot,
      env: { ...process.env, MODEL: model },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.stdout.on('data', d => { process.stdout.write(`[${model}] ${d}`); logStream.write(d) })
    proc.stderr.on('data', d => { process.stderr.write(`[${model}] ${d}`); logStream.write(d) })
    proc.on('close', (code) => {
      logStream.end()
      const ms = Date.now() - t0
      resolve({ model, code, ms })
    })
    proc.on('error', (e) => {
      logStream.end()
      resolve({ model, code: -1, ms: Date.now() - t0, error: e.message })
    })
  })
}

function wordsIn(text) {
  return text.split(/\s+/).filter(Boolean).length
}

function analyzeOutput(model, dir) {
  const treePath = path.join(dir, 'tree.json')
  if (!fs.existsSync(treePath)) return { model, error: 'no tree output' }
  const tree = JSON.parse(fs.readFileSync(treePath, 'utf8'))
  const concepts = JSON.parse(fs.readFileSync(path.join(dir, 'concepts.json'), 'utf8'))
  const conceptsArr = Array.isArray(concepts) ? concepts : concepts.concepts
  const Lmax = tree.levelCount - 1
  const levelWords = {}
  const levels = path.join(dir, 'levels')
  fs.mkdirSync(levels, { recursive: true })
  const L5text = tree.levels[String(Lmax)].nodes.map(n => n.text).join(' ')
  const L5w = wordsIn(L5text)
  const targetsRatio = [0.05, 0.15, 0.33, 0.50, 0.75, 1.00]
  const perLevel = []
  for (let L = 0; L <= Lmax; L++) {
    const text = tree.levels[String(L)].nodes.map(n => n.text).join('\n\n')
    fs.writeFileSync(path.join(levels, `L${L}.txt`), text)
    const w = wordsIn(text)
    const target = Math.round(L5w * (targetsRatio[L] ?? 1))
    const pct = target ? ((w - target) / target) * 100 : 0
    levelWords[L] = w
    const visible = conceptsArr.filter(c => (c.min_visible_level ?? tree.levelCount) <= L).length
    const placed = conceptsArr.filter(c => c.anchors?.[String(L)]).length
    perLevel.push({ L, words: w, target, pct: pct.toFixed(0), anchored: `${placed}/${visible}` })
  }
  // Spacing check
  const spacing = []
  let collapse = false
  for (let L = 0; L < Lmax; L++) {
    const ratio = levelWords[L] / levelWords[L + 1]
    const collapsed = ratio > 0.90
    if (collapsed) collapse = true
    spacing.push({ pair: `L${L}/L${L + 1}`, ratio: (ratio * 100).toFixed(0) + '%', collapsed })
  }
  return { model, perLevel, spacing, collapse, L5w }
}

function parseLogTimings(logPath) {
  // rebuild-levels.js emits lines like: `  [gen:L3:a1] 58.3s (4123 chars)`
  const lines = fs.readFileSync(logPath, 'utf8').split('\n')
  const events = []
  let total = 0
  for (const ln of lines) {
    const m = ln.match(/\s*\[([^\]]+)\]\s+([\d.]+)s/)
    if (m) {
      const secs = parseFloat(m[2])
      events.push({ label: m[1], secs })
      if (/^gen:L|^anchor:L/.test(m[1])) total += secs
    }
  }
  return { events, totalClaudeSecs: total }
}

function writeReport(results) {
  const report = []
  report.push(`# Model Benchmark Report\n`)
  report.push(`Base tree: \`${path.relative(projectRoot, baseTree)}\``)
  report.push(`Base concepts: \`${path.relative(projectRoot, baseConcepts)}\``)
  report.push(`Generated: ${new Date().toISOString()}\n`)

  report.push(`## Summary\n`)
  report.push(`| Model | Wall time | Claude-call time | Collapse? |`)
  report.push(`|-------|-----------|------------------|-----------|`)
  for (const r of results) {
    const wall = (r.runMs / 1000 / 60).toFixed(1) + ' min'
    const claudeSec = r.timings ? (r.timings.totalClaudeSecs / 60).toFixed(1) + ' min' : '—'
    report.push(`| ${r.model} | ${wall} | ${claudeSec} | ${r.analysis?.collapse ? '⚠ yes' : 'no'} |`)
  }

  report.push(`\n## Word counts vs target (±10% band is acceptable)\n`)
  const levels = [0, 1, 2, 3, 4, 5]
  report.push(`| Level | Target | ${results.map(r => r.model).join(' | ')} |`)
  report.push(`|-------|--------|${results.map(() => '---').join('|')}|`)
  for (const L of levels) {
    const refTarget = results[0]?.analysis?.perLevel?.[L]?.target ?? '—'
    const cells = results.map(r => {
      const p = r.analysis?.perLevel?.[L]
      if (!p) return '—'
      const bandTag = Math.abs(parseFloat(p.pct)) <= 10 ? '✓' : '✗'
      return `${p.words} (${p.pct > 0 ? '+' : ''}${p.pct}%) ${bandTag}`
    })
    report.push(`| L${L} | ${refTarget} | ${cells.join(' | ')} |`)
  }

  report.push(`\n## Level spacing (ratio to next level up; >90% = collapse)\n`)
  const pairs = ['L0/L1', 'L1/L2', 'L2/L3', 'L3/L4', 'L4/L5']
  report.push(`| Pair | ${results.map(r => r.model).join(' | ')} |`)
  report.push(`|------|${results.map(() => '---').join('|')}|`)
  for (const p of pairs) {
    const cells = results.map(r => {
      const s = r.analysis?.spacing?.find(x => x.pair === p)
      if (!s) return '—'
      return `${s.ratio}${s.collapsed ? ' ⚠' : ''}`
    })
    report.push(`| ${p} | ${cells.join(' | ')} |`)
  }

  report.push(`\n## Anchor coverage (placed/visible per level)\n`)
  report.push(`| Level | ${results.map(r => r.model).join(' | ')} |`)
  report.push(`|-------|${results.map(() => '---').join('|')}|`)
  for (const L of levels) {
    const cells = results.map(r => r.analysis?.perLevel?.[L]?.anchored ?? '—')
    report.push(`| L${L} | ${cells.join(' | ')} |`)
  }

  report.push(`\n## Per-call timings (seconds)\n`)
  for (const r of results) {
    report.push(`### ${r.model}`)
    if (!r.timings) { report.push('  (no timing data)'); continue }
    for (const ev of r.timings.events.filter(e => /^gen:L|^anchor:L|^trim:L/.test(e.label))) {
      report.push(`- ${ev.label}: ${ev.secs.toFixed(1)}s`)
    }
  }

  report.push(`\n## Files to read\n`)
  for (const r of results) {
    report.push(`### ${r.model}`)
    report.push(`- Tree JSON: \`bench/${r.model}/tree.json\``)
    report.push(`- Concepts JSON: \`bench/${r.model}/concepts.json\``)
    report.push(`- Rebuild log: \`bench/${r.model}/rebuild.log\``)
    report.push(`- Level texts: \`bench/${r.model}/levels/L{0..5}.txt\``)
  }

  fs.writeFileSync(path.join(benchRoot, 'REPORT.md'), report.join('\n') + '\n')
  console.log(`\n=== Report written: ${path.relative(projectRoot, path.join(benchRoot, 'REPORT.md'))} ===\n`)
}

// -------- main (models run in parallel) --------
const runs = models.map(async (model) => {
  const dir = path.join(benchRoot, model)
  fs.mkdirSync(dir, { recursive: true })
  const treeCopy = path.join(dir, 'tree.json')
  const conceptsCopy = path.join(dir, 'concepts.json')
  fs.copyFileSync(baseTree, treeCopy)
  fs.copyFileSync(baseConcepts, conceptsCopy)
  const logPath = path.join(dir, 'rebuild.log')
  console.log(`\n=== START ${model} ===`)
  const runInfo = await runRebuild(model, treeCopy, conceptsCopy, logPath)
  console.log(`=== DONE ${model} in ${(runInfo.ms / 1000 / 60).toFixed(1)} min (exit ${runInfo.code}) ===`)
  const analysis = analyzeOutput(model, dir)
  const timings = parseLogTimings(logPath)
  return { ...runInfo, analysis, timings, runMs: runInfo.ms }
})

const results = await Promise.all(runs)
writeReport(results)
