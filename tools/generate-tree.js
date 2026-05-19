#!/usr/bin/env node
/**
 * Semantic Zoom Tree Generator
 *
 * Takes a plain text file and produces a hierarchical JSON tree
 * suitable for the semantic zoom renderer.
 *
 * Usage:
 *   node tools/generate-tree.js <input.txt> [--output <output.json>] [--max-tokens N]
 *
 * Algorithm (bottom-up RAPTOR):
 *   1. Chunk text into semantic segments (semantic-chunking, ONNX embeddings)
 *   2. These segments become leaf nodes (bottom level)
 *   3. Cluster leaf nodes via k-means
 *   4. Summarize each cluster (extractive) → parent level
 *   5. Re-embed summaries, cluster, summarize → repeat up the tree
 *   6. Stop when single root node remains
 *   7. Reverse levels (root=0, leaves=N) and assign IDs
 */

import fs from 'fs'
import path from 'path'
import { pipeline } from '@huggingface/transformers'
import { clusterNodes, targetClusterCount } from './lib/cluster.js'
import { extractiveSummarize, claudeSummarize, targetWordCount } from './lib/summarize.js'
import { validateTree } from './lib/schema.js'

// ------ Importance scoring ------

import { execSync } from 'child_process'

function claudeScoreImportance(fullText, phrases) {
  const phraseList = phrases.map((p, i) => `[${i}] "${p.text}"`).join('\n')

  const prompt = `You are scoring the narrative importance of text segments for a semantic zoom interface.

For each numbered segment below, rate its importance to the overall narrative on a scale of 1-10:
- 10: Core plot turning point, essential to understanding the story
- 7-9: Important scene, character development, or key dialogue
- 4-6: Supporting detail that enriches the narrative
- 1-3: Atmospheric detail, minor action, could be cut without losing the plot

FULL TEXT:
---
${fullText}
---

SEGMENTS TO SCORE:
${phraseList}

Return ONLY a JSON array of scores in order, e.g. [8, 3, 7, 5, ...].
No commentary.`

  try {
    // Same flags as rebuild-levels.js / extract-concepts.js — sonnet default,
    // --effort medium keeps importance-scoring fast (it's a lightweight rank).
    const _model = process.env.MODEL || 'sonnet'
    const _effort = process.env.EFFORT || 'medium'
    const result = execSync(`claude -p --output-format text --exclude-dynamic-system-prompt-sections --effort '${_effort}' --model '${_model}'`,
      { input: prompt, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 120000 }).trim()
    return JSON.parse(result)
  } catch (e) {
    console.error('  Importance scoring failed:', e.message?.substring(0, 100))
    return null
  }
}

function findNearestStrongNeighbor(phrases, idx, scoreField, threshold) {
  const nodeId = phrases[idx].nodeId
  // Scan outward from idx, preferring closer neighbors
  for (let dist = 1; dist < phrases.length; dist++) {
    for (const j of [idx - dist, idx + dist]) {
      if (j < 0 || j >= phrases.length) continue
      if (phrases[j].nodeId !== nodeId) continue
      if ((phrases[j][scoreField] || 0) >= threshold) return phrases[j]
    }
  }
  return null
}

// ------ Phrase map utilities ------

function phraseWindows(text, windowSize = 6, stride = 3) {
  const words = []
  const regex = /[^\s\u2014\u2013]+/g  // split at whitespace and em/en-dashes
  let m
  while ((m = regex.exec(text)) !== null) {
    words.push({ start: m.index, end: m.index + m[0].length })
  }
  if (words.length === 0) return []

  // Find clause boundaries: break after words ending in punctuation
  // or when gap between words contains em-dash/newline
  const breakAfter = new Set()
  for (let i = 0; i < words.length - 1; i++) {
    const wordText = text.substring(words[i].start, words[i].end)
    // Strip trailing quotes/parens to find punctuation underneath
    const stripped = wordText.replace(/["'\u201d\u2019\u201c\u2018)]+$/, '')
    if (/[,;:.!?]$/.test(stripped)) {
      breakAfter.add(i)
      continue
    }
    const gap = text.substring(words[i].end, words[i + 1].start)
    if (/[\u2014\u2013\n]/.test(gap)) {
      breakAfter.add(i)
    }
  }

  // Build clauses (groups of words between break points)
  const clauses = []
  let clauseStart = 0
  for (let i = 0; i < words.length; i++) {
    if (breakAfter.has(i) || i === words.length - 1) {
      if (i >= clauseStart) clauses.push({ from: clauseStart, to: i })
      clauseStart = i + 1
    }
  }

  // Generate windows within each clause (never crossing clause boundaries)
  const phrases = []
  for (const clause of clauses) {
    for (let i = clause.from; i <= clause.to; i += stride) {
      const end = Math.min(i + windowSize - 1, clause.to)
      const win = words.slice(i, end + 1)
      if (win.length === 0) break
      phrases.push({
        text: text.substring(win[0].start, win[win.length - 1].end),
        charStart: win[0].start,
        charEnd: win[win.length - 1].end
      })
      if (end >= clause.to) break
    }
  }
  return phrases
}

function cosineSim(a, b) {
  let dot = 0, magA = 0, magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; magA += a[i] * a[i]; magB += b[i] * b[i]
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) + 1e-10)
}

// Parse CLI arguments
const args = process.argv.slice(2)
let inputFile = null
let outputFile = null
let maxTokenSize = 200
let useExtractive = false
let conceptsFile = null  // --concepts <path>: when given, the upper levels are
                         // re-reduced after the bottom-up build using only the
                         // events whose min_visible_level <= L. Drops the "12% ROI"
                         // problem at L0/L1 and gives the renderer a real signal.

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output' && args[i + 1]) {
    outputFile = args[++i]
  } else if (args[i] === '--max-tokens' && args[i + 1]) {
    maxTokenSize = parseInt(args[++i])
  } else if (args[i] === '--extractive') {
    useExtractive = true
  } else if (args[i] === '--concepts' && args[i + 1]) {
    conceptsFile = args[++i]
  } else if (!args[i].startsWith('--')) {
    inputFile = args[i]
  }
}

if (!inputFile) {
  console.error('Usage: node tools/generate-tree.js <input.txt> [--output <output.json>] [--max-tokens N]')
  process.exit(1)
}

// Resolve paths relative to project root
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const inputPath = path.resolve(projectRoot, inputFile)
const title = path.basename(inputFile, path.extname(inputFile)).replace(/[-_]/g, ' ')

if (!outputFile) {
  const baseName = path.basename(inputFile, path.extname(inputFile))
  outputFile = path.join('data', `${baseName}-auto.json`)
}
const outputPath = path.resolve(projectRoot, outputFile)

console.log(`\nSemantic Zoom Tree Generator`)
console.log(`Input:  ${inputPath}`)
console.log(`Output: ${outputPath}`)
console.log(`Max token size per chunk: ${maxTokenSize}\n`)

// ------ Step 1: Read text ------

const rawText = fs.readFileSync(inputPath, 'utf8').trim()
const totalWords = rawText.split(/\s+/).length
console.log(`Read ${totalWords} words\n`)

// ------ Step 2: Pre-chunk into paragraph groups, then embed ------

// Narrative text has lots of short dialogue lines. Group them into
// paragraph-level blocks (~50-150 words each) before embedding.

console.log('Step 2a: Grouping text into paragraph blocks...')

function groupIntoParagraphs(text, targetWords = 80) {
  // Split on blank lines first
  const rawParagraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)

  // If blank-line splitting produced good results, use those
  if (rawParagraphs.length > 5 && rawParagraphs.length < 100) {
    return rawParagraphs
  }

  // Otherwise split on newlines and group short lines together
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const groups = []
  let current = []
  let currentWords = 0

  for (const line of lines) {
    const lineWords = line.split(/\s+/).length
    current.push(line)
    currentWords += lineWords

    if (currentWords >= targetWords) {
      groups.push(current.join('\n'))
      current = []
      currentWords = 0
    }
  }
  if (current.length > 0) {
    groups.push(current.join('\n'))
  }

  return groups
}

const paragraphs = groupIntoParagraphs(rawText)
console.log(`  → ${paragraphs.length} paragraph blocks\n`)

console.log('Step 2b: Embedding paragraphs with ONNX model...')

const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' })

async function embedText(text) {
  const result = await embedder(text, { pooling: 'mean', normalize: true })
  return Array.from(result.data)
}

// Embed all paragraphs
const leafNodes = []
for (let i = 0; i < paragraphs.length; i++) {
  const embedding = await embedText(paragraphs[i])
  leafNodes.push({ text: paragraphs[i], embedding, originalIndex: i })
  if ((i + 1) % 10 === 0) process.stdout.write(`  ${i + 1}/${paragraphs.length}\r`)
}

console.log(`  → ${leafNodes.length} embedded paragraphs\n`)

// ------ Step 2c: Score importance of leaf text ------

console.log('Step 2c: Scoring importance of leaf phrases...')

// Generate phrase windows for leaves and score them
const leafPhraseWindows = []
for (const node of leafNodes) {
  for (const w of phraseWindows(node.text)) {
    leafPhraseWindows.push({ ...w, nodeText: node.text })
  }
}

let leafImportanceScores = null
if (!useExtractive) {
  leafImportanceScores = claudeScoreImportance(rawText, leafPhraseWindows)
  if (leafImportanceScores && leafImportanceScores.length === leafPhraseWindows.length) {
    for (let i = 0; i < leafPhraseWindows.length; i++) {
      leafPhraseWindows[i].importance = leafImportanceScores[i]
    }
    const avg = leafImportanceScores.reduce((a, b) => a + b, 0) / leafImportanceScores.length
    console.log(`  → ${leafPhraseWindows.length} phrases scored (avg importance: ${avg.toFixed(1)})`)
  } else {
    console.log('  → Importance scoring failed or length mismatch, proceeding without')
    leafImportanceScores = null
  }
} else {
  console.log('  → Skipped (extractive mode)')
}

// Attach importance to leaf nodes for use during compression
if (leafImportanceScores) {
  let phraseIdx = 0
  for (const node of leafNodes) {
    node.importantConcepts = []
    const nodeWindows = phraseWindows(node.text)
    for (const w of nodeWindows) {
      const imp = leafPhraseWindows[phraseIdx]?.importance || 5
      if (imp >= 6) {
        node.importantConcepts.push({ text: w.text, importance: imp })
      }
      phraseIdx++
    }
    // Sort by importance desc
    node.importantConcepts.sort((a, b) => b.importance - a.importance)
  }
}

console.log()

// ------ Step 3-5: Build tree bottom-up ------

console.log('Step 3-5: Building tree (cluster → summarize → repeat)...\n')

// Bottom-up levels: level 0 = leaves, level N = root
// We'll reverse this at the end for the renderer
const bottomUpLevels = [leafNodes]

let currentNodes = leafNodes
let levelIdx = 0

while (currentNodes.length > 1) {
  const k = targetClusterCount(currentNodes.length)
  console.log(`  Level ${levelIdx} → ${currentNodes.length} nodes`)

  if (k >= currentNodes.length) {
    // Can't reduce further, force to 1
    break
  }

  // Cluster
  const clusters = clusterNodes(currentNodes, k)

  // Summarize each cluster
  const parentNodes = []

  for (const cluster of clusters) {
    const members = cluster.members.map(i => currentNodes[i])
    const memberWordCount = members.reduce((s, m) => s + m.text.split(/\s+/).length, 0)
    const targetWords = targetWordCount(memberWordCount, levelIdx, 0, totalWords)

    // Gather importance data from members
    const clusterConcepts = members
      .flatMap(m => m.importantConcepts || [])
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 20) // top 20 for prompt size

    let summaryText
    if (useExtractive) {
      summaryText = extractiveSummarize(members, targetWords)
    } else {
      console.log(`    Compressing cluster (${members.length} members → ~${targetWords} words, ${clusterConcepts.length} priority concepts)...`)
      summaryText = claudeSummarize(members, targetWords, clusterConcepts)
      if (!summaryText) {
        console.log('    Falling back to extractive')
        summaryText = extractiveSummarize(members, targetWords)
      }
    }

    // Embed the actual summary text (not centroid) for accurate phrase matching
    const summaryEmbedding = await embedText(summaryText)

    parentNodes.push({
      text: summaryText,
      embedding: summaryEmbedding,
      childIndices: cluster.members,
      importantConcepts: clusterConcepts // propagate up for next compression level
    })
  }

  bottomUpLevels.push(parentNodes)
  currentNodes = parentNodes
  levelIdx++
}

console.log(`  Level ${levelIdx} → ${currentNodes.length} nodes (root)\n`)

// ------ Step 6: Reverse and assign IDs ------

console.log('Step 6: Reversing tree and assigning IDs...')

// Reverse so root = level 0, leaves = level N
const topDownLevels = [...bottomUpLevels].reverse()
const totalLevels = topDownLevels.length

// Assign IDs
for (let L = 0; L < totalLevels; L++) {
  topDownLevels[L].forEach((node, i) => {
    node.id = `${L}-${i}`
  })
}

// Wire parent-child links (going top-down)
// bottomUpLevels[i].childIndices → indices into bottomUpLevels[i-1]
// After reversal: topDownLevels[L] corresponds to bottomUpLevels[totalLevels - 1 - L]
for (let L = 0; L < totalLevels - 1; L++) {
  const parentBU = totalLevels - 1 - L // index in bottomUpLevels
  const childBU = parentBU - 1

  for (const parentNode of topDownLevels[L]) {
    // Find this node in bottomUpLevels[parentBU]
    const buIdx = bottomUpLevels[parentBU].indexOf(parentNode)
    if (buIdx !== -1 && parentNode.childIndices) {
      parentNode.children = parentNode.childIndices.map(ci => {
        return bottomUpLevels[childBU][ci]?.id
      }).filter(Boolean)
    } else {
      parentNode.children = []
    }
  }
}

// Leaf nodes have no children
for (const node of topDownLevels[totalLevels - 1]) {
  node.children = []
}

// ------ Step 6.5: Re-reduce upper levels with concept guidance ------
//
// If --concepts <path> was given, walk the tree top-down (excluding the leaves)
// and re-reduce each non-leaf node using ONLY the events whose
// min_visible_level <= L. This forces L0/L1 to drop atmospheric detail
// ("12% lower ROI") and contain only the load-bearing plot beats.
//
// We re-embed each new node text after reduction so the phrase-map step
// (next) operates on the actual rendered text.

if (conceptsFile) {
  const conceptsPath = path.resolve(projectRoot, conceptsFile)
  console.log(`\nStep 6.5: Re-reducing upper levels using ${path.relative(projectRoot, conceptsPath)}`)
  let allConcepts = []
  let conceptMeta = {}
  try {
    const conceptsRaw = JSON.parse(fs.readFileSync(conceptsPath, 'utf8'))
    allConcepts = Array.isArray(conceptsRaw) ? conceptsRaw : (conceptsRaw.concepts || [])
    conceptMeta = Array.isArray(conceptsRaw) ? {} : conceptsRaw
  } catch (e) {
    console.error(`  Failed to read concepts file: ${e.message}`)
    allConcepts = null
  }

  if (Array.isArray(allConcepts)) {
    const characters = conceptMeta.characters || {}
    const thematicThrust = typeof conceptMeta.thematic_thrust === 'string' ? conceptMeta.thematic_thrust : ''

    // Build childId → topDownLevels[L+1] node lookup once
    const nodeByIdAtLevel = {}  // `${L}:${id}` → node
    for (let L = 0; L < totalLevels; L++) {
      for (const n of topDownLevels[L]) nodeByIdAtLevel[`${L}:${n.id}`] = n
    }

    // Re-reduce non-leaf levels (skip L_max, which IS the source text)
    for (let L = 0; L < totalLevels - 1; L++) {
      const essentials = allConcepts.filter(c => (c.min_visible_level ?? totalLevels) <= L)
      console.log(`  L${L}: ${essentials.length} essentials (min_visible_level<=${L})`)
      if (essentials.length === 0) {
        // No essentials at this level — leave existing reduction as-is.
        // (Could also force a re-reduce here saying "produce 1-2 sentences";
        //  TBD if user prefers that.)
        continue
      }

      for (const node of topDownLevels[L]) {
        // Members at the next level (the children whose text gets reduced)
        const childMembers = (node.children || [])
          .map(cid => nodeByIdAtLevel[`${L + 1}:${cid}`])
          .filter(Boolean)
          .map(cn => ({ text: cn.text, embedding: cn.embedding }))
        if (childMembers.length === 0) continue
        const childWordCount = childMembers.reduce((s, m) => s + m.text.split(/\s+/).length, 0)
        const targetWords = targetWordCount(childWordCount, totalLevels - 1 - L, 0, totalWords)

        let newText
        if (useExtractive) {
          // Extractive doesn't take essentials; keep the tree's current text.
          continue
        } else {
          console.log(`    re-reducing ${node.id} (${childMembers.length} children → ~${targetWords} words, ${essentials.length} essentials)`)
          newText = claudeSummarize(childMembers, targetWords, [], { essentials, characters, thematicThrust })
          if (!newText) {
            console.log(`    re-reduce failed; keeping original text for ${node.id}`)
            continue
          }
        }

        node.text = newText
        node.embedding = await embedText(newText)
      }
    }
  }
  console.log()
}

// ------ Step 7: Build output JSON ------

const tree = {
  title: title.charAt(0).toUpperCase() + title.slice(1),
  levelCount: totalLevels,
  levels: {}
}

for (let L = 0; L < totalLevels; L++) {
  tree.levels[String(L)] = {
    nodes: topDownLevels[L].map(node => ({
      id: node.id,
      text: node.text,
      children: node.children || []
    }))
  }
}

// ------ Validate ------

console.log('Validating tree...')
const errors = validateTree(tree)
if (errors.length > 0) {
  console.error('\nValidation errors:')
  errors.forEach(e => console.error(`  - ${e}`))
  console.error('\nTree written anyway for debugging.')
} else {
  console.log('  → Valid!\n')
}

// ------ Step 7: Build phrase maps ------

console.log('Step 7: Building phrase maps...\n')

// Phase A: Generate phrases and embed them for every node at every level
const phrasesByLevel = []

for (let L = 0; L < totalLevels; L++) {
  const flatPhrases = []
  for (const node of tree.levels[String(L)].nodes) {
    const windows = phraseWindows(node.text)
    for (const w of windows) {
      const embedding = await embedText(w.text)
      flatPhrases.push({ ...w, embedding, nodeId: node.id })
    }
    if ((flatPhrases.length) % 20 === 0) process.stdout.write(`  ${flatPhrases.length} phrases embedded\r`)
  }
  phrasesByLevel.push(flatPhrases)
  console.log(`  Level ${L}: ${flatPhrases.length} phrases`)
}

// Phase B: Compute tree-constrained cross-level matches
console.log('\n  Computing tree-constrained cross-level matches...')

// Build parent/children lookup from tree
const childrenOf = {}  // nodeId → [childNodeIds]
const parentOf = {}    // nodeId → parentNodeId
for (let L = 0; L < totalLevels - 1; L++) {
  for (const node of tree.levels[String(L)].nodes) {
    childrenOf[node.id] = node.children || []
    for (const childId of node.children || []) {
      parentOf[childId] = node.id
    }
  }
}

for (let L = 0; L < totalLevels; L++) {
  for (const phrase of phrasesByLevel[L]) {
    // Zoom-in: only match against phrases in this node's CHILDREN
    if (L < totalLevels - 1) {
      const allowedChildren = new Set(childrenOf[phrase.nodeId] || [])
      let bestIdx = -1, bestSim = -Infinity
      for (let i = 0; i < phrasesByLevel[L + 1].length; i++) {
        if (!allowedChildren.has(phrasesByLevel[L + 1][i].nodeId)) continue
        const sim = cosineSim(phrase.embedding, phrasesByLevel[L + 1][i].embedding)
        if (sim > bestSim) { bestSim = sim; bestIdx = i }
      }
      phrase.matchIn = bestIdx
      phrase.matchInScore = bestSim
    } else {
      phrase.matchIn = -1
      phrase.matchInScore = 0
    }

    // Zoom-out: only match against phrases in this node's PARENT
    if (L > 0) {
      const parentId = parentOf[phrase.nodeId]
      let bestIdx = -1, bestSim = -Infinity
      for (let i = 0; i < phrasesByLevel[L - 1].length; i++) {
        if (phrasesByLevel[L - 1][i].nodeId !== parentId) continue
        const sim = cosineSim(phrase.embedding, phrasesByLevel[L - 1][i].embedding)
        if (sim > bestSim) { bestSim = sim; bestIdx = i }
      }
      phrase.matchOut = bestIdx
      phrase.matchOutScore = bestSim
    } else {
      phrase.matchOut = -1
      phrase.matchOutScore = 0
    }
  }
  console.log(`  Level ${L}: matched (tree-constrained)`)
}

// Phase B2: Propagate importance from leaves to root
console.log('\n  Propagating importance...')
if (leafImportanceScores) {
  // Assign importance to leaf-level phrases from scored windows
  const leafLevel = totalLevels - 1
  let leafPhraseIdx = 0
  for (const phrase of phrasesByLevel[leafLevel]) {
    // Match by charStart/text to find the right importance score
    const match = leafPhraseWindows.find(w => w.text === phrase.text && w.charStart === phrase.charStart)
    phrase.importance = match?.importance || 5
  }

  // Walk matchOut chains from leaves to root
  for (const leafPhrase of phrasesByLevel[leafLevel]) {
    let current = leafPhrase
    let L = leafLevel
    while (L > 0 && current.matchOut >= 0) {
      const target = phrasesByLevel[L - 1][current.matchOut]
      if (target) {
        target.importance = Math.max(target.importance || 0, leafPhrase.importance || 5)
      }
      current = target
      L--
    }
  }
  console.log('  Done.')
} else {
  // Default all phrases to importance 5
  for (const level of phrasesByLevel) {
    for (const p of level) p.importance = 5
  }
  console.log('  Skipped (no importance data), defaulting to 5.')
}

// Phase B3: Sandwich — replace weak matches with nearest strong neighbor's target
console.log('  Computing sandwich fallbacks...')
let sandwichCount = 0
for (let L = 0; L < totalLevels; L++) {
  const phrases = phrasesByLevel[L]
  if (phrases.length === 0) continue

  // Data-driven threshold: median score * 0.8
  const inScores = phrases.filter(p => p.matchInScore > 0).map(p => p.matchInScore).sort((a, b) => a - b)
  const outScores = phrases.filter(p => p.matchOutScore > 0).map(p => p.matchOutScore).sort((a, b) => a - b)
  const inThreshold = inScores.length > 0 ? inScores[Math.floor(inScores.length / 2)] * 0.8 : 0
  const outThreshold = outScores.length > 0 ? outScores[Math.floor(outScores.length / 2)] * 0.8 : 0

  for (let i = 0; i < phrases.length; i++) {
    const p = phrases[i]

    if (p.matchIn >= 0 && p.matchInScore < inThreshold) {
      const neighbor = findNearestStrongNeighbor(phrases, i, 'matchInScore', inThreshold)
      if (neighbor) { p.matchIn = neighbor.matchIn; p.sandwiched = true; sandwichCount++ }
    }

    if (p.matchOut >= 0 && p.matchOutScore < outThreshold) {
      const neighbor = findNearestStrongNeighbor(phrases, i, 'matchOutScore', outThreshold)
      if (neighbor) { p.matchOut = neighbor.matchOut; p.sandwiched = true; sandwichCount++ }
    }
  }
}
console.log(`  ${sandwichCount} weak matches sandwiched.\n`)

// Phase C: Attach to tree nodes (without embeddings)
for (let L = 0; L < totalLevels; L++) {
  let flatIdx = 0
  for (const node of tree.levels[String(L)].nodes) {
    node.phrases = []
    while (flatIdx < phrasesByLevel[L].length && phrasesByLevel[L][flatIdx].nodeId === node.id) {
      const p = phrasesByLevel[L][flatIdx]
      const entry = {
        text: p.text,
        charStart: p.charStart,
        charEnd: p.charEnd,
        matchIn: p.matchIn,
        matchOut: p.matchOut,
        importance: Math.round((p.importance || 5) * 10) / 10
      }
      if (p.sandwiched) entry.sandwiched = true
      node.phrases.push(entry)
      flatIdx++
    }
  }
}

const totalPhrases = phrasesByLevel.reduce((s, l) => s + l.length, 0)
console.log(`\n  ${totalPhrases} total phrases mapped.\n`)

// ------ Write ------

fs.writeFileSync(outputPath, JSON.stringify(tree, null, 2))

// Print summary
console.log('Tree Summary:')
for (let L = 0; L < totalLevels; L++) {
  const nodes = tree.levels[String(L)].nodes
  const words = nodes.reduce((s, n) => s + n.text.split(/\s+/).length, 0)
  console.log(`  Level ${L}: ${nodes.length} nodes, ~${words} words`)
}
console.log(`\nTotal levels: ${totalLevels}`)
console.log(`Output: ${outputPath}`)
