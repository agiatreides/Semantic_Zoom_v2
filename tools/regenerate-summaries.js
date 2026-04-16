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
  console.error('Usage: node tools/regenerate-summaries.js <tree.json> <concepts.json> [--output <out.json>]')
  process.exit(1)
}
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const treePath = path.resolve(projectRoot, args[0])
const conceptsPath = path.resolve(projectRoot, args[1])
let outputPath = treePath
for (let i = 2; i < args.length; i++) {
  if (args[i] === '--output' && args[i + 1]) outputPath = path.resolve(projectRoot, args[++i])
}

console.log(`Reading tree: ${path.relative(projectRoot, treePath)}`)
const tree = JSON.parse(fs.readFileSync(treePath, 'utf8'))
const concepts = JSON.parse(fs.readFileSync(conceptsPath, 'utf8'))
const Lmax = tree.levelCount - 1
const totalWords = (tree.levels[String(Lmax)]?.nodes || [])
  .map(n => n.text.split(/\s+/).length).reduce((a, b) => a + b, 0)
console.log(`Tree: "${tree.title}" with ${tree.levelCount} levels, ${totalWords} words at L${Lmax}`)
console.log(`Concepts: ${concepts.length}`)

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
  const jobs = []
  let viaKept = 0
  for (const node of tree.levels[String(L)].nodes) {
    const childIds = node.children || []
    if (childIds.length === 0) continue
    const childMembers = childIds
      .map(cid => nodeByLevelId[`${L + 1}:${cid}`])
      .filter(Boolean)
      .map(cn => ({ text: cn.text }))
    if (childMembers.length === 0) continue

    // Does any essential's anchor land in this node's subtree?
    const subtree = descendantsOf(node.id, L)
    const relevantEssentials = essentials.filter(e => {
      // essentials list carries only label+snippet; we need to find the
      // matching concept back and check anchors. Do it against the
      // concepts list.
      const fullConcept = concepts.find(c => c.label === e.label)
      if (!fullConcept) return false
      for (let LL = L + 1; LL <= Lmax; LL++) {
        const a = fullConcept.anchors[String(LL)]
        if (a && subtree[String(LL)]?.has(a.nodeId)) return true
      }
      return false
    })

    if (relevantEssentials.length === 0) {
      viaKept++
      continue
    }

    const childWordCount = childMembers.reduce((s, m) => s + m.text.split(/\s+/).length, 0)
    const targetWords = targetWordCount(childWordCount, Lmax - L, 0, totalWords)
    jobs.push({ node, childMembers, childWordCount, targetWords, relevantEssentials })
  }
  console.log(`  ${jobs.length} nodes to re-reduce (parallel ${Math.min(CONCURRENCY, jobs.length)}), ${viaKept} kept as-is (no essentials in subtree)`)

  const tStart = Date.now()
  await pmap(jobs, CONCURRENCY, async (job) => {
    const { node, childMembers, childWordCount, targetWords, relevantEssentials } = job
    process.stdout.write(`  [start ${node.id}] ${childMembers.length} children, ~${childWordCount}w → ~${targetWords}w, ${relevantEssentials.length} essentials\n`)
    const newText = await claudeSummarizeAsync(childMembers, targetWords, [], { essentials: relevantEssentials })
    if (newText) {
      node.text = newText
    } else {
      console.log(`    [${node.id}] re-reduce failed — keeping original text`)
    }
  })
  console.log(`  L${L} done in ${((Date.now() - tStart)/1000).toFixed(1)}s`)
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
