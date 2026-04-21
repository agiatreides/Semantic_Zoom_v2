#!/usr/bin/env node
/**
 * Concept anchor extractor for Semantic Zoom v2.
 *
 * Takes a tree.json and produces a sibling <basename>-concepts.json with
 * per-level anchors for each major event (= a verb-driven thing that
 * happens in the narrative). Required by the renderer's concept-anchored
 * zoom (src/main.js wheel handler).
 *
 * Each concept also carries a `min_visible_level`: the most-compressed
 * zoom level at which it must remain visible. Above that level the
 * concept is intentionally absent — the renderer expects this.
 *
 * Usage:
 *   node tools/extract-concepts.js data/foo.json
 *   node tools/extract-concepts.js data/foo.json --output data/foo-concepts.json
 *   node tools/extract-concepts.js data/foo.json --concept-count 12
 *
 * Pipeline (one ranking call + per-essential precise-anchor calls):
 *   Pass 1: Read the deepest level's full text. Ask Claude to identify
 *           major events with verb-driven labels, a verbatim L_max
 *           snippet, AND a min_visible_level using the poker-nuts framing.
 *           Anchor each at L_max by literal substring search.
 *           If the L_max distribution is degenerate, re-prompt once.
 *
 *   Pass 2: Walk UPWARD via the tree's `children` field, level by level.
 *           For each concept whose min_visible_level <= L, place an
 *           anchor at L:
 *             - For ESSENTIALS (bottom third by min_visible_level), one
 *               targeted Claude call per (concept, level) finds the
 *               precise span in the parent node's text.
 *             - For non-essentials, fall back to literal/fuzzy substring
 *               matching (cheap, fine for deeper levels with longer text).
 *           Concepts at levels < their min_visible_level emit no anchor.
 *
 * Why this design:
 *   - Off-the-shelf salience methods (TextRank, LexRank, embedding
 *     centrality) reward TYPICALITY which is anti-correlated with plot
 *     pivots. Pivotal events are often the LEAST typical sentences.
 *     Claude does narrative-counterfactual reasoning ("does the story
 *     break without this?") that no pre-baked ranker provides.
 *   - Fuzzy-substring fails for load-bearing concepts when the parent's
 *     reduction rephrases. Claude in the loop only for those.
 *
 * Designed for any prose: research papers, books, short stories, essays.
 */

import fs from 'fs'
import path from 'path'
import { execSync, spawn } from 'child_process'
import { classifyGenre } from './classify-genre.js'

// Promise-mapping helper: run async fn over items with bounded concurrency.
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

// Async Claude call via spawn — for parallel batching.
function callClaudeAsync(prompt, label) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const proc = spawn('claude', ['-p', '--output-format', 'text'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    proc.stdout.on('data', d => { stdout += d.toString() })
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('close', (code) => {
      const ms = Date.now() - t0
      if (code !== 0) {
        console.error(`  [${label} ${(ms/1000).toFixed(1)}s] exit ${code}: ${stderr.substring(0, 120)}`)
        resolve(null); return
      }
      const out = stdout.trim()
      console.log(`    [${label}] ${(ms/1000).toFixed(1)}s, ${out.length} chars`)
      resolve(out || null)
    })
    proc.on('error', e => {
      console.error(`  [${label}] spawn error: ${e.message}`)
      resolve(null)
    })
    const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 600000)
    proc.on('close', () => clearTimeout(timer))
    proc.stdin.write(prompt)
    proc.stdin.end()
  })
}

const args = process.argv.slice(2)
if (!args[0] || args.includes('--help') || args.includes('-h')) {
  console.error('Usage: node tools/extract-concepts.js <tree.json> [--output <out.json>] [--concept-count N]')
  process.exit(1)
}

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const inputPath = path.resolve(projectRoot, args[0])
let outputPath = null
let conceptCount = null
let identifyOnly = false
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--output' && args[i + 1]) { outputPath = path.resolve(projectRoot, args[++i]) }
  else if (args[i] === '--concept-count' && args[i + 1]) { conceptCount = parseInt(args[++i], 10) }
  else if (args[i] === '--identify-only') { identifyOnly = true }
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
  let startIdx = -1
  for (const c of ['[', '{']) {
    const i = s.indexOf(c)
    if (i !== -1 && (startIdx === -1 || i < startIdx)) startIdx = i
  }
  if (startIdx > 0) s = s.substring(startIdx)
  const lastBracket = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'))
  if (lastBracket !== -1 && lastBracket < s.length - 1) s = s.substring(0, lastBracket + 1)
  try {
    return JSON.parse(s)
  } catch (e) {
    console.error(`  [${label}] JSON parse failed:`, e.message)
    console.error('  raw response (first 500 chars):', raw.substring(0, 500))
    // Dump full raw for debugging
    try {
      fs.writeFileSync(`/tmp/extract-concepts-failed-${label.replace(/[^\w]/g,'_')}.txt`, raw)
      console.error(`  full raw saved to /tmp/extract-concepts-failed-${label.replace(/[^\w]/g,'_')}.txt`)
    } catch {}
    return null
  }
}

// --------------------------------------------------------------------
// Pass 1: identify beats + L_max snippets + min_visible_level
// (Field name "events" kept for backward compat — content is beats.)
// --------------------------------------------------------------------
//
// See SIGNAL_HIERARCHY_REVIEW.md §13-14 for the rationale behind this
// prompt. Short summary:
//   - "beat" (not "event") — covers actions, dialogue, reveals, inner
//     shifts, tonal pivots, voice-carrying passages.
//   - Multi-axis poker-nuts test: plot / stakes / meaning / voice. A
//     beat survives at L0 if cutting it collapses the story on ANY axis.
//   - Opening and ending are privileged (but not hard-locked).
//   - A single "thematic_thrust" sentence is extracted alongside beats
//     to orient the L0 reduction and later stages.
//   - Up to 3 "voice_anchors" — passages whose diction carries the
//     story's register. They are candidates for per-level anchoring so
//     reduced text still SOUNDS like the story.
//   - L0 completeness gate: the prompt asks Claude to read back the L0
//     set as if a cold reader would see ONLY that, and promote if
//     incomplete.
//
// Genre routing: this prompt is the `short_story` path in PROMPT_REGISTRY
// (and the fallback for every other genre until we tune them). See the
// stubs and the dispatch at the bottom of this file.

const NARRATIVE_NUTS_PROMPT_V2 = (nodeBlock, totalWords, levelCount, targetCount, lMaxId) => `Extract the signal hierarchy from this short story for a semantic-zoom reader.

Return ONE strict-JSON object with five fields:

A. THEMATIC_THRUST — one sentence (10-25 words) answering "What is this story ABOUT?" Stay inside the diegesis. No "explores themes of…" or "is about how…".

B. CHARACTERS — cast & glossary dict. Every named person, named AI, and proper-noun entity a cold reader wouldn't recognize. Value: 3-8 word role tag with relationship to narrator where tight (e.g. "narrator's daughter, age 16").

C. EVENTS — approximately ${targetCount} BEATS, in story order. A beat is any moment doing load-bearing work: an action/decision, a dialogue exchange, an inner shift/realization, a reveal that reframes, a tonal pivot, or a voice-carrying passage. For each beat:
  - id: kebab-case
  - label: 3-9 word VERB-DRIVEN phrase
  - type: one of action | dialogue | inner_shift | reveal | tonal_pivot | voice
  - nodeId: the L${levelCount - 1} node id (e.g. "${lMaxId}") where the beat lives
  - snippet: 20-150 char VERBATIM quote from that node (must literally exist)
  - min_visible_level: integer 0 to ${levelCount - 1} (0 = most compressed; ${levelCount - 1} = full text)
  - collapse_axes: array of subset of ["plot","stakes","meaning","voice"] — the axes on which cutting this beat would break the story

D. VOICE_ANCHORS — up to 3 short passages whose diction carries the story's register. Each: { nodeId, snippet (verbatim), note (one sentence on voice quality) }. Empty array if no single passage carries voice.

POKER-NUTS ASSIGNMENT RULES:
- min_visible_level = 0: cutting this beat breaks at least one of the four axes. A cold reader seeing ONLY level-0 beats must be able to follow the story — enter it (world, POV), see the pivotal turn, and reach a landing. Usually 3-7 beats in a short story; err on the side of MORE beats at L0, not fewer. Better to include backdrop than destroy the story.
- min_visible_level = 1: still essential at L1; cutting weakens but doesn't break.
- min_visible_level = ${levelCount - 1}: pure flavor. Most atmospheric / secondary beats land here.

BIASES:
- Opening and closing beats are almost always L0-essential.
- Direct dialogue (quoted speech) that is load-bearing is L0-essential; preserve verbatim snippet.
- Voice-type beats belong at the level where the voice is load-bearing; often L0 or L1.

SAME-STORY CONSTRAINT (the floor): the set of level-0 beats must tell the SAME story as the full text at coarser resolution, not a description of the story. If mentally stringing your L0 beats together produces "a summary of the story" rather than "the story told tighter," promote more beats to L0 until it reads as the story.

OUTPUT EXACTLY THIS SHAPE (strict JSON, no fences, no commentary, no preamble):

{
  "thematic_thrust": "<one sentence, 10-25 words>",
  "characters": { "Name": "role descriptor", ... },
  "events": [
    {
      "id": "...", "label": "...", "type": "...",
      "nodeId": "...", "snippet": "...",
      "min_visible_level": N,
      "collapse_axes": ["plot","stakes",...]
    }, ...
  ],
  "voice_anchors": [
    { "nodeId": "...", "snippet": "...", "note": "..." }, ...
  ]
}

NODES (level ${levelCount - 1}, ${totalWords} words total):
${nodeBlock}

Return the JSON object.`

// --------------------------------------------------------------------
// PROMPT_REGISTRY — genre → prompt builder
// --------------------------------------------------------------------
//
// Only short_story has a fully-tuned prompt. Other genres call the
// narrative prompt and log a warning so operators know they're routing
// through the fallback. See SIGNAL_HIERARCHY_REVIEW.md §16 for the
// planned schema per genre.

function stubWarn(genre, schema) {
  console.warn(`[genre=${genre}] using short-story fallback prompt. Planned schema: ${schema}`)
  console.warn(`  TODO: replace with ${genre}-specific prompt. See SIGNAL_HIERARCHY_REVIEW.md §16.`)
}

const PROMPT_REGISTRY = {
  short_story:      NARRATIVE_NUTS_PROMPT_V2,

  // Narrative-family — currently reuses the short-story prompt. Acceptable
  // because the shape is similar; needs its own tuning for longer arcs.
  novella:          (...a) => { stubWarn('novella', 'narrative, multi-arc'); return NARRATIVE_NUTS_PROMPT_V2(...a) },
  novel_excerpt:    (...a) => { stubWarn('novel_excerpt', 'narrative, part-of-larger'); return NARRATIVE_NUTS_PROMPT_V2(...a) },
  biography_memoir: (...a) => { stubWarn('biography_memoir', 'narrative + reflection, real life'); return NARRATIVE_NUTS_PROMPT_V2(...a) },

  // Argument / exposition / procedural / research / reference — these really
  // need their own schemas. Stubs fall back to narrative with a warning.
  essay:            (...a) => { stubWarn('essay', 'thesis → evidence → counter → rebuttal → conclusion'); return NARRATIVE_NUTS_PROMPT_V2(...a) },
  argument:         (...a) => { stubWarn('argument', 'thesis → evidence → counter → rebuttal → conclusion'); return NARRATIVE_NUTS_PROMPT_V2(...a) },
  exposition:       (...a) => { stubWarn('exposition', 'claim/definition → elaboration → implication'); return NARRATIVE_NUTS_PROMPT_V2(...a) },
  procedural:       (...a) => { stubWarn('procedural', 'prerequisites → critical steps → outcome test'); return NARRATIVE_NUTS_PROMPT_V2(...a) },
  research_paper:   (...a) => { stubWarn('research_paper', 'problem → method → result → significance'); return NARRATIVE_NUTS_PROMPT_V2(...a) },
  reference:        (...a) => { stubWarn('reference', 'topic → structured-facets'); return NARRATIVE_NUTS_PROMPT_V2(...a) },

  default:          NARRATIVE_NUTS_PROMPT_V2,
}

function identifyAndAnchorAtLmax(tree, targetCount, genre) {
  const maxL = String(tree.levelCount - 1)
  const nodes = tree.levels[maxL]?.nodes || []
  const nodeBlock = nodes.map(n =>
    `=== NODE ${n.id} (${n.text.length} chars) ===\n${n.text}`
  ).join('\n\n')
  const totalWords = nodes.map(n => n.text.split(/\s+/).length).reduce((a,b)=>a+b, 0)

  if (!targetCount) {
    targetCount = Math.max(8, Math.min(20, Math.round(Math.sqrt(totalWords) / 1.5)))
  }

  const lMaxId = nodes[0]?.id ?? `${maxL}-0`
  const promptBuilder = PROMPT_REGISTRY[genre] || PROMPT_REGISTRY.default
  console.log(`Pass 1 [genre=${genre}]: identifying ~${targetCount} beats + glossary from L${maxL} (${totalWords} words)...`)
  const raw = callClaude(promptBuilder(nodeBlock, totalWords, tree.levelCount, targetCount, lMaxId), 'identify')
  const parsed = parseJsonResponse(raw, 'identify')
  // Support both the new rich shape and legacy bare-array / {events, characters}
  let eventsArr = null
  let characters = {}
  let thematicThrust = ''
  let voiceAnchors = []
  if (Array.isArray(parsed)) {
    eventsArr = parsed
  } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.events)) {
    eventsArr = parsed.events
    if (parsed.characters && typeof parsed.characters === 'object') {
      characters = parsed.characters
    }
    if (typeof parsed.thematic_thrust === 'string') {
      thematicThrust = parsed.thematic_thrust.trim()
    }
    if (Array.isArray(parsed.voice_anchors)) {
      voiceAnchors = parsed.voice_anchors.filter(v => v && typeof v.nodeId === 'string' && typeof v.snippet === 'string')
    }
  } else {
    console.error('  Pass 1 failed: unrecognized response shape')
    return null
  }
  // Stash on tree for later emit
  tree._extractedCharacters = characters
  tree._thematicThrust = thematicThrust
  tree._voiceAnchors = voiceAnchors
  const charNames = Object.keys(characters)
  if (thematicThrust) {
    console.log(`  thematic thrust: "${thematicThrust}"`)
  }
  if (charNames.length) {
    console.log(`  characters: ${charNames.map(n => `${n}=${characters[n]}`).join('; ').substring(0, 200)}`)
  }
  if (voiceAnchors.length) {
    console.log(`  voice anchors: ${voiceAnchors.length} (${voiceAnchors.map(v => v.note?.substring(0, 40) || '?').join(' | ')})`)
  }

  const concepts = []
  for (const c of eventsArr) {
    if (!c || typeof c.id !== 'string' || typeof c.label !== 'string') continue
    if (typeof c.nodeId !== 'string' || typeof c.snippet !== 'string') continue
    let mvl = parseInt(c.min_visible_level, 10)
    if (isNaN(mvl)) mvl = tree.levelCount - 1
    mvl = Math.max(0, Math.min(tree.levelCount - 1, mvl))
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
      type: typeof c.type === 'string' ? c.type.trim() : undefined,
      collapse_axes: Array.isArray(c.collapse_axes) ? c.collapse_axes.filter(x => typeof x === 'string') : undefined,
      snippet: c.snippet,
      min_visible_level: mvl,
      lmaxAnchor: { nodeId: c.nodeId, charStart: idx, charEnd: idx + c.snippet.length },
    })
  }
  console.log(`  identified ${concepts.length} events with valid L${maxL} anchors`)
  // Distribution
  const dist = {}
  for (let L = 0; L < tree.levelCount; L++) dist[L] = 0
  for (const c of concepts) dist[c.min_visible_level]++
  const distStr = Object.entries(dist).map(([L,n]) => `L${L}:${n}`).join(' ')
  console.log(`  min_visible_level distribution: ${distStr}`)
  return concepts
}

function maybeRebalance(tree, concepts) {
  // If L0 is empty (Claude was too conservative) or saturated (>50% at L0), re-prompt once.
  const total = concepts.length
  if (total === 0) return concepts
  const dist = {}
  for (let L = 0; L < tree.levelCount; L++) dist[L] = 0
  for (const c of concepts) dist[c.min_visible_level]++
  const l0 = dist[0]
  if (l0 >= 1 && l0 <= Math.max(1, Math.floor(total / 2))) {
    console.log(`  distribution OK (L0 has ${l0}/${total} events) — no rebalance needed`)
    return concepts
  }

  console.log(`  rebalancing: L0=${l0}/${total} is degenerate, asking Claude to redistribute...`)
  const eventList = concepts.map(c => `  ${c.id} (currently L${c.min_visible_level}): "${c.label}"`).join('\n')
  const prompt = `You previously assigned each of these story events a min_visible_level (the most-compressed zoom level at which the event must remain visible). The L0 distribution is degenerate: ${l0} events at L0 out of ${total} total. The L0 reduction should contain only the absolute few events the story collapses without — ideally 1-5 in a short story, more in a longer document. ${l0 === 0 ? "You assigned ZERO events to L0 — there must be at least one absolute nut." : `${l0} events at L0 is too many — be stricter about what's truly load-bearing.`}

Re-assign each event a min_visible_level (integer 0 to ${tree.levelCount - 1}). Default to higher levels unless the event is absolutely required for the reader to follow the plot at that compression. Return STRICT JSON: an object mapping event id → integer min_visible_level. No commentary, no fences.

EVENTS:
${eventList}

Return the JSON object.`
  const raw = callClaude(prompt, 'rebalance')
  const parsed = parseJsonResponse(raw, 'rebalance')
  if (!parsed || typeof parsed !== 'object') {
    console.warn('  rebalance failed; keeping original distribution')
    return concepts
  }
  for (const c of concepts) {
    const v = parsed[c.id]
    if (typeof v === 'number') {
      c.min_visible_level = Math.max(0, Math.min(tree.levelCount - 1, Math.floor(v)))
    }
  }
  const newDist = {}
  for (let L = 0; L < tree.levelCount; L++) newDist[L] = 0
  for (const c of concepts) newDist[c.min_visible_level]++
  console.log(`  post-rebalance distribution: ${Object.entries(newDist).map(([L,n]) => `L${L}:${n}`).join(' ')}`)
  return concepts
}

// --------------------------------------------------------------------
// Tree-walk helpers
// --------------------------------------------------------------------

function buildParentMap(tree) {
  const parentMap = {}
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

  const wordRe = /[A-Za-z0-9'-]+/g
  const positions = []
  let m
  while ((m = wordRe.exec(parentText)) !== null) {
    positions.push({ start: m.index, end: m.index + m[0].length, lc: m[0].toLowerCase() })
  }
  if (positions.length === 0) return null

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
  return { charStart: bestStart, charEnd: bestEnd, score: bestScore, via: 'fuzzy' }
}

function literalAnchor(parentText, snippet) {
  const idx = parentText.indexOf(snippet)
  if (idx !== -1) return { charStart: idx, charEnd: idx + snippet.length, via: 'literal' }
  // Try first ~40 chars (head)
  const head = snippet.substring(0, Math.min(40, snippet.length))
  const idx2 = parentText.indexOf(head)
  if (idx2 !== -1 && head.length >= 12) {
    return { charStart: idx2, charEnd: idx2 + head.length, via: 'literal-head' }
  }
  return null
}

// Claude precise-anchor for essential concepts: one targeted call per (concept, level).
// Returns char range within parentNode.text or null. Async so we can batch in parallel.
async function claudePreciseAnchorAsync(concept, parentNode, level) {
  const prompt = `Find the SINGLE BEST passage in the text below that expresses this story event. Return ONLY a JSON object with charStart and charEnd (0-indexed character offsets, inclusive start, exclusive end), or null if the event is not present.

The character range MUST point to a substring that ACTUALLY EXISTS in the text — between 15 and 250 characters long, preferably matching the event as tightly as possible. Do NOT invent text. Do NOT include surrounding atmospheric detail.

EVENT id: "${concept.id}"
EVENT label: "${concept.label}"
EVENT context (verbatim from a more detailed level): "${concept.snippet}"

TEXT (from node ${parentNode.id} at level ${level}, ${parentNode.text.length} chars):
"""
${parentNode.text}
"""

Return STRICT JSON: {"charStart": N, "charEnd": M} or null. No commentary, no fences.`

  const raw = await callClaudeAsync(prompt, `precise:${concept.id.substring(0,20)}:L${level}`)
  const parsed = parseJsonResponse(raw, `precise:${concept.id}:L${level}`)
  if (!parsed || typeof parsed !== 'object') return null
  let { charStart, charEnd } = parsed
  if (typeof charStart !== 'number' || typeof charEnd !== 'number') return null
  charStart = Math.max(0, Math.floor(charStart))
  charEnd = Math.min(parentNode.text.length, Math.floor(charEnd))
  if (charEnd <= charStart) return null
  const span = charEnd - charStart
  if (span < 5 || span > 500) {
    console.warn(`    rejected precise anchor: span ${span} chars out of range`)
    return null
  }
  return { charStart, charEnd, via: 'claude-precise' }
}

async function anchorAtParentAsync(concept, parentNode, level, useClaude) {
  if (useClaude) {
    const a = await claudePreciseAnchorAsync(concept, parentNode, level)
    if (a) return { nodeId: parentNode.id, ...a }
  }
  const lit = literalAnchor(parentNode.text, concept.snippet)
  if (lit) return { nodeId: parentNode.id, ...lit }
  const fz = fuzzyAnchor(parentNode.text, concept.snippet, concept.label)
  if (fz) return { nodeId: parentNode.id, ...fz }
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

console.log(`\nPass 0: classifying genre...`)
const genreResult = await classifyGenre(tree)
console.log(`  genre:      ${genreResult.genre} (confidence ${genreResult.confidence})`)
if (genreResult.secondary) console.log(`  secondary:  ${genreResult.secondary}`)
if (genreResult.reasoning) console.log(`  reasoning:  ${genreResult.reasoning}`)
tree._classifiedGenre = genreResult

let concepts = identifyAndAnchorAtLmax(tree, conceptCount, genreResult.genre)
if (!concepts || concepts.length === 0) {
  console.error('No concepts identified — aborting.')
  process.exit(2)
}
concepts = maybeRebalance(tree, concepts)

// Threshold for "essential": bottom third of min_visible_level distribution.
// Per the design: scales with document size.
const sortedMVLs = concepts.map(c => c.min_visible_level).sort((a, b) => a - b)
const essThreshold = sortedMVLs[Math.floor(sortedMVLs.length / 3)]
console.log(`\nEssentiality threshold: min_visible_level <= ${essThreshold} → use Claude precise-anchor`)
const isEssential = (c) => c.min_visible_level <= essThreshold

// Initialize anchors with L_max anchors (every concept has an L_max anchor by construction)
const anchorsByConcept = {}
for (const c of concepts) {
  anchorsByConcept[c.id] = { [String(Lmax)]: c.lmaxAnchor }
}

const parentMap = buildParentMap(tree)

if (identifyOnly) {
  console.log(`\n--identify-only: skipping upward anchor propagation.`)
}

if (!identifyOnly) console.log(`Propagating concepts upward through ${Lmax} levels (parallel within each level)...`)
const ANCHOR_CONCURRENCY = 8
for (let L = identifyOnly ? -1 : Lmax - 1; L >= 0; L--) {
  const lstr = String(L)
  const nodes = tree.levels[lstr]?.nodes || []
  const nodeById = Object.fromEntries(nodes.map(n => [n.id, n]))

  // Build the list of jobs (concepts that need an anchor at this level)
  const jobs = []
  let viaSkippedMVL = 0, viaNone = 0
  for (const c of concepts) {
    if (L < c.min_visible_level) { viaSkippedMVL++; continue }
    const childAnchor = anchorsByConcept[c.id][String(L + 1)]
    if (!childAnchor) { viaNone++; continue }
    const pinfo = parentMap[`${L + 1}:${childAnchor.nodeId}`]
    if (!pinfo) { viaNone++; continue }
    const parent = nodeById[pinfo.parentId]
    if (!parent) { viaNone++; continue }
    jobs.push({ c, parent, useClaude: isEssential(c) })
  }

  const tStart = Date.now()
  const results = await pmap(jobs, ANCHOR_CONCURRENCY, async ({ c, parent, useClaude }) => {
    const a = await anchorAtParentAsync(c, parent, L, useClaude)
    return { c, parent, a }
  })

  let placed = 0, viaLiteral = 0, viaFuzzy = 0, viaPrecise = 0
  for (const { c, a } of results) {
    if (!a) { viaNone++; continue }
    anchorsByConcept[c.id][lstr] = { nodeId: a.nodeId, charStart: a.charStart, charEnd: a.charEnd }
    placed++
    if (a.via === 'claude-precise') viaPrecise++
    else if (a.via === 'literal' || a.via === 'literal-head') viaLiteral++
    else viaFuzzy++
  }
  console.log(`  L${L}: ${placed}/${concepts.length} placed (${viaPrecise} precise, ${viaLiteral} literal, ${viaFuzzy} fuzzy, ${viaSkippedMVL} below_mvl, ${viaNone} unanchored) in ${((Date.now() - tStart)/1000).toFixed(1)}s`)
}

// Emit — the concepts file now carries genre, thematic thrust, characters,
// voice anchors, and concepts (with type + collapse_axes on each).
// Renderer's loadConcepts accepts either shape (backward compat).
const output = concepts.map(c => {
  const rec = {
    id: c.id,
    label: c.label,
    min_visible_level: c.min_visible_level,
    anchors: anchorsByConcept[c.id],
  }
  if (c.type) rec.type = c.type
  if (c.collapse_axes) rec.collapse_axes = c.collapse_axes
  return rec
})
const final = output.filter(c => Object.keys(c.anchors).length > 0)
const dropped = output.length - final.length
if (dropped > 0) console.log(`\nDropped ${dropped} concepts with no valid anchors`)

const fileShape = {
  genre: tree._classifiedGenre || null,
  thematic_thrust: tree._thematicThrust || '',
  characters: tree._extractedCharacters || {},
  voice_anchors: tree._voiceAnchors || [],
  concepts: final,
}
fs.writeFileSync(outputPath, JSON.stringify(fileShape, null, 2))
console.log(`\nWrote ${final.length} concepts to ${path.relative(projectRoot, outputPath)}`)
console.log(`Coverage:`)
for (let L = 0; L < levelCount; L++) {
  const lstr = String(L)
  const placed = final.filter(c => c.anchors[lstr]).length
  const visible = final.filter(c => c.min_visible_level <= L).length
  console.log(`  L${L}: ${placed}/${visible} visible concepts anchored (intentionally hidden: ${final.length - visible})`)
}
