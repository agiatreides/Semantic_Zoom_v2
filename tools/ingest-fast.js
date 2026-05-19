#!/usr/bin/env node
/**
 * Fast corpus ingest path.
 *
 * This avoids the old four-pass flow:
 *   generate-tree -> extract-concepts -> generate-tree --concepts -> extract-concepts
 *
 * Instead:
 *   1. Create a cheap skeleton tree whose deepest level is the source text.
 *   2. Run extract-concepts only for genre + Lmax concept identification.
 *   3. Run rebuild-levels once; it generates all zoom levels in parallel and
 *      refreshes anchors.
 *
 * Usage:
 *   node tools/ingest-fast.js data/my-document.txt
 *   node tools/ingest-fast.js data/my-document.txt --levels 6 --concept-count 18
 *   MODEL=haiku node tools/ingest-fast.js data/my-document.txt
 */

import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const args = process.argv.slice(2)

let inputFile = null
let outputFile = null
let levelCount = 6
let maxLeafWords = 320
let conceptCount = null
let seedOnly = false

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--output' && args[i + 1]) outputFile = args[++i]
  else if (arg === '--levels' && args[i + 1]) levelCount = parseInt(args[++i], 10)
  else if (arg === '--max-leaf-words' && args[i + 1]) maxLeafWords = parseInt(args[++i], 10)
  else if (arg === '--concept-count' && args[i + 1]) conceptCount = parseInt(args[++i], 10)
  else if (arg === '--seed-only') seedOnly = true
  else if (!arg.startsWith('--')) inputFile = arg
}

if (!inputFile || args.includes('--help') || args.includes('-h')) {
  console.error(`Usage: node tools/ingest-fast.js <input.txt> [--output out.json] [--levels N] [--max-leaf-words N] [--concept-count N] [--seed-only]`)
  process.exit(1)
}
if (!Number.isFinite(levelCount) || levelCount < 2) {
  console.error('--levels must be an integer >= 2')
  process.exit(1)
}
if (!Number.isFinite(maxLeafWords) || maxLeafWords < 80) {
  console.error('--max-leaf-words must be an integer >= 80')
  process.exit(1)
}

const inputPath = path.resolve(projectRoot, inputFile)
const baseName = path.basename(inputFile, path.extname(inputFile))
if (!outputFile) outputFile = path.join('data', `${baseName}-auto.json`)
const outputPath = path.resolve(projectRoot, outputFile)
const conceptsPath = outputPath.replace(/\.json$/, '-concepts.json')

function words(text) {
  return text.split(/\s+/).filter(Boolean)
}

function splitLongParagraph(paragraph, maxWords) {
  const sentences = paragraph.match(/[^.!?\n]+[.!?]?/g)?.map(s => s.trim()).filter(Boolean) || [paragraph]
  const chunks = []
  let current = []
  let count = 0
  for (const sentence of sentences) {
    const n = words(sentence).length
    if (current.length > 0 && count + n > maxWords) {
      chunks.push(current.join(' '))
      current = []
      count = 0
    }
    current.push(sentence)
    count += n
  }
  if (current.length > 0) chunks.push(current.join(' '))
  return chunks
}

function sourceNodes(text, Lmax, maxWords) {
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  const pieces = []
  for (const paragraph of paragraphs.length > 0 ? paragraphs : [text.trim()]) {
    if (words(paragraph).length > maxWords) pieces.push(...splitLongParagraph(paragraph, maxWords))
    else pieces.push(paragraph)
  }

  const grouped = []
  let current = []
  let count = 0
  for (const piece of pieces) {
    const n = words(piece).length
    if (current.length > 0 && count + n > maxWords) {
      grouped.push(current.join('\n\n'))
      current = []
      count = 0
    }
    current.push(piece)
    count += n
  }
  if (current.length > 0) grouped.push(current.join('\n\n'))

  return grouped.map((text, i) => ({ id: `${Lmax}-${i}`, text, children: [] }))
}

function titleFromFile(file) {
  const title = path.basename(file, path.extname(file)).replace(/[-_]+/g, ' ')
  return title.charAt(0).toUpperCase() + title.slice(1)
}

function writeSeedTree() {
  const rawText = fs.readFileSync(inputPath, 'utf8').trim()
  const totalWords = words(rawText).length
  const Lmax = levelCount - 1
  const levels = {}
  for (let L = 0; L < Lmax; L++) levels[String(L)] = { nodes: [] }
  levels[String(Lmax)] = { nodes: sourceNodes(rawText, Lmax, maxLeafWords) }

  const tree = {
    title: titleFromFile(inputFile),
    levelCount,
    levels,
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(tree, null, 2))
  console.log(`Seed tree: ${path.relative(projectRoot, outputPath)}`)
  console.log(`  ${totalWords} source words -> ${tree.levels[String(Lmax)].nodes.length} L${Lmax} source nodes`)
}

function runNode(script, scriptArgs, label) {
  console.log(`\n${label}`)
  console.log(`  node ${[script, ...scriptArgs].join(' ')}`)
  const result = spawnSync('node', [script, ...scriptArgs], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0) process.exit(result.status || 1)
}

writeSeedTree()
if (seedOnly) process.exit(0)

const relTree = path.relative(projectRoot, outputPath)
const relConcepts = path.relative(projectRoot, conceptsPath)
const extractArgs = [relTree, '--identify-only']
if (conceptCount != null) extractArgs.push('--concept-count', String(conceptCount))

runNode('tools/extract-concepts.js', extractArgs, 'Identifying concepts at source level...')
runNode('tools/rebuild-levels.js', [relTree, relConcepts], 'Generating zoom levels and anchors...')
runNode('tools/validate-data.js', [relTree], 'Validating generated corpus...')

console.log(`\nDone.`)
console.log(`Tree:     ${relTree}`)
console.log(`Concepts: ${relConcepts}`)
