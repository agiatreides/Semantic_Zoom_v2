#!/usr/bin/env node
/**
 * Classify a document's primary mode so extract-concepts.js can route
 * to the right analytical schema.
 *
 * Per SIGNAL_HIERARCHY_REVIEW.md §15: one cheap Claude call per document,
 * returns one of ten genres. extract-concepts.js routes each genre to a
 * schema-specific signal prompt, with narrative-family genres sharing the
 * tuned short-story prompt where appropriate.
 *
 * Usage:
 *   node tools/classify-genre.js <tree.json>
 *   node tools/classify-genre.js <tree.json> --json
 *
 * Or import `classifyGenre(tree)` — returns a Promise<{genre, confidence, secondary, reasoning}>.
 */

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const GENRES = [
  'short_story',
  'novella',
  'novel_excerpt',
  'essay',
  'argument',
  'exposition',
  'procedural',
  'research_paper',
  'biography_memoir',
  'reference',
]

const CLASSIFY_PROMPT = (sample) => `You are classifying a document's primary mode so a downstream tool can apply the right analytical schema.

Pick ONE from this list as the PRIMARY genre:
  short_story       — compact narrative fiction (1k-10k words); has a protagonist, events, an arc
  novella           — longer narrative fiction (20k-50k words); multi-arc, still one work
  novel_excerpt     — a chapter or section of a longer novel; part of a larger narrative
  essay             — argumentative non-fiction; thesis + evidence + often personal frame
  argument          — explicitly argumentative (op-ed, polemic); thesis-driven, less narrative frame
  exposition        — explanatory; encyclopedia, explainer, textbook chapter; definition + elaboration
  procedural        — how-to, recipe, manual; prerequisites + steps + outcome
  research_paper    — scientific article, white paper; problem + method + result + significance
  biography_memoir  — life writing, autobiography, memoir; narrative but about a real life
  reference         — Wikipedia-style entry; neutral exposition of a defined topic

If the document blends modes, pick the PRIMARY one (what's the dominant shape?) and name the secondary as well.

Return STRICT JSON — no markdown fences, no commentary, no preamble:
{
  "genre": "<one of the ids above>",
  "confidence": <number between 0 and 1>,
  "secondary": <one of the ids above or null>,
  "reasoning": "<one short sentence>"
}

TEXT SAMPLE (beginning of the document):
"""
${sample}
"""

Return the JSON.`

function callClaude(prompt) {
  try {
    const result = execSync('claude -p --output-format text', {
      input: prompt,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      timeout: 120000,
    }).trim()
    return result
  } catch (e) {
    console.error('classify-genre: Claude call failed:', e.message?.substring(0, 150))
    return null
  }
}

function parseJson(raw) {
  if (!raw) return null
  // Strip markdown fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  try { return JSON.parse(cleaned) } catch {}
  // Try to locate the first { and last }
  const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}')
  if (s !== -1 && e > s) {
    try { return JSON.parse(cleaned.slice(s, e + 1)) } catch {}
  }
  return null
}

/**
 * Classify the tree's primary genre.
 * Takes first ~1000 words from the deepest level (full source).
 */
export async function classifyGenre(tree) {
  const maxL = String(tree.levelCount - 1)
  const nodes = tree.levels[maxL]?.nodes || []
  const fullText = nodes.map(n => n.text).join('\n\n')
  const words = fullText.split(/\s+/)
  const sample = words.slice(0, 1000).join(' ')

  const raw = callClaude(CLASSIFY_PROMPT(sample))
  const parsed = parseJson(raw)

  if (!parsed || typeof parsed.genre !== 'string' || !GENRES.includes(parsed.genre)) {
    console.warn('classify-genre: unparseable or invalid response — defaulting to short_story')
    console.warn('  raw (first 200):', (raw || '').substring(0, 200))
    return { genre: 'short_story', confidence: 0.0, secondary: null, reasoning: 'classifier failed; default' }
  }

  return {
    genre: parsed.genre,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    secondary: (parsed.secondary && GENRES.includes(parsed.secondary)) ? parsed.secondary : null,
    reasoning: parsed.reasoning || '',
  }
}

// CLI
const args = process.argv.slice(2)
const isCli = import.meta.url === `file://${process.argv[1]}`
if (isCli) {
  if (args.length < 1 || args.includes('--help')) {
    console.error('Usage: node tools/classify-genre.js <tree.json> [--json]')
    process.exit(1)
  }
  const jsonOnly = args.includes('--json')
  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  const treePath = path.resolve(projectRoot, args[0])
  const tree = JSON.parse(fs.readFileSync(treePath, 'utf8'))
  const result = await classifyGenre(tree)
  if (jsonOnly) {
    console.log(JSON.stringify(result))
  } else {
    console.log(`Genre:      ${result.genre}`)
    console.log(`Confidence: ${result.confidence}`)
    console.log(`Secondary:  ${result.secondary || '(none)'}`)
    console.log(`Reasoning:  ${result.reasoning}`)
  }
}
