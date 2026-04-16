#!/usr/bin/env node
/**
 * Concept anchor extractor for Semantic Zoom v2.
 *
 * Takes a tree.json (output of generate-tree.js or any compatible tree)
 * and produces a sibling <basename>-concepts.json with per-level anchors
 * for each major concept. Required by the renderer's concept-anchored
 * zoom (src/main.js wheel handler).
 *
 * Usage:
 *   node tools/extract-concepts.js data/foo.json
 *   node tools/extract-concepts.js data/foo.json --output data/foo-concepts.json
 *   node tools/extract-concepts.js data/foo.json --concept-count 12
 *
 * Algorithm (1 Claude call total + deterministic propagation):
 *   1. Read the deepest level's text. Ask Claude to identify N major
 *      concepts AND for each one, give a verbatim snippet from that text.
 *      Anchor each concept at L_max by literal substring search.
 *   2. Walk UPWARD via the tree's existing `children` field. For each
 *      concept anchored at L+1 in node N, find its parent at L (the L
 *      node whose children include N). Locate the concept inside the
 *      parent's text by:
 *        a) literal substring match (summary preserved the phrase), or
 *        b) fuzzy window match (highest word-overlap N-gram), or
 *        c) fall back to the parent's full extent for that level only.
 *
 * Designed for any prose: research papers, books, short stories, essays.
 * No hand-curation, no per-level Claude calls in the hot loop.
 */

import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

const args = process.argv.slice(2)
if (!args[0] || args.includes('--help') || args.includes('-h')) {
  console.error('Usage: node tools/extract-concepts.js <tree.json> [--output <out.json>] [--concept-count N]')
  process.exit(1)
}

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const inputPath = path.resolve(projectRoot, args[0])
let outputPath = null
let conceptCount = null
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--output' && args[i + 1]) { outputPath = path.resolve(projectRoot, args[++i]) }
  else if (args[i] === '--concept-count' && args[i + 1]) { conceptCount = parseInt(args[++i], 10) }
}
if (!outputPath) {
  const dir = path.dirname(inputPath)
  const base = path.basename(inputPath, '.json')
  outputPath = path.join(dir, `${base}-concepts.json`)
}

// --------------------------------------------------------------------
// Claude CLI helper
// --------------------------------------------------------------------

function callClaude(prompt, label) {
  const t0 = Date.now()
  try {
    const result = execSync('claude -p --output-format text', {
      input: prompt,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 600000,
    }).trim()
    const ms = Date.now() - t0
    console.log(`    [${label}] ${(ms/1000).toFixed(1)}s, ${result.length} chars`)
    return result || null
  } catch (e) {
    const ms = Date.now() - t0
    console.error(`  [${label}] Claude call failed after ${(ms/1000).toFixed(1)}s:`, e.message?.substring(0, 200))
    return null
  }
}

function parseJsonResponse(raw, label) {
  if (!raw) return null
  let s = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  // Find first '[' or '{' (skip preamble)
  let startIdx = -1
  for (const c of ['[', '{']) {
    const i = s.indexOf(c)
    if (i !== -1 && (startIdx === -1 || i < startIdx)) startIdx = i
  }
  if (startIdx > 0) s = s.substring(startIdx)
  // Trim trailing junk
  const lastBracket = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'))
  if (lastBracket !== -1 && lastBracket < s.length - 1) s = s.substring(0, lastBracket + 1)
  try {
    return JSON.parse(s)
  } catch (e) {
    console.error(`  [${label}] JSON parse failed:`, e.message)
    console.error('  raw response (first 500 chars):', raw.substring(0, 500))
    return null
  }
}

// --------------------------------------------------------------------
// Pass 1: identify concepts + their L_max snippets via Claude
// --------------------------------------------------------------------

function identifyAndAnchorAtLmax(tree, targetCount) {
  const maxL = String(tree.levelCount - 1)
  const nodes = tree.levels[maxL]?.nodes || []
  // Build a numbered, char-counted listing per node so the model can
  // pick a node and write a verbatim snippet that we can locate.
  const nodeBlock = nodes.map(n =>
    `=== NODE ${n.id} (${n.text.length} chars) ===\n${n.text}`
  ).join('\n\n')
  const totalWords = nodes.map(n => n.text.split(/\s+/).length).reduce((a,b)=>a+b, 0)

  if (!targetCount) {
    // ~1 concept per ~200 words for short pieces, dropping with length so
    // a 50K-word book doesn't ask for 250 concepts.
    targetCount = Math.max(8, Math.min(20, Math.round(Math.sqrt(totalWords) / 1.5)))
  }

  const prompt = `You are extracting major concepts from a piece of prose for a semantic-zoom reader. The reader hovers over a phrase and zooms; the system keeps that concept anchored across zoom levels.

Identify approximately ${targetCount} major concepts. A "concept" is a discrete idea, scene, claim, decision, or character moment a reader would point to and say "that part." Concepts must be:

- DISTINCT — each nameable in 3-7 words, semantically separate from the others
- STABLE — present in the text, not synthesized from outside
- SPANNING — together they should cover the major beats; minor flavor details are fine to omit

For EACH concept, return:
- "id": stable kebab-case identifier (lowercase, words separated by underscores)
- "label": 3-7 word human-readable label
- "nodeId": the node id (e.g. "${nodes[0]?.id}") where this concept is most clearly expressed
- "snippet": 20-150 character VERBATIM quote from that node's text, copied EXACTLY (preserve spaces, punctuation, capitalization, smart quotes — anything you write must literally appear in the node's text). This is used to anchor the concept by substring search; misquoted snippets will be dropped.

Output STRICT JSON: a single array of objects. No markdown fences, no commentary, no preamble. Just the JSON array.

NODES (level ${maxL}, ${totalWords} words total):
${nodeBlock}

Return the JSON array.`

  console.log(`Pass 1: identifying ~${targetCount} concepts from L${maxL} (${totalWords} words)...`)
  const raw = callClaude(prompt, 'identify')
  const parsed = parseJsonResponse(raw, 'identify')
  if (!Array.isArray(parsed)) {
    console.error('  Pass 1 failed: did not get an array')
    return null
  }

  const concepts = []
  for (const c of parsed) {
    if (!c || typeof c.id !== 'string' || typeof c.label !== 'string') continue
    if (typeof c.nodeId !== 'string' || typeof c.snippet !== 'string') continue
    const node = nodes.find(n => n.id === c.nodeId)
    if (!node) {
      console.warn(`  drop "${c.id}": nodeId ${c.nodeId} not at L${maxL}`)
      continue
    }
    const idx = node.text.indexOf(c.snippet)
    if (idx === -1) {
      console.warn(`  drop "${c.id}": snippet not literally found in ${c.nodeId}`)
      continue
    }
    concepts.push({
      id: c.id.trim(),
      label: c.label.trim(),
      snippet: c.snippet,
      lmaxAnchor: { nodeId: c.nodeId, charStart: idx, charEnd: idx + c.snippet.length },
    })
  }
  console.log(`  identified ${concepts.length} concepts with valid L${maxL} anchors`)
  return concepts
}

// --------------------------------------------------------------------
// Helpers for upward propagation
// --------------------------------------------------------------------

function buildParentMap(tree) {
  // For each (level, nodeId) we store its parent at level-1.
  const parentMap = {} // key: "L:nodeId" → { parentLevel, parentId }
  for (let L = 0; L < tree.levelCount - 1; L++) {
    const nodes = tree.levels[String(L)]?.nodes || []
    for (const p of nodes) {
      const children = p.children || []
      for (const childId of children) {
        parentMap[`${L + 1}:${childId}`] = { parentLevel: L, parentId: p.id }
      }
    }
  }
  return parentMap
}

function tokenize(s) {
  return (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => w.length > 2)
}

function fuzzyAnchor(parentText, snippet, label) {
  // Token bag for matching: snippet tokens (high weight) + label tokens (low weight),
  // with English stopwords removed (cheap inline list).
  const STOP = new Set(['the','a','an','and','or','but','of','to','in','on','at','for','by',
    'with','from','as','is','was','were','are','be','been','being','have','has','had',
    'this','that','these','those','it','its','he','she','his','her','him','they','them',
    'their','my','your','our','not','no','do','does','did','will','would','could','should'])
  const sTokens = tokenize(snippet).filter(w => !STOP.has(w))
  const lTokens = tokenize(label).filter(w => !STOP.has(w))
  const weights = new Map()
  for (const t of sTokens) weights.set(t, (weights.get(t) || 0) + 2)
  for (const t of lTokens) weights.set(t, (weights.get(t) || 0) + 1)
  if (weights.size === 0) return null

  // Build word-position index for the parent text
  const wordRe = /[A-Za-z0-9'-]+/g
  const positions = []
  let m
  while ((m = wordRe.exec(parentText)) !== null) {
    positions.push({ start: m.index, end: m.index + m[0].length, lc: m[0].toLowerCase() })
  }
  if (positions.length === 0) return null

  // Sliding window — same word count as snippet, scan and score by weighted overlap
  const winWords = Math.max(4, Math.min(40, sTokens.length || 6))
  let bestStart = 0, bestEnd = 0, bestScore = 0
  for (let i = 0; i + winWords <= positions.length; i++) {
    let score = 0
    for (let j = i; j < i + winWords; j++) {
      const w = weights.get(positions[j].lc)
      if (w) score += w
    }
    if (score > bestScore) {
      bestScore = score
      bestStart = positions[i].start
      bestEnd = positions[i + winWords - 1].end
    }
  }
  if (bestScore === 0) return null
  return { charStart: bestStart, charEnd: bestEnd, score: bestScore }
}

function anchorAtParent(concept, parentNode) {
  // 1. Literal snippet (summary preserved the phrase)
  const idx = parentNode.text.indexOf(concept.snippet)
  if (idx !== -1) {
    return { nodeId: parentNode.id, charStart: idx, charEnd: idx + concept.snippet.length, via: 'literal' }
  }
  // 2. Try first ~40 chars of snippet (summary may have trimmed it)
  const head = concept.snippet.substring(0, Math.min(40, concept.snippet.length))
  const idx2 = parentNode.text.indexOf(head)
  if (idx2 !== -1 && head.length >= 12) {
    return { nodeId: parentNode.id, charStart: idx2, charEnd: idx2 + head.length, via: 'literal-head' }
  }
  // 3. Fuzzy word-overlap window
  const fz = fuzzyAnchor(parentNode.text, concept.snippet, concept.label)
  if (fz) {
    return { nodeId: parentNode.id, charStart: fz.charStart, charEnd: fz.charEnd, via: 'fuzzy', score: fz.score }
  }
  return null
}

// --------------------------------------------------------------------
// Main
// --------------------------------------------------------------------

console.log(`Reading tree: ${path.relative(projectRoot, inputPath)}`)
const tree = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
const levelCount = tree.levelCount
const Lmax = levelCount - 1
console.log(`Tree: "${tree.title}" with ${levelCount} levels`)

const concepts = identifyAndAnchorAtLmax(tree, conceptCount)
if (!concepts || concepts.length === 0) {
  console.error('No concepts identified — aborting.')
  process.exit(2)
}

// Initialize anchors map with L_max anchors
const anchorsByConcept = {}
for (const c of concepts) {
  anchorsByConcept[c.id] = { [String(Lmax)]: c.lmaxAnchor }
}

// Build parent-lookup from tree.children
const parentMap = buildParentMap(tree)

// Walk UPWARD: L_max-1 down to L0
console.log(`\nPropagating concepts upward through ${Lmax} levels via tree.children...`)
for (let L = Lmax - 1; L >= 0; L--) {
  const lstr = String(L)
  const nodes = tree.levels[lstr]?.nodes || []
  const nodeById = Object.fromEntries(nodes.map(n => [n.id, n]))

  let placed = 0
  let viaLiteral = 0, viaFuzzy = 0, viaNone = 0
  for (const c of concepts) {
    const childAnchor = anchorsByConcept[c.id][String(L + 1)]
    if (!childAnchor) { viaNone++; continue }
    const pinfo = parentMap[`${L + 1}:${childAnchor.nodeId}`]
    if (!pinfo) { viaNone++; continue }
    const parent = nodeById[pinfo.parentId]
    if (!parent) { viaNone++; continue }
    const a = anchorAtParent(c, parent)
    if (!a) { viaNone++; continue }
    anchorsByConcept[c.id][lstr] = { nodeId: a.nodeId, charStart: a.charStart, charEnd: a.charEnd }
    placed++
    if (a.via === 'literal' || a.via === 'literal-head') viaLiteral++
    else viaFuzzy++
  }
  console.log(`  L${L}: ${placed}/${concepts.length} placed (${viaLiteral} literal, ${viaFuzzy} fuzzy, ${viaNone} skipped)`)
}

// Emit
const output = concepts.map(c => ({
  id: c.id,
  label: c.label,
  anchors: anchorsByConcept[c.id],
}))
const final = output.filter(c => Object.keys(c.anchors).length > 0)
const dropped = output.length - final.length
if (dropped > 0) console.log(`\nDropped ${dropped} concepts with no valid anchors`)

fs.writeFileSync(outputPath, JSON.stringify(final, null, 2))
console.log(`\nWrote ${final.length} concepts to ${path.relative(projectRoot, outputPath)}`)
console.log(`Coverage:`)
for (let L = 0; L < levelCount; L++) {
  const lstr = String(L)
  const placed = final.filter(c => c.anchors[lstr]).length
  console.log(`  L${L}: ${placed}/${final.length} concepts anchored`)
}
