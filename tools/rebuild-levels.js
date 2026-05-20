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
 *   node tools/rebuild-levels.js <tree.json> <concepts.json> --batch
 */

import fs from 'fs'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { rebuildLinearChildLinks } from './lib/child-links.js'

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
let batchGenerate = false
for (let i = 2; i < args.length; i++) {
  if (args[i] === '--only-level' && args[i + 1]) {
    // Accept "0" or "1,2,3" — a single level or a comma-separated list.
    const spec = args[++i]
    onlyLevels = new Set(spec.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n)))
  }
  else if (args[i] === '--anchors-only') anchorsOnly = true
  else if (args[i] === '--batch' || args[i] === '--batch-generate') batchGenerate = true
}

// ---------- claude ----------
// --effort medium: compression needs judgment (flourish vs load-bearing) but
// not the Opus-style deep reasoning that was the hidden per-call time sink
// at default effort. --exclude-dynamic-system-prompt-sections keeps prompt
// context steadier across calls.
// Sonnet is the pipeline default: voice fidelity > Haiku, ~1 min slower, hits
// every word-count band. Override with MODEL=haiku for long documents where
// the speed gap matters more than voice.
const MODEL_FLAG = ['--model', process.env.MODEL || 'sonnet']
const EFFORT_FLAG = ['--effort', process.env.EFFORT || 'medium']

function callClaudeAsync(prompt, label) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const proc = spawn('claude', ['-p', '--output-format', 'text', '--exclude-dynamic-system-prompt-sections', ...EFFORT_FLAG, ...MODEL_FLAG], { stdio: ['pipe','pipe','pipe'] })
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

// ---------- cheap anchor placement ----------
// Model placement is useful when reductions paraphrase a concept, but near-full
// levels often preserve literal source language. Try literal placement first
// and send only unresolved essentials to Claude. Fuzzy pre-placement is opt-in
// via FAST_FUZZY_ANCHORS=1 because a wrong anchor is worse than a slow call.
const ANCHOR_STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'also', 'because', 'before', 'being',
  'between', 'could', 'does', 'doing', 'during', 'every', 'from', 'have',
  'into', 'just', 'more', 'most', 'only', 'over', 'same', 'should', 'that',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'through',
  'under', 'what', 'when', 'where', 'which', 'while', 'with', 'would',
])

function keywords(text) {
  return (text || '')
    .toLowerCase()
    .match(/[a-z0-9'-]+/g)?.filter(w => w.length >= 4 && !ANCHOR_STOPWORDS.has(w)) || []
}

function wordMatches(a, b) {
  if (a === b) return true
  if (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5)) return true
  return a.length >= 6 && b.length >= 6 && (a.includes(b) || b.includes(a))
}

function literalAnchor(text, snippet) {
  if (!text || !snippet) return null
  const exact = text.indexOf(snippet)
  if (exact !== -1) return { charStart: exact, charEnd: exact + snippet.length, via: 'literal' }

  const compact = snippet.replace(/\s+/g, ' ').trim()
  if (compact && compact !== snippet) {
    const idx = text.indexOf(compact)
    if (idx !== -1) return { charStart: idx, charEnd: idx + compact.length, via: 'literal-compact' }
  }

  const head = compact.substring(0, Math.min(48, compact.length))
  if (head.length >= 16) {
    const idx = text.indexOf(head)
    if (idx !== -1) return { charStart: idx, charEnd: idx + head.length, via: 'literal-head' }
  }
  return null
}

function sentenceSpans(text) {
  const spans = []
  const re = /[^.!?\n]+[.!?]?/g
  let m
  while ((m = re.exec(text)) !== null) {
    const raw = m[0]
    const leading = raw.match(/^\s*/)?.[0].length || 0
    const trailing = raw.match(/\s*$/)?.[0].length || 0
    const start = m.index + leading
    const end = m.index + raw.length - trailing
    if (end > start) spans.push({ start, end, text: text.slice(start, end) })
  }
  if (spans.length === 0 && text.trim()) {
    const start = text.indexOf(text.trim())
    spans.push({ start, end: start + text.trim().length, text: text.trim() })
  }
  return spans
}

function fuzzyAnchor(text, snippet, label) {
  const sourceWords = [...new Set(keywords(`${label || ''} ${snippet || ''}`))]
  if (sourceWords.length < 2) return null

  const spans = sentenceSpans(text)
  const candidates = []
  for (let i = 0; i < spans.length; i++) {
    candidates.push({ start: spans[i].start, end: spans[i].end, text: spans[i].text })
    if (i < spans.length - 1) {
      candidates.push({
        start: spans[i].start,
        end: spans[i + 1].end,
        text: text.slice(spans[i].start, spans[i + 1].end),
      })
    }
  }

  let best = null
  for (const c of candidates) {
    const spanLen = c.end - c.start
    if (spanLen < 12 || spanLen > 600) continue
    const candidateWords = [...new Set(keywords(c.text))]
    if (candidateWords.length === 0) continue
    let overlap = 0
    for (const sw of sourceWords) {
      if (candidateWords.some(cw => wordMatches(sw, cw))) overlap++
    }
    const score = overlap / sourceWords.length
    const density = overlap / candidateWords.length
    if (overlap < 2 || score < 0.34 || density < 0.12) continue
    const rank = score + density * 0.25 - Math.abs(160 - spanLen) / 5000
    if (!best || rank > best.rank) best = { ...c, rank, via: 'fuzzy' }
  }

  if (!best) return null
  return { charStart: best.start, charEnd: best.end, via: best.via }
}

function deterministicAnchor(essential, nodes) {
  for (const node of nodes) {
    const a = literalAnchor(node.text, essential.snippet)
    if (a) return { nodeId: node.id, ...a }
  }
  if (process.env.FAST_FUZZY_ANCHORS !== '1') return null

  let best = null
  for (const node of nodes) {
    const a = fuzzyAnchor(node.text, essential.snippet, essential.label)
    if (!a) continue
    const span = a.charEnd - a.charStart
    const score = (a.via === 'fuzzy' ? 0 : 1) - span / 10000
    if (!best || score > best.score) best = { score, anchor: { nodeId: node.id, ...a } }
  }
  return best?.anchor || null
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
const LmaxNodeById = Object.fromEntries(LmaxNodes.map(n => [n.id, n]))

// Older concepts files did not persist `snippet`. Hydrate it from the Lmax
// anchor so generation and cheap anchor placement still get source phrasing.
for (const c of concepts) {
  if (c.snippet) continue
  const a = c.anchors?.[String(Lmax)]
  const node = a ? LmaxNodeById[a.nodeId] : null
  if (node && a.charEnd > a.charStart) c.snippet = node.text.substring(a.charStart, a.charEnd)
}

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
// `targetOverride` lets the adaptive-retry loop aim the model at a tighter
// budget without changing the displayed ratio. Used when the first draft
// overshoots — re-prompting with a lower anchor lands the next draft in
// the real band, which is more reliable than asking the model to trim its
// own long output.
function buildGeneratePrompt(L, visibleEssentials, priorLevelText, targetOverride) {
  const ratio = ratioForLevel(L, Lmax)
  const targetWords = targetOverride || targetWordsForLevel(L)
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

  : (L === 2) ? `You are producing LEVEL 2 — ONE THIRD of the source. Not half, not two-thirds — a third.
At ~33% you have room for scene-level texture, but you must CHOOSE which scenes carry weight. Not every exchange gets verbatim dialogue — pick the two or three lines that matter most and paraphrase the rest. Not every beat gets a scene — some beats are a single sentence. Secondary characters appear by name only when they advance the piece.
Cut aggressively: repeated emphasis, atmospheric detail that doesn't change the reader's understanding, side-scenes, dialogue that's not load-bearing, description that reinforces a fact already established. If your draft feels like "most of the source, slightly trimmed," you're writing L3 or L4 — go further.`

  : (L === 3) ? `You are producing LEVEL 3 — HALF the source. Half means half: a reader who already read L2 should feel they've gained meaningful new texture, not just restored prose.
Most scenes survive in compressed form. Key dialogue is verbatim; secondary dialogue is paraphrased or cut. Sensory and atmospheric detail is present where it grounds the reader, not where it only enriches.
Cut: repeated emphasis, passages that say the same thing twice, description that overstays its welcome, subplot machinery. If your draft is >55% of the source, cut a pass.`

  : (L === 4) ? `You are producing LEVEL 4 — THREE QUARTERS of the source. One word in four is gone.
The reader sees nearly-full prose, but the compression is real and consistent. Trim wherever the source is verbose: repeated emphasis, adjective stacking, long atmospheric passages that restate what an earlier sentence established, belabored interior monologue. Every scene and beat from the source is present, but each one is meaningfully tighter.
If your draft is ≥90% of the source length, you haven't compressed — you've lightly edited. Cut until the target is hit.`

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

Target length: ${targetWords} words. Acceptable band: ${Math.round(targetWords * 0.9)}–${Math.round(targetWords * 1.10)} words. Anything over that is a failure.

Word count is a contract with the reader. They scrolled to THIS level because they want EXACTLY this much depth. A draft at 120% of target is a different level than what they asked for. Count your words before you finish; if over, cut.

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

function buildBatchGeneratePrompt(levels) {
  const sortedLevels = [...levels].sort((a, b) => a - b)
  const levelSpecs = sortedLevels.map(L => {
    const ratio = Math.round(ratioForLevel(L, Lmax) * 100)
    const target = targetWordsForLevel(L)
    const visible = concepts.filter(c => (c.min_visible_level ?? tree.levelCount) <= L)
    return `L${L}: ~${ratio}% / ${target} words (${Math.round(target * 0.9)}-${Math.round(target * 1.10)} acceptable), include ${visible.length} visible essentials`
  }).join('\n')

  const essentialsBlock = concepts.map(e => {
    const src = e.snippet ? ` source="${e.snippet.substring(0, 140)}${e.snippet.length > 140 ? '...' : ''}"` : ''
    return `- minL${e.min_visible_level}: [${e.id}] ${e.label}${src}`
  }).join('\n')

  return `You are producing multiple levels for a semantic-zoom reader.

The output must be the SAME piece at different compression levels: same voice,
same POV, same tense, same register, source order preserved. This is
distillation, not summary. Do not write "the author", "the essay argues", "the
story opens", headings, bullets, or meta-commentary inside any level.

Compression ladder:
${levelSpecs}

Word count is part of the product. Do not undershoot or overshoot the listed
acceptable bands; a level that is too short or too long behaves like the wrong
zoom level.

Level intent:
- L0 is the poker-nuts level: only the load-bearing spine, but still the piece.
- L1 is hard compression with connective tissue and recognizable voice.
- L2 restores scene/argument texture, but cuts repetition and side material.
- L3 is about half the source.
- L4 is near-full prose with real trimming.

For each level, include only essentials whose minL is <= that level. Higher
detail levels should naturally include everything visible at lower levels plus
the newly visible details.

Thematic compass: ${thematicThrust || '(not set)'}
Genre: ${genreInfo.genre || 'unknown'}

Essentials:
${essentialsBlock || '(none)'}

Source:
"""
${LmaxText}
"""

Return exactly these marked sections, one per requested level. The text inside
each section is the level text itself. No markdown fences.

${sortedLevels.map(L => `<<LEVEL ${L}>>\n[write level ${L} here]\n<<END LEVEL ${L}>>`).join('\n\n')}`
}

function parseBatchLevelTexts(raw, levels) {
  const parsed = new Map()
  if (!raw) return parsed
  for (const L of levels) {
    const re = new RegExp(`<<LEVEL\\s+${L}>>\\s*([\\s\\S]*?)\\s*<<END\\s+LEVEL\\s+${L}>>`, 'i')
    const m = raw.match(re)
    if (!m) continue
    const cleaned = m[1]
      .replace(/\n\s*\*?\s*\d+\s*words[\s\S]*$/im, '')
      .trim()
    if (cleaned) parsed.set(L, cleaned)
  }
  return parsed
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

const generatedTextByLevel = new Map()
if (batchGenerate && !anchorsOnly && levelsToProcess.length > 1) {
  const raw = await callClaudeAsync(buildBatchGeneratePrompt(levelsToProcess), 'gen:batch')
  const parsed = parseBatchLevelTexts(raw, levelsToProcess)
  for (const L of levelsToProcess) {
    if (!parsed.has(L)) continue
    generatedTextByLevel.set(L, parsed.get(L))
    const wc = parsed.get(L).split(/\s+/).filter(Boolean).length
    console.log(`  [gen:L${L}:batch] ${wc} words`)
  }
  if (generatedTextByLevel.size === 0) {
    console.warn('  [gen:batch] no levels parsed; falling back to per-level generation')
  } else if (generatedTextByLevel.size < levelsToProcess.length) {
    console.warn(`  [gen:batch] parsed ${generatedTextByLevel.size}/${levelsToProcess.length} levels; missing levels will fall back`)
  }
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

// Per-level pipeline: each level's gen → (adaptive retry) → anchor is an
// independent task (no telephone — every level generates from L_max source
// directly). Fan them out in parallel; wall time is determined by the
// slowest level, not the sum.
//
// `priorLevelText` from the old serial loop is dropped — it was never
// consumed as a hard dependency (just a phrasing hint passed into the gen
// prompt), and preserving it would force sequential ordering. If a future
// pass wants cross-level phrasing coherence, do it as a post-hoc pass
// after all levels finish, not as an in-loop dep.
async function processLevel(L) {
  const visibleEssentials = concepts.filter(c => (c.min_visible_level ?? tree.levelCount) <= L)
  console.log(`\n=== L${L} — ${visibleEssentials.length} visible essentials${anchorsOnly ? ' (anchors-only mode)' : ''} ===`)

  let text = null
  const existingNodes = tree.levels[String(L)]?.nodes || []
  if (anchorsOnly && existingNodes.length > 0) {
    text = existingNodes.map(n => n.text).join('\n\n')
    console.log(`  [L${L}] anchors-only: using existing ${existingNodes.length} nodes (${text.split(/\s+/).length} words)`)
  } else if (generatedTextByLevel.has(L)) {
    text = generatedTextByLevel.get(L)
    console.log(`  [L${L}] using batch-generated text (${text.split(/\s+/).filter(Boolean).length} words)`)
  } else {
    // 1) GENERATE with adaptive-target retry (serial within a level, since
    //    each retry needs the prior draft's word count).
    const targetW = targetWordsForLevel(L)
    const hardCap = Math.round(targetW * 1.10)
    // Floor on adaptive tightening: never tell the model to write below 85%
    // of original target. Without this, a big overshoot can make the retry
    // target absurdly low, and the retry lands the level right next to the
    // one below (collapse). Observed: L4 at 1008w → naive retry target 472w
    // → actual 485w, collapsing into L3 at 464w.
    const retryFloor = Math.round(targetW * 0.85)
    const MAX_ATTEMPTS = 3
    let effectiveTarget = targetW
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const draft = await callClaudeAsync(
        buildGeneratePrompt(L, visibleEssentials, null, effectiveTarget),
        `gen:L${L}:a${attempt}`
      )
      if (!draft) { console.warn(`  [L${L}] gen attempt ${attempt} failed`); break }
      // Strip trailing meta-commentary the model sometimes appends despite
      // the prompt's "no meta-commentary" rule. Common tell: a paragraph
      // starting with "*N words" (word count announcement).
      const cleaned = draft.replace(/\n\s*\*?\s*\d+\s*words[\s\S]*$/im, '').trim()
      const draftW = cleaned.split(/\s+/).filter(Boolean).length
      text = cleaned
      if (draftW <= hardCap) break
      if (attempt < MAX_ATTEMPTS) {
        const overshoot = draftW / targetW
        effectiveTarget = Math.max(retryFloor, Math.round(targetW / overshoot * 0.95))
        console.log(`  [L${L}] attempt ${attempt}: ${draftW}w > cap ${hardCap}w — retry with tightened target ${effectiveTarget}`)
      } else {
        console.log(`  [L${L}] attempt ${attempt}: ${draftW}w > cap ${hardCap}w — MAX ATTEMPTS REACHED, keeping draft`)
      }
    }
    if (!text) { console.warn(`  [L${L}] generation failed`); return { L, ok: false } }
  }

  // 2) CHUNK into nodes
  let newNodes
  if (anchorsOnly && existingNodes.length > 0) {
    newNodes = existingNodes
  } else {
    newNodes = chunkIntoNodes(text, L)
    console.log(`  [L${L}] wrote ${newNodes.length} node${newNodes.length > 1 ? 's' : ''} (${text.split(/\s+/).length} words)`)
  }

  // 3) ANCHOR — single call per level, ALL essentials at once.
  // Old code batched into groups of 6 as a workaround for subprocess
  // timeouts; with --bare + --effort medium those are gone.
  const anchorMap = {}
  const nodeByIdMap = Object.fromEntries(newNodes.map(n => [n.id, n]))
  let deterministicAnchored = 0
  for (const e of visibleEssentials) {
    const a = deterministicAnchor(e, newNodes)
    if (!a) continue
    anchorMap[e.id] = a
    deterministicAnchored++
  }

  const unresolvedEssentials = visibleEssentials.filter(e => !anchorMap[e.id])
  if (deterministicAnchored > 0) {
    console.log(`  [L${L}] deterministic anchors: ${deterministicAnchored}/${visibleEssentials.length}`)
  }
  if (unresolvedEssentials.length > 0) {
    const raw = await callClaudeAsync(
      buildAnchorPrompt(L, text, newNodes, unresolvedEssentials),
      `anchor:L${L}`
    )
    const parsed = parseJson(raw) || {}
    for (const k of Object.keys(parsed)) anchorMap[k] = parsed[k]
  } else if (visibleEssentials.length > 0) {
    console.log(`  [L${L}] anchor Claude call skipped; deterministic placement covered all visible essentials`)
  }

  const anchors = {}
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
    anchors[e.id] = { nodeId, charStart: cs, charEnd: ce }
    anchored++
  }
  console.log(`  [L${L}] anchored ${anchored}/${visibleEssentials.length} essentials`)

  return { L, ok: true, newNodes, anchors, writeNodes: !(anchorsOnly && existingNodes.length > 0) }
}

// Fan out all levels in parallel.
const results = await Promise.all(levelsToProcess.map(processLevel))

// Stitch results back into tree + anchors (done after all finish so we don't
// race on shared mutation during parallel execution).
for (const r of results) {
  if (!r || !r.ok) continue
  if (r.writeNodes) tree.levels[String(r.L)].nodes = r.newNodes
  for (const id of Object.keys(r.anchors)) {
    anchorsByConcept[id][String(r.L)] = r.anchors[id]
  }
}

// ---------- write ----------
// Rebuild linear parent/child links before phrase maps so matchIn/matchOut can
// stay tree-constrained after direct source-to-level regeneration.
const childLinkResult = rebuildLinearChildLinks(tree)
console.log(`\nRebuilt child links: ${childLinkResult.totalLinks} links`)

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

// Level-collapse detection: adjacent levels should differ enough that the
// user experiences a real compression step. If Lk is within 10% of Lk+1,
// that level doesn't earn its place — user either drops it or retunes.
// L5 is the unabridged reference; if L4 is >90% of L5, L4 is essentially
// a near-verbatim copy and the "Lmax is the source" contract erodes.
console.log('\nLevel-spacing check (word-count ratios to next level):')
const wordsAtLevel = {}
for (let L = 0; L <= Lmax; L++) {
  wordsAtLevel[L] = tree.levels[String(L)].nodes
    .map(n => n.text).join(' ').split(/\s+/).filter(Boolean).length
}
let anyCollapse = false
for (let L = 0; L < Lmax; L++) {
  const ratio = wordsAtLevel[L] / wordsAtLevel[L + 1]
  const pct = (ratio * 100).toFixed(0)
  const flag = ratio > 0.90 ? '  ⚠ COLLAPSE (>90%) — this level is not meaningfully more concise than L' + (L + 1) : ''
  if (ratio > 0.90) anyCollapse = true
  console.log(`  L${L}/L${L + 1}: ${wordsAtLevel[L]}/${wordsAtLevel[L + 1]} = ${pct}%${flag}`)
}
if (anyCollapse) {
  console.log('\n⚠ One or more levels collapsed to their neighbor. Decide: drop the level, or retune its prompt.')
}

// Phrase-chain maps. Regenerating the tree wipes any stale phrases, so
// rebuild them here — the zoom fallback uses matchIn/matchOut to
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
