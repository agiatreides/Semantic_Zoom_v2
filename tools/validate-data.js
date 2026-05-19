#!/usr/bin/env node
/**
 * Validate semantic-zoom tree/concepts pairs without calling any model.
 *
 * Default mode treats malformed JSON, out-of-range anchors, and invalid
 * phrase links as errors. Missing visible anchors and absent child links are
 * warnings because the renderer can still operate, but they are exactly the
 * data-quality issues that tend to show up as zoom drift.
 *
 * Usage:
 *   node tools/validate-data.js
 *   node tools/validate-data.js data/the-voting-problem-auto.json
 *   node tools/validate-data.js --strict
 */

import fs from 'fs'
import path from 'path'

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const args = process.argv.slice(2)
const strict = args.includes('--strict')
const explicit = args.filter(a => !a.startsWith('--'))

function rel(p) {
  return path.relative(projectRoot, p)
}

function failBucket() {
  return { errors: [], warnings: [] }
}

function add(bucket, kind, msg) {
  bucket[kind].push(msg)
}

function readJson(file, bucket) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    add(bucket, 'errors', `${rel(file)}: ${e.message}`)
    return null
  }
}

function defaultTrees() {
  const dataDir = path.join(projectRoot, 'data')
  return fs.readdirSync(dataDir)
    .filter(f => f.endsWith('-auto.json') && !f.endsWith('-concepts.json'))
    .map(f => path.join(dataDir, f))
    .sort()
}

function validateTreeShape(tree, treePath, bucket) {
  if (!tree || typeof tree !== 'object') return
  const levelCount = tree.levelCount ?? Object.keys(tree.levels || {}).length
  if (!tree.levels || typeof tree.levels !== 'object') {
    add(bucket, 'errors', `${rel(treePath)}: missing levels object`)
    return
  }
  for (let L = 0; L < levelCount; L++) {
    const nodes = tree.levels[String(L)]?.nodes
    if (!Array.isArray(nodes)) {
      add(bucket, 'errors', `${rel(treePath)}: level ${L} missing nodes[]`)
      continue
    }
    const ids = new Set()
    for (const node of nodes) {
      if (!node || typeof node.id !== 'string') add(bucket, 'errors', `${rel(treePath)}: level ${L} has node without string id`)
      else if (ids.has(node.id)) add(bucket, 'errors', `${rel(treePath)}: duplicate node id ${node.id} at L${L}`)
      else ids.add(node.id)
      if (typeof node.text !== 'string') add(bucket, 'errors', `${rel(treePath)}: node ${node?.id || '(unknown)'} missing text`)
      if (Array.isArray(node.phrases)) {
        node.phrases.forEach((p, i) => {
          if (p.charStart < 0 || p.charEnd > node.text.length || p.charEnd <= p.charStart) {
            add(bucket, 'errors', `${rel(treePath)}: phrase ${node.id}[${i}] has invalid range ${p.charStart}-${p.charEnd}`)
          }
        })
      }
    }
  }

  const nonLeaf = []
  for (let L = 0; L < levelCount - 1; L++) {
    const nodes = tree.levels[String(L)]?.nodes || []
    nonLeaf.push(...nodes)
  }
  if (nonLeaf.length > 0 && nonLeaf.every(n => !Array.isArray(n.children) || n.children.length === 0)) {
    add(bucket, 'warnings', `${rel(treePath)}: all non-leaf child links are empty; parent-walk anchoring cannot use this tree`)
  }
}

function validatePhraseLinks(tree, treePath, bucket) {
  const levelCount = tree.levelCount ?? Object.keys(tree.levels || {}).length
  const phraseCounts = []
  for (let L = 0; L < levelCount; L++) {
    phraseCounts[L] = (tree.levels[String(L)]?.nodes || [])
      .reduce((sum, n) => sum + (Array.isArray(n.phrases) ? n.phrases.length : 0), 0)
  }

  for (let L = 0; L < levelCount; L++) {
    let flatIdx = 0
    for (const node of tree.levels[String(L)]?.nodes || []) {
      for (const phrase of node.phrases || []) {
        if (L < levelCount - 1 && phrase.matchIn !== -1 && (phrase.matchIn < 0 || phrase.matchIn >= phraseCounts[L + 1])) {
          add(bucket, 'errors', `${rel(treePath)}: L${L} phrase ${flatIdx} matchIn=${phrase.matchIn} outside L${L + 1} count ${phraseCounts[L + 1]}`)
        }
        if (L > 0 && phrase.matchOut !== -1 && (phrase.matchOut < 0 || phrase.matchOut >= phraseCounts[L - 1])) {
          add(bucket, 'errors', `${rel(treePath)}: L${L} phrase ${flatIdx} matchOut=${phrase.matchOut} outside L${L - 1} count ${phraseCounts[L - 1]}`)
        }
        flatIdx++
      }
    }
  }
}

function validateConcepts(tree, treePath, bucket) {
  const conceptsPath = treePath.replace(/\.json$/, '-concepts.json')
  if (!fs.existsSync(conceptsPath)) {
    add(bucket, 'warnings', `${rel(treePath)}: missing ${rel(conceptsPath)}`)
    return
  }
  const raw = readJson(conceptsPath, bucket)
  const concepts = Array.isArray(raw) ? raw : raw?.concepts
  if (!Array.isArray(concepts)) {
    add(bucket, 'errors', `${rel(conceptsPath)}: expected concepts[]`)
    return
  }

  const levelCount = tree.levelCount ?? Object.keys(tree.levels || {}).length
  const nodeByLevel = {}
  for (let L = 0; L < levelCount; L++) {
    nodeByLevel[L] = Object.fromEntries((tree.levels[String(L)]?.nodes || []).map(n => [n.id, n]))
  }

  for (const concept of concepts) {
    if (!concept?.id) {
      add(bucket, 'errors', `${rel(conceptsPath)}: concept missing id`)
      continue
    }
    const mvl = concept.min_visible_level ?? levelCount - 1
    const anchors = concept.anchors || {}
    for (let L = 0; L < levelCount; L++) {
      const anchor = anchors[String(L)]
      if (L >= mvl && !anchor) {
        add(bucket, 'warnings', `${rel(conceptsPath)}: ${concept.id} visible at L${L} but has no anchor`)
        continue
      }
      if (!anchor) continue
      const node = nodeByLevel[L][anchor.nodeId]
      if (!node) {
        add(bucket, 'errors', `${rel(conceptsPath)}: ${concept.id} L${L} references missing node ${anchor.nodeId}`)
        continue
      }
      if (anchor.charStart < 0 || anchor.charEnd > node.text.length || anchor.charEnd <= anchor.charStart) {
        add(bucket, 'errors', `${rel(conceptsPath)}: ${concept.id} L${L} invalid range ${anchor.charStart}-${anchor.charEnd}`)
      }
    }
  }
}

const treePaths = (explicit.length ? explicit.map(p => path.resolve(projectRoot, p)) : defaultTrees())
const totals = failBucket()

for (const treePath of treePaths) {
  const bucket = failBucket()
  const tree = readJson(treePath, bucket)
  validateTreeShape(tree, treePath, bucket)
  if (tree) {
    validatePhraseLinks(tree, treePath, bucket)
    validateConcepts(tree, treePath, bucket)
  }

  console.log(`\n${rel(treePath)}`)
  for (const warning of bucket.warnings) console.log(`  WARN  ${warning}`)
  for (const error of bucket.errors) console.log(`  ERROR ${error}`)
  if (bucket.warnings.length === 0 && bucket.errors.length === 0) console.log('  OK')
  totals.warnings.push(...bucket.warnings)
  totals.errors.push(...bucket.errors)
}

console.log(`\nValidation complete: ${totals.errors.length} error(s), ${totals.warnings.length} warning(s).`)
if (totals.errors.length > 0 || (strict && totals.warnings.length > 0)) process.exit(1)
