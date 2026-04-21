#!/usr/bin/env node
/**
 * Rebuild the non-L_max levels of a tree from L_max directly.
 * Replaces the telephone chain (L_{k+1} → L_k → L_{k-1} → …) with
 * independent per-level generation against the full source text.
 *
 * For each level L from L_max-1 down to 0:
 *   1. GENERATE: Claude writes L-level prose using the full L_max text
 *      + the essentials visible at L (min_visible_level <= L) + the
 *      thematic thrust + cast/glossary + voice anchors + level constraints.
 *   2. VERIFY:   A second Claude call checks whether a cold reader —
 *      given only the reduction — can answer who / where / why / how /
 *      how-it-ends. If any are No, one retry with the verify feedback.
 *   3. ANCHOR:   One more Claude call per level locates each visible
 *      essential's span in the new level text, so the renderer can
 *      zoom-anchor.
 *
 * Writes:
 *   - the tree JSON (with new non-L_max levels; L_max untouched)
 *   - the concepts JSON (anchors refreshed across all levels)
 *
 * Usage:
 *   node tools/rebuild-levels.js <tree.json> <concepts.json>
 *   node tools/rebuild-levels.js <tree.json> <concepts.json> --only-level 0
 */

import fs from 'fs'
import path from 'path'
import { spawn, spawnSync } from 'child_process'

// ---------- args ----------
const args = process.argv.slice(2)
if (args.length < 2 || args.includes('--help')) {
  console.error('Usage: node tools/rebuild-levels.js <tree.json> <concepts.json> [--only-level N]')
  process.exit(1)
}
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const treePath = path.resolve(projectRoot, args[0])
const conceptsPath = path.resolve(projectRoot, args[1])
let onlyLevels = null  // null = all non-Lmax levels; else a Set of integers
let anchorsOnly = false
for (let i = 2; i < args.length; i++) {
  if (args[i] === '--only-level' && args[i + 1]) {
    // Accept "0" or "1,2,3" — a single level or a comma-separated list.
    const spec = args[++i]
    onlyLevels = new Set(spec.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n)))
  }
  else if (args[i] === '--anchors-only') anchorsOnly = true
}

// ---------- claude ----------
function callClaudeAsync(prompt, label) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const proc = spawn('claude', ['-p', '--output-format', 'text'], { stdio: ['pipe','pipe','pipe'] })
    let stdout = '', stderr = ''
    proc.stdout.on('data', d => { stdout += d.toString() })
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('close', (code) => {
      const ms = Date.now() - t0
      if (code !== 0) {
        console.error(`  [${label}] exit ${code} after ${(ms/1000).toFixed(1)}s: ${stderr.substring(0,120)}`)
        resolve(null); return
      }
      console.log(`  [${label}] ${(ms/1000).toFixed(1)}s (${stdout.trim().length} chars)`)
      resolve(stdout.trim() || null)
    })
    proc.on('error', (e) => { console.error(`  [${label}] ${e.message?.substring(0,120)}`); resolve(null) })
    const t = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 1200000)
    proc.on('close', () => clearTimeout(t))
    proc.stdin.write(prompt); proc.stdin.end()
  })
}

function parseJson(raw) {
  if (!raw) return null
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  try { return JSON.parse(cleaned) } catch {}
  const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}')
  if (s !== -1 && e > s) { try { return JSON.parse(cleaned.slice(s, e + 1)) } catch {} }
  return null
}

// ---------- load ----------
console.log(`Reading tree: ${path.relative(projectRoot, treePath)}`)
const tree = JSON.parse(fs.readFileSync(treePath, 'utf8'))
const conceptsRaw = JSON.parse(fs.readFileSync(conceptsPath, 'utf8'))
const concepts = Array.isArray(conceptsRaw) ? conceptsRaw : (conceptsRaw.concepts || [])
const characters = (!Array.isArray(conceptsRaw) && conceptsRaw.characters) || {}
const thematicThrust = (!Array.isArray(conceptsRaw) && conceptsRaw.thematic_thrust) || ''
const voiceAnchors = (!Array.isArray(conceptsRaw) && conceptsRaw.voice_anchors) || []
const genreInfo = (!Array.isArray(conceptsRaw) && conceptsRaw.genre) || { genre: 'short_story' }
const Lmax = tree.levelCount - 1
const LmaxNodes = tree.levels[String(Lmax)].nodes
const LmaxText = LmaxNodes.map(n => n.text).join('\n\n')
const LmaxWordCount = LmaxText.split(/\s+/).length

console.log(`Tree: "${tree.title}" — ${tree.levelCount} levels, ${LmaxWordCount} words at L${Lmax}`)
console.log(`Genre: ${genreInfo.genre}`)
console.log(`Concepts: ${concepts.length}, Characters: ${Object.keys(characters).length}, Voice anchors: ${voiceAnchors.length}`)
if (thematicThrust) console.log(`Thematic thrust: "${thematicThrust}"`)
console.log()

// ---------- standardized level ratios ----------
// User-prescribed compression scheme for the semantic-zoom reader.
// L0=5%, L1=15%, L2=33%, L3=50%, L4=75%, L5=100% (unabridged).
// Trees with a different level count interpolate along the same curve.
const STANDARD_RATIOS = [0.05, 0.15, 0.33, 0.50, 0.75, 1.00]

function ratioForLevel(L, Lmax) {
  if (Lmax === 5) return STANDARD_RATIOS[L]
  // Interpolate for non-6-level trees: map L/Lmax onto STANDARD_RATIOS curve.
  const pos = L / Lmax
  const x = pos * (STANDARD_RATIOS.length - 1)
  const i0 = Math.floor(x)
  const i1 = Math.min(STANDARD_RATIOS.length - 1, i0 + 1)
  const t = x - i0
  return STANDARD_RATIOS[i0] * (1 - t) + STANDARD_RATIOS[i1] * t
}

function targetWordsForLevel(L) {
  return Math.round(LmaxWordCount * ratioForLevel(L, Lmax))
}

// ---------- per-level generation prompt ----------
function buildGeneratePrompt(L, visibleEssentials, priorLevelText) {
  const ratio = ratioForLevel(L, Lmax)
  const targetWords = targetWordsForLevel(L)
  const ratioPct = Math.round(ratio * 100)

  const essentialsBlock = visibleEssentials.map(e => {
    const src = e.snippet ? `  — source phrasing: "${e.snippet.substring(0, 160)}${e.snippet.length > 160 ? '…' : ''}"` : ''
    return `- [${e.id}] (${e.type || 'beat'}): ${e.label}${src}`
  }).join('\n')

  // Level-specific emphasis — bespoke wording per compression ratio.
  // Each level inherits the craft constraints below; the emphasis
  // describes what this level's reader is there FOR.
  const levelEmphasis = (L === 0) ? `You are producing LEVEL 0 — the deepest zoom-out, approximately 5% of the source.
This is the POKER NUTS level: only the load-bearing essentials of the piece, arranged in source order so a reader who sees ONLY L0 gets the FLOW of the piece from start to finish. No fluff, no flourish, no atmospheric detail.
Voice preservation is harder at 5% than at other levels — do your best to keep the source's voice where room allows, but when it comes down to "preserve voice on a beat" vs "preserve the flow of the story start-to-finish," choose flow. L0's contract with the reader is: a reader who sees only L0 understands the arc of this piece from reading this alone.`

  : (L === 1) ? `You are producing LEVEL 1 — approximately 15% of the source.
The reader sees the whole piece here, compressed hard but with room L0 couldn't afford. Voice RECOVERS: the narrator's signature phrasings, specific jargon, tense, and register should surface. Include one or two load-bearing pieces of dialogue verbatim — the lines the piece collapses without. Keep the causal spine intact. Cut atmospheric description, side scenes, repetition, minor characters whose names don't advance the piece.
Room enough to orient the reader comfortably without pausing for synopsis.`

  : (L === 2) ? `You are producing LEVEL 2 — approximately 33% of the source.
The meaningful scenes and sections are restored at scene level — the reader experiences the piece as scenes unfolding, not as summarized beats. Key dialogue exchanges (not just single lines) appear verbatim. Atmospheric detail appears where it carries weight. Secondary characters surface when they advance the piece. The reader should feel the TEXTURE of the work, not just the arc.
Cut: repetition, atmospheric passages that don't carry weight, subplot that can be implied by a sentence instead of a scene.`

  : (L === 3) ? `You are producing LEVEL 3 — approximately 50% of the source.
Half the source. Most scenes survive in compressed form. Most dialogue is verbatim. Atmospheric and sensory detail is largely intact. The reader experiences the piece at close to full texture; the compression is apparent only in trimmed repetition and briefer description.
Cut: only the verbose — repeated emphasis, passages that say the same thing twice, description that over-stays.`

  : (L === 4) ? `You are producing LEVEL 4 — approximately 75% of the source.
Near-full text. Trim only pure flavor: repeated emphasis, verbose phrasings, very-long atmospheric passages that restate what an earlier sentence already said. A careful reader should barely notice the compression.
Do not omit any scene or beat present in the source. Only tighten prose where the source is itself verbose.`

  : `You are producing LEVEL ${L} — approximately ${ratioPct}% of the source word count.
Preserve the source's voice, POV, tense, and register throughout. Cover every visible essential. Compress by cutting pure flavor.`

  return `You are an editor producing one level of a SEMANTIC-ZOOM READER.

WHAT A SEMANTIC-ZOOM READER IS

A long document (short story, article, essay, chapter) is often dense, and readers want to scan its shape before committing to the full read. A semantic-zoom reader presents the SAME document at multiple levels of compression. The reader uses a scroll wheel to zoom in (see more detail) or out (see less). At deepest zoom-out they see a tight digest of the whole piece; at deepest zoom-in they see the unabridged original. Between those extremes, the piece is shown at progressively finer grain.

The design goal is that every level is the SAME WORK at a different resolution — not a summary at one end and the real text at the other. Same story, same essay, same article — told with more or fewer words depending on how much depth the reader wants right now.

Crucially, the reader's cursor tracks ideas ACROSS levels. Someone hovers on a phrase at one level, scrolls to zoom, and the cursor stays on the same idea at the new level — even though the text around it is different because the level is expanded or compressed. For this to work, every level must preserve the piece's structure and voice: the ideas must sit in the same relative order, expressed in the same voice, so the reader recognizes them across levels.

THE LEVEL SYSTEM

Six levels, fixed compression ratios:

  L0 — ~5% of source words   — THE POKER NUTS: only load-bearing essentials, source order, flow start-to-finish.
  L1 — ~15%                  — essentials + orientation and connective tissue; voice recovers.
  L2 — ~33%                  — meaningful scenes, with atmosphere and key dialogue restored.
  L3 — ~50%                  — half the source; most substance, scene-setting compressed.
  L4 — ~75%                  — near-full text; trim only pure flavor.
  L5 — 100%                  — UNABRIDGED. (Not your job — shown here so you understand the ladder.)

${levelEmphasis}

Target length: approximately ${targetWords} words (≈${ratioPct}% of the ${LmaxWordCount}-word source). Slight overshoot is fine if it serves the piece; do not exceed the next level up.

CRAFT CONSTRAINTS (at every level)

The output is the SAME PIECE as the source, at coarser or finer grain. Not a summary. Not a description.

• VOICE — match the source. First-person ("I") → first-person. Third-person → third-person. Mixed voice (e.g. a corporate memo interleaved with a first-person journal) → the mix survives in compressed form.

• TENSE — match the source. Don't translate past to present, present to past.

• REGISTER — match the source. Literary prose stays literary. A memo stays a memo. Slang, jargon, period-voice — preserved.

• PROPER NOUNS AND SIGNATURE PHRASINGS — preserve the source's specific vocabulary and the narrator's own turns of phrase. They are how the reader recognizes ideas across levels.

• NAMES AND RELATIONSHIPS — use the source's OWN phrasings. If the narrator says "my daughter Maya," you can write "my daughter Maya" — that's the narrator's natural voice. If the narrator never uses his own name, you never use his name. Do NOT insert third-person role-tag introductions the source doesn't contain (e.g. "Arthur P. L., the narrator," "Tanaka, a philosopher,"). The narrator wouldn't say that.

DISTILLATION vs SUMMARY

This is where the task goes wrong if you aren't careful.

A summary is written by someone OUTSIDE the piece looking in — describing what happens, introducing characters with role tags, using meta-markers ("the story opens with…", "in the end…"). A summary is a different artifact than the source.

A distillation is the source at lower resolution — the author's own voice, POV, and register, at fewer words. A distillation IS the piece, at this grain.

Example (generic, illustrative):

Source (~80 words, first-person, past tense):
  "I stood at the window that night, watching the fog roll in, and I remembered what my father had said about courage — that it was not the absence of fear but the willingness to walk toward it anyway. He had said this to me just once, when I was seven, and I had carried it with me for thirty years."

✗ Summary (third-person, describes the act of reflecting):
  "The narrator reflects on his father's lesson about courage while watching fog roll in."

✓ Distillation (first-person, same image, same claim, fewer words):
  "At the window, fog rolling in. My father, thirty years ago: courage is willingness, not absence. I carried it."

Both are ~20 words. The summary is ABOUT the story. The distillation IS the story, tighter.

FORBIDDEN PATTERNS

Every one of these marks the output as a summary rather than the piece itself:

  ✗ "The narrator…," "The author…," "The story…"
  ✗ "Arthur, the narrator,…" / "Tanaka, a philosopher,…" — third-person role-tag introductions the source doesn't contain
  ✗ "The story opens with…," "At the start…," "In the end…," "In conclusion…"
  ✗ Switching first-person source to third-person output
  ✗ Wikipedia-style lede sentences

If any of these appear in your draft, rewrite.

THEMATIC THRUST (the compass — do NOT insert as a line; let the essentials express it)

  "${thematicThrust || '(not set)'}"

ESSENTIALS — every one must be recognizable in your output, in source order

${essentialsBlock || '(no essentials supplied)'}

SOURCE (unabridged)

"""
${LmaxText}
"""

Produce level ${L}. Approximately ${targetWords} words. Same voice, same POV, same tense, same register as the source. Cover every essential in source order. No headers, no bullet lists, no meta-commentary. Just the piece, at this grain.`
}

// ---------- cold-reader verification prompt ----------
function buildVerifyPrompt(levelText, L) {
  return `The text below is supposedly a compressed retelling of a longer story at detail level ${L} of a semantic-zoom reader.

IMAGINE a reader who has NEVER seen the original. They see ONLY the text below. Can they answer these from the text alone?

  1. WHO is the protagonist and who are the other named entities? (Are they introduced with their roles?)
  2. WHAT is the situation or setting?
  3. WHAT decision, reveal, or pivotal event happens?
  4. WHY does it matter — what are the stakes or the meaning?
  5. HOW does it end — does the reader land somewhere?

If the text also preserves the story's voice (distinctive phrasing, dialogue feel), that is a bonus but not required for a pass.

Respond STRICT JSON, no fences, no commentary:
{
  "pass": <true if every question above has a clear answer from the text alone, else false>,
  "missing": [ <"who" | "what_situation" | "what_event" | "why" | "how_ends"> for each question that fails ],
  "advice": "<one short sentence on what to add to the reduction, only if pass is false>"
}

REDUCTION UNDER REVIEW (level ${L}):
"""
${levelText}
"""

Thematic intent (what the story is about): ${thematicThrust || '(unknown)'}

Return the JSON.`
}

// ---------- anchor-placement prompt (one call per level) ----------
function buildAnchorPrompt(L, levelText, nodesInfo, visibleEssentials) {
  const essentialsList = visibleEssentials.map(e => {
    return `  "${e.id}": { label: "${e.label}", lmax_source: "${(e.snippet || '').substring(0, 120)}" }`
  }).join(',\n')
  return `For each essential below, find its single best span in the LEVEL ${L} TEXT. The span is the passage in the level's text that expresses this essential. Each span is a substring of ONE NODE's text — not across nodes.

Return STRICT JSON, no fences: an object mapping essential id → { "nodeId": "...", "charStart": N, "charEnd": M } OR null if the essential does not appear in the level's text. charStart/charEnd are 0-indexed offsets into the specific node's text.

ESSENTIALS TO PLACE:
{
${essentialsList}
}

LEVEL ${L} NODES:
${nodesInfo.map(n => `--- NODE id=${JSON.stringify(n.id)} (${n.text.length} chars) ---\n${n.text}`).join('\n\n')}

Return the JSON map.`
}

// ---------- chunk generated text into nodes ----------
function chunkIntoNodes(text, levelNum) {
  // split on paragraph breaks (blank lines); keep dialogue etc intact inside paragraphs
  const paras = text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)
  if (paras.length === 0) return [{ id: `${levelNum}-0`, text: text.trim(), children: [] }]
  return paras.map((t, i) => ({ id: `${levelNum}-${i}`, text: t, children: [] }))
}

// ---------- main loop ----------
const levelsToProcess = []
for (let L = Lmax - 1; L >= 0; L--) {
  if (onlyLevels !== null && !onlyLevels.has(L)) continue
  levelsToProcess.push(L)
}

const anchorsByConcept = {}
// seed with ALL existing anchors (so a partial run doesn't wipe out anchors
// at levels it isn't processing). L_max anchors are canonical and always
// preserved.
for (const c of concepts) {
  anchorsByConcept[c.id] = { ...(c.anchors || {}) }
}
// If we're processing specific levels, also wipe the pre-existing anchors
// at those levels so they're rebuilt cleanly.
for (const L of levelsToProcess) {
  for (const id of Object.keys(anchorsByConcept)) {
    delete anchorsByConcept[id][String(L)]
  }
}

let priorLevelText = null  // optional phrasing reference from L+1

for (const L of levelsToProcess) {
  const visibleEssentials = concepts.filter(c => (c.min_visible_level ?? tree.levelCount) <= L)
  console.log(`\n=== L${L} — ${visibleEssentials.length} visible essentials${anchorsOnly ? ' (anchors-only mode)' : ''} ===`)

  let text = null
  const existingNodes = tree.levels[String(L)]?.nodes || []
  if (anchorsOnly && existingNodes.length > 0) {
    // Use existing level text — skip generation + verification
    text = existingNodes.map(n => n.text).join('\n\n')
    console.log(`  [L${L}] anchors-only: using existing ${existingNodes.length} nodes (${text.split(/\s+/).length} words)`)
  } else {
    // 1) GENERATE
    text = await callClaudeAsync(buildGeneratePrompt(L, visibleEssentials, priorLevelText), `gen:L${L}`)
    if (!text) { console.warn(`  [L${L}] generation failed; leaving existing level`); continue }
  }

  // Prompt carries the distillation-vs-summary contract; no separate
  // verify call. If a level reads as a summary the prompt needs fixing,
  // not a post-hoc retry.

  // 3) CHUNK into nodes + overwrite tree (unless anchors-only, keep existing)
  let newNodes
  if (anchorsOnly && existingNodes.length > 0) {
    newNodes = existingNodes
  } else {
    newNodes = chunkIntoNodes(text, L)
    tree.levels[String(L)].nodes = newNodes
    console.log(`  [L${L}] wrote ${newNodes.length} node${newNodes.length > 1 ? 's' : ''} (${text.split(/\s+/).length} words)`)
  }

  // 4) ANCHOR — place all visible essentials in the new level text.
  // Batch by BATCH_SIZE essentials so the per-call prompt stays small and
  // doesn't hit the claude subprocess timeout on longer levels.
  const BATCH_SIZE = 6
  const batches = []
  for (let i = 0; i < visibleEssentials.length; i += BATCH_SIZE) batches.push(visibleEssentials.slice(i, i + BATCH_SIZE))
  const anchorMap = {}
  const nodeByIdMap = Object.fromEntries(newNodes.map(n => [n.id, n]))
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi]
    const raw = await callClaudeAsync(buildAnchorPrompt(L, text, newNodes, batch), `anchor:L${L}:${bi + 1}/${batches.length}`)
    const parsed = parseJson(raw) || {}
    for (const k of Object.keys(parsed)) anchorMap[k] = parsed[k]
  }
  let anchored = 0
  for (const e of visibleEssentials) {
    const a = anchorMap[e.id]
    if (!a || typeof a !== 'object') continue
    const { nodeId, charStart, charEnd } = a
    const node = nodeByIdMap[nodeId]
    if (!node) continue
    const cs = Math.max(0, Math.floor(charStart))
    const ce = Math.min(node.text.length, Math.floor(charEnd))
    if (ce <= cs) continue
    anchorsByConcept[e.id][String(L)] = { nodeId, charStart: cs, charEnd: ce }
    anchored++
  }
  console.log(`  [L${L}] anchored ${anchored}/${visibleEssentials.length} essentials`)

  priorLevelText = text  // pass to L-1 as phrasing reference
}

// ---------- write ----------
// tree
fs.writeFileSync(treePath, JSON.stringify(tree, null, 2))
console.log(`\nWrote tree: ${path.relative(projectRoot, treePath)}`)

// concepts — update anchors, preserve everything else
const finalConcepts = concepts.map(c => {
  const rec = { ...c }
  rec.anchors = anchorsByConcept[c.id] || rec.anchors || {}
  return rec
})
const fileShape = Array.isArray(conceptsRaw) ? finalConcepts : {
  ...conceptsRaw,
  concepts: finalConcepts,
}
fs.writeFileSync(conceptsPath, JSON.stringify(fileShape, null, 2))
console.log(`Wrote concepts: ${path.relative(projectRoot, conceptsPath)}`)

// coverage
console.log('\nAnchor coverage:')
for (let L = 0; L <= Lmax; L++) {
  const visible = finalConcepts.filter(c => (c.min_visible_level ?? tree.levelCount) <= L).length
  const placed = finalConcepts.filter(c => c.anchors?.[String(L)]).length
  console.log(`  L${L}: ${placed}/${visible} visible anchored`)
}

// Phrase-chain maps. Regenerating the tree wipes any stale phrases, so
// rebuild them here — the renderer's wheel handler uses matchIn/matchOut to
// disambiguate multi-mention anchors and to place the cursor when the
// tracked concept has no anchor at the new level.
console.log('\nBuilding phrase-chain maps...')
const relTree = path.relative(projectRoot, treePath)
const phraseResult = spawnSync('node', ['tools/add-phrase-maps.js', relTree], {
  cwd: projectRoot,
  stdio: 'inherit'
})
if (phraseResult.status !== 0) {
  console.error('add-phrase-maps.js failed')
  process.exit(phraseResult.status || 1)
}
