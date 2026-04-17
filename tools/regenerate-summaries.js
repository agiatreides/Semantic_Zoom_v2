#!/usr/bin/env node
/**
 * Re-reduces the upper levels of an EXISTING tree using a concepts file
 * (with min_visible_level per concept). Replaces each non-leaf node's
 * text with a fresh Claude reduction that includes ONLY the events
 * whose min_visible_level <= L. Leaves L_max alone (it's the source).
 *
 * Why a separate tool: generate-tree.js builds the tree bottom-up from
 * scratch (embed → cluster → reduce, ~15-25 Claude calls). When we just
 * want to re-reduce upper levels with new concept guidance, we don't
 * need to rebuild — we already have the tree's children mapping. This
 * tool does ONLY the re-reduce step, reusing claudeSummarize.
 *
 * Usage:
 *   node tools/regenerate-summaries.js data/foo.json data/foo-concepts.json
 *   node tools/regenerate-summaries.js data/foo.json data/foo-concepts.json --output data/foo.json
 *
 * Output:
 *   - Writes a new tree.json (default: overwrites the input).
 *   - Phrase maps are preserved in shape but their TEXT and char ranges
 *     become stale relative to the new node text. Re-run extract-concepts
 *     after this to refresh anchors against the updated text.
 */

import fs from 'fs'
import path from 'path'
import { claudeSummarizeAsync, targetWordCount } from './lib/summarize.js'

// Run promise-returning fns with bounded concurrency. Default 8 — tested
// safe; fewer simultaneous Claude subprocesses keeps per-call latency low.
async function pmap(items, concurrency, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker)
  await Promise.all(workers)
  return results
}

const args = process.argv.slice(2)
if (args.length < 2 || args.includes('--help')) {
  console.error('Usage: node tools/regenerate-summaries.js <tree.json> <concepts.json> [--output <out.json>] [--only-level N] [--skip-drop]')
  process.exit(1)
}
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const treePath = path.resolve(projectRoot, args[0])
const conceptsPath = path.resolve(projectRoot, args[1])
let outputPath = treePath
let onlyLevel = null
let skipDrop = false
for (let i = 2; i < args.length; i++) {
  if (args[i] === '--output' && args[i + 1]) outputPath = path.resolve(projectRoot, args[++i])
  else if (args[i] === '--only-level' && args[i + 1]) onlyLevel = parseInt(args[++i], 10)
  else if (args[i] === '--skip-drop') skipDrop = true
}

console.log(`Reading tree: ${path.relative(projectRoot, treePath)}`)
const tree = JSON.parse(fs.readFileSync(treePath, 'utf8'))
const conceptsRaw = JSON.parse(fs.readFileSync(conceptsPath, 'utf8'))
// Support both shapes: bare array (old) and {concepts, characters} (new)
const concepts = Array.isArray(conceptsRaw) ? conceptsRaw : (conceptsRaw.concepts || [])
const characters = (!Array.isArray(conceptsRaw) && conceptsRaw.characters) || {}
const Lmax = tree.levelCount - 1
const totalWords = (tree.levels[String(Lmax)]?.nodes || [])
  .map(n => n.text.split(/\s+/).length).reduce((a, b) => a + b, 0)
console.log(`Tree: "${tree.title}" with ${tree.levelCount} levels, ${totalWords} words at L${Lmax}`)
console.log(`Concepts: ${concepts.length}, Characters: ${Object.keys(characters).length}`)

// Build a quick lookup: nodeId → node, per level
const nodeByLevelId = {}
for (let L = 0; L < tree.levelCount; L++) {
  for (const n of tree.levels[String(L)].nodes) {
    nodeByLevelId[`${L}:${n.id}`] = n
  }
}

// Re-reduce non-leaf levels in parallel within each level. Levels still
// run sequentially because L's reduction depends on L+1's (already-reduced)
// text — but within a level, every node is independent and we fan out.
const CONCURRENCY = 8

for (let L = 0; L < tree.levelCount - 1; L++) {
  if (onlyLevel !== null && L !== onlyLevel) continue
  const essentials = concepts
    .filter(c => (c.min_visible_level ?? tree.levelCount) <= L)
    .map(c => ({
      label: c.label,
      snippet: (() => {
        for (let LL = L + 1; LL <= Lmax; LL++) {
          const a = c.anchors[String(LL)]
          if (a) {
            const node = nodeByLevelId[`${LL}:${a.nodeId}`]
            if (node) return node.text.substring(a.charStart, a.charEnd)
          }
        }
        return ''
      })()
    }))

  console.log(`\nL${L}: ${essentials.length} essentials (min_visible_level <= ${L})`)
  if (essentials.length === 0) {
    console.log(`  no essentials at this level — skipping`)
    continue
  }

  // For each node, determine which essentials (if any) have a descendant
  // anchor at any deeper level whose subtree is rooted at this node. If
  // NONE of the essentials land within this cluster's subtree, skip the
  // Claude call — keep the existing text. This avoids Claude writing
  // meta-notes like "this passage contains none of the listed events" when
  // we told it to only include listed events.
  const descendantsOf = (nodeId, startLevel) => {
    // Walk down from a node, collecting all descendant node ids by level.
    const out = { [String(startLevel)]: new Set([nodeId]) }
    for (let LL = startLevel; LL < Lmax; LL++) {
      const nextSet = new Set()
      for (const nid of out[String(LL)]) {
        const n = nodeByLevelId[`${LL}:${nid}`]
        if (n && Array.isArray(n.children)) {
          for (const cid of n.children) nextSet.add(cid)
        }
      }
      out[String(LL + 1)] = nextSet
    }
    return out
  }

  // Build the list of jobs for this level; filter out clusters that
  // contain no essentials in their subtree.
  //
  // Key refinement: the input we pass to the reducer is NOT the children's
  // full text. Instead, for each essential whose anchor is in this cluster's
  // children, we extract JUST the anchor's text span (with a small word-
  // rounded buffer to preserve sentence boundaries). This starves Claude
  // of context it could leak from — no "conference room", no "Derek
  // pitches" surviving as continuity glue. The reducer's input contains
  // only the text of the events that should actually appear at this level.
  const bufferedSpanFromChild = (childId, anchor) => {
    const child = nodeByLevelId[`${L + 1}:${childId}`]
    if (!child) return null
    const text = child.text
    // Round to sentence boundaries where possible — walk out from the anchor
    // until we hit a sentence-ending punctuation or the node edge. Keeps
    // dialogue + voice intact; avoids cutting mid-clause.
    let s = anchor.charStart
    let e = anchor.charEnd
    while (s > 0 && !/[.!?]["'\u201d\u2019)\s]*$/.test(text.substring(0, s))) s--
    while (e < text.length && !/[.!?]/.test(text[e - 1])) e++
    // Guard: don't balloon past ~3x anchor size
    const cap = (anchor.charEnd - anchor.charStart) * 3 + 80
    if (e - s > cap) {
      s = Math.max(0, anchor.charStart - 20)
      e = Math.min(text.length, anchor.charEnd + 20)
    }
    return text.substring(s, e).trim()
  }

  const halfway = Math.floor((tree.levelCount - 1) / 2)
  const jobs = []
  const toDelete = []    // nodes at this L with zero essentials at upper levels — drop entirely
  let viaKept = 0
  for (const node of tree.levels[String(L)].nodes) {
    const childIds = node.children || []
    if (childIds.length === 0) continue

    // For each essential, collect the text span from THIS cluster's
    // children where the essential's anchor lives at L+1.
    const spanMembers = []    // [{ text }, …] — fed to the reducer
    const relevantEssentials = []
    for (const e of essentials) {
      const fullConcept = concepts.find(c => c.label === e.label)
      if (!fullConcept) continue
      const aL1 = fullConcept.anchors[String(L + 1)]
      if (!aL1) continue
      if (!childIds.includes(aL1.nodeId)) continue  // essential is in a different cluster
      const span = bufferedSpanFromChild(aL1.nodeId, aL1)
      if (!span) continue
      spanMembers.push({ text: span })
      relevantEssentials.push(e)
    }

    if (relevantEssentials.length === 0) {
      // No essentials at this level for this cluster. Poker-nuts rule: at
      // UPPER levels (L <= halfway), the cluster is backdrop — drop it
      // entirely rather than trim-to-first-sentence (which used to leave
      // standalone artifacts like "Derek pitches a pivot to the creator
      // economy model." at L2 even though Derek's `min_visible_level=5`).
      // At deeper levels (L > halfway), keep the original prose as-is —
      // backdrop is fine when there's room to spare.
      if (!skipDrop && L <= halfway) { toDelete.push(node.id); continue }
      viaKept++
      continue
    }

    const spanWordCount = spanMembers.reduce((s, m) => s + m.text.split(/\s+/).length, 0)
    const targetWords = targetWordCount(spanWordCount, Lmax - L, 0, totalWords)
    jobs.push({ node, childMembers: spanMembers, childWordCount: spanWordCount, targetWords, relevantEssentials })
  }
  console.log(`  ${jobs.length} nodes to re-reduce (parallel ${Math.min(CONCURRENCY, jobs.length)}), ${viaKept} kept (backdrop at deeper level), ${toDelete.length} dropped (no essentials at upper level)`)

  const tStart = Date.now()
  await pmap(jobs, CONCURRENCY, async (job) => {
    const { node, childMembers, childWordCount, targetWords, relevantEssentials } = job
    process.stdout.write(`  [start ${node.id}] ${childMembers.length} children, ~${childWordCount}w → ~${targetWords}w, ${relevantEssentials.length} essentials\n`)
    const newText = await claudeSummarizeAsync(childMembers, targetWords, [], { essentials: relevantEssentials, characters })
    if (newText) {
      node.text = newText
    } else {
      console.log(`    [${node.id}] re-reduce failed — keeping original text`)
    }
  })
  console.log(`  L${L} done in ${((Date.now() - tStart)/1000).toFixed(1)}s`)

  // Drop no-essential upper-level nodes + prune from parent .children lists.
  // Only affects L <= halfway. Parents at L-1 already consumed the old L
  // text; removing the child id just prevents downstream tools
  // (extract-concepts, any future walker) from following a dead pointer.
  // Safety: never empty a level — the renderer draws level.nodes directly.
  if (toDelete.length > 0) {
    const total = tree.levels[String(L)].nodes.length
    let finalDelete = toDelete
    if (total - toDelete.length < 1) {
      // Would empty the level — keep the first flagged node as a placeholder
      const keep = toDelete[0]
      finalDelete = toDelete.slice(1)
      console.log(`  (level ${L} would be emptied — keeping node ${keep} as placeholder)`)
    }
    const dead = new Set(finalDelete)
    tree.levels[String(L)].nodes = tree.levels[String(L)].nodes.filter(n => !dead.has(n.id))
    if (L > 0) {
      for (const parent of tree.levels[String(L - 1)].nodes) {
        if (Array.isArray(parent.children)) {
          parent.children = parent.children.filter(cid => !dead.has(cid))
        }
      }
    }
    for (const id of finalDelete) delete nodeByLevelId[`${L}:${id}`]
    console.log(`  dropped ${finalDelete.length} backdrop nodes from L${L} (${total} → ${tree.levels[String(L)].nodes.length})`)
  }
}

// Phrase maps are now stale. Rather than recomputing them (which needs the
// embedding model), strip them — extract-concepts re-run will regenerate
// the *-concepts.json against the new text. The renderer can fall back to
// concept-anchored navigation; phrase-chain becomes a fallback only.
let phrasesStripped = 0
for (let L = 0; L < tree.levelCount; L++) {
  for (const node of tree.levels[String(L)].nodes) {
    if (node.phrases) { phrasesStripped += node.phrases.length; node.phrases = [] }
  }
}
console.log(`\nStripped ${phrasesStripped} stale phrase entries (re-run generate-tree's phrase pass to regenerate, or rely on concept anchors).`)

fs.writeFileSync(outputPath, JSON.stringify(tree, null, 2))
console.log(`\nWrote ${path.relative(projectRoot, outputPath)}`)
console.log('\nNext: re-run extract-concepts on the new tree to refresh anchors:')
console.log(`  node tools/extract-concepts.js ${path.relative(projectRoot, outputPath)}`)
