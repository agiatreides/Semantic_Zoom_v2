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
import { extractiveSummarize, targetWordCount } from './lib/summarize.js'
import { validateTree } from './lib/schema.js'

// Parse CLI arguments
const args = process.argv.slice(2)
let inputFile = null
let outputFile = null
let maxTokenSize = 200

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output' && args[i + 1]) {
    outputFile = args[++i]
  } else if (args[i] === '--max-tokens' && args[i + 1]) {
    maxTokenSize = parseInt(args[++i])
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
    const targetWords = targetWordCount(memberWordCount, levelIdx, 0) // totalLevels unknown yet

    const summaryText = extractiveSummarize(members, targetWords)

    // Compute centroid embedding for the parent
    const dim = members[0].embedding.length
    const centroid = new Array(dim).fill(0)
    for (const m of members) {
      for (let i = 0; i < dim; i++) centroid[i] += m.embedding[i]
    }
    for (let i = 0; i < dim; i++) centroid[i] /= members.length

    parentNodes.push({
      text: summaryText,
      embedding: centroid,
      childIndices: cluster.members // indices into currentNodes
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
