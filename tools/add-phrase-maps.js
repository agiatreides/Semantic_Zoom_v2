#!/usr/bin/env node
/**
 * Add pre-computed phrase maps to an existing tree JSON.
 * Works on both hand-crafted and auto-generated trees.
 *
 * Usage:
 *   node tools/add-phrase-maps.js <tree.json>
 */

import fs from 'fs'
import path from 'path'
import { pipeline } from '@huggingface/transformers'

const args = process.argv.slice(2)
if (!args[0]) {
  console.error('Usage: node tools/add-phrase-maps.js <tree.json>')
  process.exit(1)
}

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const inputPath = path.resolve(projectRoot, args[0])

function phraseWindows(text, windowSize = 8, stride = 4) {
  const words = []
  const regex = /\S+/g
  let m
  while ((m = regex.exec(text)) !== null) {
    words.push({ start: m.index, end: m.index + m[0].length })
  }
  const phrases = []
  for (let i = 0; i < words.length; i += stride) {
    const win = words.slice(i, i + windowSize)
    if (win.length === 0) break
    phrases.push({
      text: text.substring(win[0].start, win[win.length - 1].end),
      charStart: win[0].start,
      charEnd: win[win.length - 1].end
    })
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

console.log(`\nAdding phrase maps to: ${inputPath}\n`)

const tree = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
const totalLevels = tree.levelCount || Object.keys(tree.levels).length

console.log('Loading embedding model...')
const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' })

async function embedText(text) {
  const result = await embedder(text, { pooling: 'mean', normalize: true })
  return Array.from(result.data)
}

// Phase A: Generate phrases and embed
const phrasesByLevel = []

for (let L = 0; L < totalLevels; L++) {
  const flatPhrases = []
  for (const node of tree.levels[String(L)].nodes) {
    const windows = phraseWindows(node.text)
    for (const w of windows) {
      const embedding = await embedText(w.text)
      flatPhrases.push({ ...w, embedding, nodeId: node.id })
    }
  }
  phrasesByLevel.push(flatPhrases)
  console.log(`  Level ${L}: ${flatPhrases.length} phrases`)
}

// Phase B: Compute cross-level matches
console.log('\nComputing cross-level matches...')
for (let L = 0; L < totalLevels; L++) {
  for (const phrase of phrasesByLevel[L]) {
    if (L < totalLevels - 1) {
      let bestIdx = -1, bestSim = -Infinity
      for (let i = 0; i < phrasesByLevel[L + 1].length; i++) {
        const sim = cosineSim(phrase.embedding, phrasesByLevel[L + 1][i].embedding)
        if (sim > bestSim) { bestSim = sim; bestIdx = i }
      }
      phrase.matchIn = bestIdx
    } else {
      phrase.matchIn = -1
    }

    if (L > 0) {
      let bestIdx = -1, bestSim = -Infinity
      for (let i = 0; i < phrasesByLevel[L - 1].length; i++) {
        const sim = cosineSim(phrase.embedding, phrasesByLevel[L - 1][i].embedding)
        if (sim > bestSim) { bestSim = sim; bestIdx = i }
      }
      phrase.matchOut = bestIdx
    } else {
      phrase.matchOut = -1
    }
  }
  console.log(`  Level ${L}: matched`)
}

// Phase C: Attach to tree nodes (without embeddings)
for (let L = 0; L < totalLevels; L++) {
  let flatIdx = 0
  for (const node of tree.levels[String(L)].nodes) {
    node.phrases = []
    while (flatIdx < phrasesByLevel[L].length && phrasesByLevel[L][flatIdx].nodeId === node.id) {
      const p = phrasesByLevel[L][flatIdx]
      node.phrases.push({
        text: p.text,
        charStart: p.charStart,
        charEnd: p.charEnd,
        matchIn: p.matchIn,
        matchOut: p.matchOut
      })
      flatIdx++
    }
  }
}

const totalPhrases = phrasesByLevel.reduce((s, l) => s + l.length, 0)
console.log(`\n${totalPhrases} total phrases mapped.`)

fs.writeFileSync(inputPath, JSON.stringify(tree, null, 2))
console.log(`Written: ${inputPath}`)
