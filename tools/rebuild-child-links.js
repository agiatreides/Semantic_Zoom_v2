#!/usr/bin/env node
/**
 * Repair parent/child links for existing independently generated corpora.
 *
 * This is intentionally model-free. It assumes each adjacent level tells the
 * same source-ordered document at a different compression, then aligns nodes
 * by normalized cumulative word position.
 *
 * Usage:
 *   node tools/rebuild-child-links.js data/foo-auto.json
 *   node tools/rebuild-child-links.js data/foo-auto.json --phrase-maps
 */

import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { rebuildLinearChildLinks } from './lib/child-links.js'

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const args = process.argv.slice(2)
const rebuildPhrases = args.includes('--phrase-maps')
const files = args.filter(a => !a.startsWith('--'))

if (files.length === 0 || args.includes('--help')) {
  console.error('Usage: node tools/rebuild-child-links.js <tree.json> [...] [--phrase-maps]')
  process.exit(1)
}

for (const file of files) {
  const treePath = path.resolve(projectRoot, file)
  const tree = JSON.parse(fs.readFileSync(treePath, 'utf8'))
  const result = rebuildLinearChildLinks(tree)

  fs.writeFileSync(treePath, JSON.stringify(tree, null, 2))
  console.log(`${path.relative(projectRoot, treePath)}: rebuilt ${result.totalLinks} child links`)

  if (rebuildPhrases) {
    const relTree = path.relative(projectRoot, treePath)
    const phraseResult = spawnSync('node', ['tools/add-phrase-maps.js', relTree], {
      cwd: projectRoot,
      stdio: 'inherit',
    })
    if (phraseResult.status !== 0) process.exit(phraseResult.status || 1)
  }
}
