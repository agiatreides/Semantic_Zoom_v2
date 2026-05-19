import { measureLevel } from './text-layout.js'
import { createRenderer } from './renderer.js'

const FONT = '18px Georgia, serif'
const LINE_HEIGHT = 28
const COLUMN_WIDTH = 640
const NODE_GAP = 24
let MAX_LEVEL = 9
const TRANSITION_SPEED = 0.12
const SCROLL_THRESHOLD = 80

let treeData = null
let concepts = []
let measuredLevels = {}
let levelHeights = {}
let currentLevel = 0
let displayLevel = 0
let mouseX = 0
let mouseY = 0
let levelOffsets = {}

let offsetsLocked = false
let lockTimer = 0
let scrollAccum = 0

// Scrollbar state (right-gutter, canvas-drawn)
const SB_WIDTH = 10
const SB_RIGHT_MARGIN = 4
const SB_MIN_THUMB = 30
let sbHover = false
let sbDragging = false
let sbDragStartY = 0
let sbDragStartOffsetY = 0

let hoveredConcept = null
let hoveredWord = null
let phrasesAtLevel = {}
let trackedConcept = null    // locked during a continuous wheel-zoom session; cleared on mousemove
let trackedWord = null       // the exact word the user is hovering; preferred landing target at every zoom level
                             // (e.g. 'not' — if it literally exists in the target anchor's text, land there)

const canvas = document.getElementById('viewport')
const renderer = createRenderer(canvas)

// ========== MEASUREMENT ==========

function measureAllLevels(tree) {
  const measured = {}, heights = {}
  for (let i = 0; i <= MAX_LEVEL; i++) {
    const ld = tree.levels[String(i)]
    if (!ld) continue
    measured[i] = measureLevel(ld.nodes, FONT, COLUMN_WIDTH, LINE_HEIGHT, NODE_GAP)
    const nodes = measured[i]
    heights[i] = nodes.length > 0 ? nodes[nodes.length - 1].y + nodes[nodes.length - 1].height : 0
  }
  return { measured, heights }
}

// ========== PHRASE INDEX (semantic zoom anchoring) ==========

function phraseYFromLines(mNode, charStart) {
  let acc = 0
  for (let i = 0; i < mNode.lines.length; i++) {
    if (acc + mNode.lines[i].text.length > charStart) {
      return mNode.y + i * LINE_HEIGHT
    }
    acc += mNode.lines[i].text.length
  }
  return mNode.y + (mNode.lines.length - 1) * LINE_HEIGHT
}

function buildPhraseIndex(tree, measured) {
  phrasesAtLevel = {}
  for (let L = 0; L <= MAX_LEVEL; L++) {
    const levelData = tree.levels[String(L)]
    if (!levelData) continue
    const phrases = []
    for (const node of levelData.nodes) {
      if (!node.phrases) continue
      const mNode = measured[L]?.find(n => n.nodeId === node.id)
      for (const p of node.phrases) {
        phrases.push({
          ...p,
          nodeId: node.id,
          y: mNode ? phraseYFromLines(mNode, p.charStart) : 0
        })
      }
    }
    phrasesAtLevel[L] = phrases
  }
}

function findPhraseAtCursor(level, contentY, contentX) {
  const phrases = phrasesAtLevel[level]
  if (!phrases || phrases.length === 0) return null

  // Step 1: find which node and line the cursor is on
  const nodes = measuredLevels[level]
  if (!nodes) return null

  let cursorNode = null
  for (const node of nodes) {
    if (contentY >= node.y && contentY < node.y + node.height) { cursorNode = node; break }
  }
  if (!cursorNode) {
    // Snap to nearest node
    let bestDist = Infinity
    for (const node of nodes) {
      const mid = node.y + node.height / 2
      const dist = Math.abs(contentY - mid)
      if (dist < bestDist) { bestDist = dist; cursorNode = node }
    }
  }
  if (!cursorNode) return null

  const lineIdx = Math.max(0, Math.min(cursorNode.lines.length - 1,
    Math.floor((contentY - cursorNode.y) / LINE_HEIGHT)))

  // Step 2: estimate character position from line + X
  let lineStartChar = 0
  for (let i = 0; i < lineIdx; i++) lineStartChar += cursorNode.lines[i].text.length
  const line = cursorNode.lines[lineIdx]
  const xFrac = line.width > 0 ? Math.max(0, Math.min(1, contentX / line.width)) : 0
  const cursorChar = lineStartChar + Math.floor(xFrac * line.text.length)

  // Step 3: find the phrase whose charStart-charEnd range contains cursorChar
  const nodeId = cursorNode.nodeId
  let best = null, bestDist = Infinity
  for (const p of phrases) {
    if (p.nodeId !== nodeId) continue
    // Distance: 0 if cursor is inside the phrase range, else distance to nearest edge
    let dist
    if (cursorChar >= p.charStart && cursorChar <= p.charEnd) {
      dist = 0
    } else {
      dist = Math.min(Math.abs(cursorChar - p.charStart), Math.abs(cursorChar - p.charEnd))
    }
    if (dist < bestDist) { bestDist = dist; best = p }
  }

  return best
}

// ========== CONCEPT LOOKUP ==========

function findConceptAtCursor(level, offsets) {
  const nodes = measuredLevels[level]
  if (!nodes || concepts.length === 0) return null

  const contentY = mouseY - offsets.y
  const screenW = renderer.width
  const baseLeftX = (screenW - COLUMN_WIDTH) / 2
  const contentX = mouseX - baseLeftX - offsets.x

  let cursorNodeId = null
  let cursorCharIdx = 0

  // Prefer hitTestWord's exact char index — it scans real word widths and
  // returns the word directly under cursor. Linear X-ratio (fallback below)
  // can miss the right word by dozens of chars on wide lines with varying
  // glyph widths, which miscounts containment on short anchor spans.
  const hit = hitTestWord(level, offsets)
  if (hit) {
    cursorNodeId = hit.nodeId
    cursorCharIdx = Math.floor((hit.charStart + hit.charEnd) / 2)
  }

  if (!cursorNodeId) {
    for (const node of nodes) {
      if (contentY >= node.y && contentY < node.y + node.height) {
        cursorNodeId = node.nodeId
        const lineIdx = Math.max(0, Math.min(node.lines.length - 1,
          Math.floor((contentY - node.y) / LINE_HEIGHT)))
        let charsBeforeLine = 0
        for (let li = 0; li < lineIdx; li++) charsBeforeLine += node.lines[li].text.length
        const line = node.lines[lineIdx]
        if (line && line.width > 0) {
          const charRatio = Math.max(0, Math.min(1, contentX / line.width))
          cursorCharIdx = charsBeforeLine + Math.floor(charRatio * line.text.length)
        } else {
          cursorCharIdx = charsBeforeLine
        }
        break
      }
    }
  }

  if (!cursorNodeId) return null

  const lvlStr = String(level)

  // Pass 1: exact char-range containment. Pick the SHORTEST containing anchor
  // when concepts overlap — most specific wins.
  let containing = null
  for (const concept of concepts) {
    const anchor = concept.anchors[lvlStr]
    if (!anchor || anchor.nodeId !== cursorNodeId) continue
    if (cursorCharIdx >= anchor.charStart && cursorCharIdx <= anchor.charEnd) {
      const span = anchor.charEnd - anchor.charStart
      if (!containing || span < containing.span) containing = { concept, span }
    }
  }
  if (containing) return containing.concept

  // Pass 1.5: semantic word fallback. When the cursor is on unanchored
  // text, the exact word under the cursor is still a strong intent signal.
  // Match that word against each concept's label/snippet/anchor text, then
  // prefer the closest current-level anchor when one exists.
  const wordMatched = findConceptByWord(hit?.word, level, contentY)
  if (wordMatched) return wordMatched

  // Pass 2: PHRASE-CHAIN PROJECTION.
  // The cursor sits on unanchored content (most of the story at L0/L1 under
  // the poker-nuts rule). Project the cursor's phrase through matchIn to
  // L_max and ask: at full resolution, what concept does this semantic
  // position belong to? That concept may have no anchor at the current level
  // — that's fine, it's still the right identity for the zoom session.
  // No stem-matching, no spatial proximity — purely embedding chain.
  const phrase = findPhraseAtCursor(level, contentY, contentX)
  if (!phrase) return null
  const Lmax = Object.keys(measuredLevels).map(Number).reduce((a, b) => Math.max(a, b), 0)
  let pL = level, pIdx = phrasesAtLevel[level].indexOf(phrase)
  while (pL < Lmax && pIdx >= 0) {
    const p = phrasesAtLevel[pL][pIdx]
    if (!p || p.matchIn == null || p.matchIn < 0) break
    pIdx = p.matchIn
    pL++
  }
  if (pL !== Lmax || pIdx < 0) return null
  const projected = phrasesAtLevel[Lmax][pIdx]
  if (!projected) return null
  const pMid = Math.floor((projected.charStart + projected.charEnd) / 2)
  for (const concept of concepts) {
    const anchor = concept.anchors[String(Lmax)]
    if (!anchor || anchor.nodeId !== projected.nodeId) continue
    if (pMid >= anchor.charStart && pMid <= anchor.charEnd) return concept
  }
  return null
}

function cleanWord(word) {
  return (word || '').replace(/^[^\w'-]+|[^\w'-]+$/g, '').toLowerCase()
}

function tokenizeWords(text) {
  const words = []
  const re = /[\w'-]+/g
  let m
  while ((m = re.exec(text || '')) !== null) words.push(m[0].toLowerCase())
  return words
}

function wordMatchTier(target, words) {
  const clean = cleanWord(target)
  if (clean.length < 3 || words.length === 0) return null
  if (words.includes(clean)) return 0
  if (clean.length >= 4 && words.some(w => w.length >= 4 && w.startsWith(clean.substring(0, 4)))) return 1
  if (clean.length >= 4 && words.some(w => w.length >= 4 && (w.includes(clean) || clean.includes(w)))) return 2
  return null
}

function anchorText(concept, level) {
  const anchor = concept.anchors?.[String(level)]
  if (!anchor) return ''
  const node = treeData?.levels?.[String(level)]?.nodes?.find(n => n.id === anchor.nodeId)
  return node ? node.text.substring(anchor.charStart, anchor.charEnd) : ''
}

function conceptSearchWords(concept) {
  const Lmax = Object.keys(measuredLevels).map(Number).reduce((a, b) => Math.max(a, b), 0)
  const parts = [concept.label, concept.snippet, anchorText(concept, Lmax)]
  return tokenizeWords(parts.filter(Boolean).join(' '))
}

function conceptAnchorYDistance(concept, level, contentY) {
  if (!concept.anchors?.[String(level)]) return Infinity
  const pos = getConceptCenterPosition(concept, level)
  return pos ? Math.abs(pos.contentY - contentY) : Infinity
}

function findConceptByWord(word, level, contentY) {
  const clean = cleanWord(word)
  if (clean.length < 3) return null

  const candidates = []
  for (const concept of concepts) {
    const tier = wordMatchTier(clean, conceptSearchWords(concept))
    if (tier == null) continue
    const distance = conceptAnchorYDistance(concept, level, contentY)
    const visiblePenalty = concept.anchors?.[String(level)] ? 0 : 1
    const minVisible = concept.min_visible_level ?? 0
    const hiddenPenalty = level < minVisible ? 1 : 0
    const span = concept.anchors?.[String(level)]
      ? concept.anchors[String(level)].charEnd - concept.anchors[String(level)].charStart
      : Infinity
    const score = { tier, visiblePenalty, hiddenPenalty, distance, span }
    candidates.push({ concept, score })
  }

  if (candidates.length === 0) return null

  const hasCurrentAnchor = candidates.some(c => c.score.visiblePenalty === 0)
  const eligible = hasCurrentAnchor ? candidates.filter(c => c.score.visiblePenalty === 0) : candidates
  // If the word maps to several concepts and none has a current-level anchor,
  // phrase projection has better local context than first-match ordering.
  if (!hasCurrentAnchor && eligible.length > 1) return null

  let best = null
  for (const candidate of eligible) {
    const { concept, score } = candidate
    if (!best ||
      score.tier < best.score.tier ||
      (score.tier === best.score.tier && score.visiblePenalty < best.score.visiblePenalty) ||
      (score.tier === best.score.tier && score.visiblePenalty === best.score.visiblePenalty && score.hiddenPenalty < best.score.hiddenPenalty) ||
      (score.tier === best.score.tier && score.visiblePenalty === best.score.visiblePenalty && score.hiddenPenalty === best.score.hiddenPenalty && score.distance < best.score.distance) ||
      (score.tier === best.score.tier && score.visiblePenalty === best.score.visiblePenalty && score.hiddenPenalty === best.score.hiddenPenalty && score.distance === best.score.distance && score.span < best.score.span)) {
      best = { concept, score }
    }
  }
  return best?.concept ?? null
}

function getConceptPosition(concept, level) {
  const anchor = concept.anchors[String(level)]
  if (!anchor) return null

  const nodes = measuredLevels[level]
  if (!nodes) return null

  const node = nodes.find(n => n.nodeId === anchor.nodeId)
  if (!node) return null

  let charsAcc = 0
  for (let li = 0; li < node.lines.length; li++) {
    const lineChars = node.lines[li].text.length
    if (charsAcc + lineChars >= anchor.charStart || li === node.lines.length - 1) {
      const contentY = node.y + li * LINE_HEIGHT
      const charInLine = anchor.charStart - charsAcc
      const prefix = node.lines[li].text.substring(0, Math.min(charInLine, node.lines[li].text.length))
      const contentX = renderer.measureText(prefix, FONT)
      return { contentY, contentX }
    }
    charsAcc += lineChars
  }

  return { contentY: node.y, contentX: 0 }
}

// Content-space position for a specific character index within a node. Used
// by both getConceptCenterPosition (midpoint of anchor) and getConceptWordPosition
// (a specific word within the anchor).
function positionAtCharIdx(node, charIdx) {
  let charsAcc = 0
  for (let li = 0; li < node.lines.length; li++) {
    const lineChars = node.lines[li].text.length
    if (charsAcc + lineChars >= charIdx || li === node.lines.length - 1) {
      const contentY = node.y + li * LINE_HEIGHT + LINE_HEIGHT / 2
      const charInLine = charIdx - charsAcc
      const prefix = node.lines[li].text.substring(0, Math.max(0, Math.min(charInLine, node.lines[li].text.length)))
      const contentX = renderer.measureText(prefix, FONT)
      return { contentY, contentX }
    }
    charsAcc += lineChars
  }
  return { contentY: node.y + LINE_HEIGHT / 2, contentX: 0 }
}

function overlapPenaltyAtChar(concept, level, nodeId, charIdx) {
  const target = concept.anchors[String(level)]
  const targetSpan = target.charEnd - target.charStart
  let count = 0
  let weight = 0
  for (const other of concepts) {
    if (other === concept) continue
    const a = other.anchors?.[String(level)]
    if (!a || a.nodeId !== nodeId) continue
    if (charIdx < a.charStart || charIdx > a.charEnd) continue
    const span = a.charEnd - a.charStart
    // Longer enclosing anchors will lose to this target in findConceptAtCursor.
    // Penalize only anchors that are as specific or more specific.
    if (span <= targetSpan) {
      count++
      weight += 1 / Math.max(1, span)
    }
  }
  return { count, weight }
}

function preferredAnchorChar(concept, level, node) {
  const anchor = concept.anchors[String(level)]
  const start = anchor.charStart
  const end = anchor.charEnd
  const mid = Math.floor((start + end) / 2)
  const candidates = new Set([
    mid,
    Math.floor(start + (end - start) * 0.25),
    Math.floor(start + (end - start) * 0.4),
    Math.floor(start + (end - start) * 0.6),
    Math.floor(start + (end - start) * 0.75),
    Math.min(end, start + 12),
    Math.max(start, end - 12),
  ])

  const anchorText = node.text.substring(start, end)
  const re = /[\w'-]+/g
  let m
  while ((m = re.exec(anchorText)) !== null) {
    candidates.add(start + m.index + Math.floor(m[0].length / 2))
  }

  let best = null
  for (const raw of candidates) {
    const charIdx = Math.max(start, Math.min(end, raw))
    const penalty = overlapPenaltyAtChar(concept, level, anchor.nodeId, charIdx)
    const centerDist = Math.abs(charIdx - mid)
    const edgeDist = Math.min(Math.abs(charIdx - start), Math.abs(end - charIdx))
    const edgePenalty = edgeDist < 2 ? 1 : 0
    const score = { overlapCount: penalty.count, overlapWeight: penalty.weight, edgePenalty, centerDist }
    if (!best ||
      score.overlapCount < best.score.overlapCount ||
      (score.overlapCount === best.score.overlapCount && score.overlapWeight < best.score.overlapWeight) ||
      (score.overlapCount === best.score.overlapCount && score.overlapWeight === best.score.overlapWeight && score.edgePenalty < best.score.edgePenalty) ||
      (score.overlapCount === best.score.overlapCount && score.overlapWeight === best.score.overlapWeight && score.edgePenalty === best.score.edgePenalty && score.centerDist < best.score.centerDist)) {
      best = { charIdx, score }
    }
  }
  return best?.charIdx ?? mid
}

// Position of a representative character in the anchor span. Prefer the
// center, but avoid positions covered by a more-specific nested concept.
function getConceptCenterPosition(concept, level) {
  const anchor = concept.anchors[String(level)]
  if (!anchor) return null
  const nodes = measuredLevels[level]
  if (!nodes) return null
  const node = nodes.find(n => n.nodeId === anchor.nodeId)
  if (!node) return null
  return positionAtCharIdx(node, preferredAnchorChar(concept, level, node))
}

// If `word` (or a stem-equivalent) appears inside the concept's anchor
// text at `level`, return the screen-content-space position of that
// occurrence. Otherwise null. The wheel handler prefers this over the
// anchor midpoint when the user's hovered word survives across levels.
//
// Matching tiers, in order:
//   1. exact case-insensitive word-boundary match  ("not" = "not")
//   2. stem match via 4-char common prefix        ("cheating" ≈ "cheated")
//   3. substring containment either direction      ("log" ⊂ "logs")
// The first tier match wins; we don't search for "best" across tiers.
// hintCharAtLevel: phrase-chain-projected target char in the anchor node's text
//   at `level`. When multiple occurrences of `word` live inside the anchor,
//   pick the one nearest the hint — that resolves Maya-mention-1 vs Maya-
//   mention-4 by semantic projection rather than first-wins.
function getConceptWordPosition(concept, level, word, hintCharAtLevel) {
  if (!word || word.length < 2) return null
  const anchor = concept.anchors[String(level)]
  if (!anchor) return null
  const nodes = measuredLevels[level]
  if (!nodes) return null
  const node = nodes.find(n => n.nodeId === anchor.nodeId)
  if (!node) return null

  const anchorText = node.text.substring(anchor.charStart, anchor.charEnd)
  const clean = word.replace(/^[^\w'-]+|[^\w'-]+$/g, '').toLowerCase()
  if (clean.length < 2) return null

  const re = /[\w'-]+/g
  const words = []
  let m
  while ((m = re.exec(anchorText)) !== null) {
    words.push({ text: m[0], textLc: m[0].toLowerCase(), offset: m.index })
  }
  if (words.length === 0) return null

  const pick = (matches) => {
    if (matches.length === 0) return null
    if (matches.length === 1 || hintCharAtLevel == null) {
      const w = matches[0]
      const mid = w.offset + Math.floor(w.text.length / 2)
      return positionAtCharIdx(node, anchor.charStart + mid)
    }
    // Multiple matches: pick whichever absolute char index is closest to the hint.
    let best = matches[0], bestDist = Infinity
    for (const w of matches) {
      const mid = anchor.charStart + w.offset + Math.floor(w.text.length / 2)
      const dist = Math.abs(mid - hintCharAtLevel)
      if (dist < bestDist) { bestDist = dist; best = w }
    }
    const mid = best.offset + Math.floor(best.text.length / 2)
    return positionAtCharIdx(node, anchor.charStart + mid)
  }

  // Tier 1: exact
  const exact = words.filter(w => w.textLc === clean)
  if (exact.length) return pick(exact)

  // Tier 2: stem via 4-char prefix
  if (clean.length >= 4) {
    const stem = clean.substring(0, 4)
    const stemMatches = words.filter(w => w.textLc.length >= 4 && w.textLc.startsWith(stem))
    if (stemMatches.length) return pick(stemMatches)
  }

  // Tier 3: substring containment
  if (clean.length >= 4) {
    const subMatches = words.filter(w => w.textLc.length >= 4 && (w.textLc.includes(clean) || clean.includes(w.textLc)))
    if (subMatches.length) return pick(subMatches)
  }

  return null
}

// ========== HIT TESTING ==========

function hitTestWord(level, offsets) {
  const nodes = measuredLevels[level]
  if (!nodes) return null
  const contentY = mouseY - offsets.y
  const screenW = renderer.width
  const baseLeftX = (screenW - COLUMN_WIDTH) / 2
  const contentX = mouseX - baseLeftX - offsets.x
  if (contentX < 0 || contentX > COLUMN_WIDTH) return null

  let hitNode = null
  for (const node of nodes) {
    if (contentY >= node.y && contentY < node.y + node.height) { hitNode = node; break }
  }
  if (!hitNode) return null

  const lineIdx = Math.floor((contentY - hitNode.y) / LINE_HEIGHT)
  if (lineIdx < 0 || lineIdx >= hitNode.lines.length) return null

  let charsBeforeLine = 0
  for (let li = 0; li < lineIdx; li++) charsBeforeLine += hitNode.lines[li].text.length

  const regex = /(\S+)(\s*)/g
  let match, accWidth = 0
  while ((match = regex.exec(hitNode.lines[lineIdx].text)) !== null) {
    const wt = match[1], tr = match[2]
    const ww = renderer.measureText(wt, FONT)
    const tw = renderer.measureText(tr, FONT)
    if (contentX >= accWidth && contentX < accWidth + ww) {
      return {
        word: wt, nodeId: hitNode.nodeId, lineIdx,
        charStart: charsBeforeLine + match.index,
        charEnd: charsBeforeLine + match.index + wt.length,
        screenRect: {
          x: baseLeftX + offsets.x + accWidth,
          y: hitNode.y + lineIdx * LINE_HEIGHT + offsets.y,
          w: ww, h: LINE_HEIGHT
        }
      }
    }
    accWidth += ww + tw
  }
  return null
}

// ========== OFFSETS ==========

function defaultOffset(level) {
  return { x: 0, y: (renderer.height - (levelHeights[level] || 0)) / 2 }
}

function clampOffset(level, off) {
  const screenH = renderer.height, contentH = levelHeights[level] || 0, pad = 40
  let y = Math.max(-contentH + pad, Math.min(screenH - pad, off.y))
  let x = Math.max(-COLUMN_WIDTH, Math.min(COLUMN_WIDTH, off.x))
  return { x, y }
}

// Scrollbar geometry: thumb reflects how much of CURRENT level's content is
// visible and where in the content the viewport sits. When contentH <= screenH
// there's nothing to scroll, so the bar is hidden.
function getScrollbarGeom(level) {
  const screenH = renderer.height, screenW = renderer.width
  const contentH = levelHeights[level] || 0
  if (contentH <= screenH) return null
  const trackX = screenW - SB_RIGHT_MARGIN - SB_WIDTH
  const trackY = 0
  const trackH = screenH
  const scrollRange = contentH - screenH
  const thumbH = Math.max(SB_MIN_THUMB, (screenH * screenH) / contentH)
  const off = levelOffsets[level] ?? defaultOffset(level)
  // off.y = 0 → top of content at top of screen. off.y = -(contentH-screenH) → bottom.
  const frac = Math.max(0, Math.min(1, -off.y / scrollRange))
  const thumbY = trackY + frac * (trackH - thumbH)
  return { trackX, trackY, trackH, thumbY, thumbH, scrollRange }
}

function isOnScrollbarThumb(x, y, level) {
  const g = getScrollbarGeom(level); if (!g) return false
  return x >= g.trackX && x <= g.trackX + SB_WIDTH && y >= g.thumbY && y <= g.thumbY + g.thumbH
}
function isOnScrollbarTrack(x, y, level) {
  const g = getScrollbarGeom(level); if (!g) return false
  return x >= g.trackX && x <= g.trackX + SB_WIDTH && y >= g.trackY && y <= g.trackY + g.trackH
}

// ========== ZOOM INDICATORS ==========

const particles = []
function spawnZoomIndicator(dir) {
  particles.push({ x: mouseX, y: mouseY + (dir > 0 ? -50 : 50), drift: dir > 0 ? -1.8 : 1.8,
    symbol: dir > 0 ? '+ +' : '– –', life: 1.0, decay: 0.018, scale: 1.0 })
}

function updateAndDrawParticles() {
  const ctx = renderer.ctx, dpr = renderer.dpr
  ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]; p.life -= p.decay; p.y += p.drift; p.scale = 0.85 + 0.3 * p.life
    if (p.life <= 0) { particles.splice(i, 1); continue }
    const a = p.life * p.life, s = 36 * p.scale
    ctx.save(); ctx.globalAlpha = a * 0.25; ctx.font = `800 ${s+8}px system-ui,sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#5bf'
    ctx.shadowColor = '#38f'; ctx.shadowBlur = 30; ctx.fillText(p.symbol, p.x, p.y)
    ctx.fillText(p.symbol, p.x, p.y); ctx.restore()
    ctx.save(); ctx.globalAlpha = a * 0.5; ctx.font = `800 ${s+2}px system-ui,sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#8cf'
    ctx.shadowColor = '#5af'; ctx.shadowBlur = 14; ctx.fillText(p.symbol, p.x, p.y); ctx.restore()
    ctx.save(); ctx.globalAlpha = a * 0.95; ctx.font = `800 ${s}px system-ui,sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'
    ctx.shadowColor = '#6bf'; ctx.shadowBlur = 6; ctx.fillText(p.symbol, p.x, p.y); ctx.restore()
  }
  ctx.restore()
}

// ========== WORD HIGHLIGHT ==========

function drawWordHighlight() {
  if (!hoveredWord?.screenRect) return
  const ctx = renderer.ctx, dpr = renderer.dpr, r = hoveredWord.screenRect
  ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = 'rgba(100,170,255,0.12)'; ctx.fillRect(r.x-2, r.y+2, r.w+4, r.h-4)
  ctx.strokeStyle = 'rgba(120,180,255,0.7)'; ctx.lineWidth = 2
  ctx.shadowColor = 'rgba(100,170,255,0.5)'; ctx.shadowBlur = 8
  ctx.beginPath(); ctx.moveTo(r.x, r.y+r.h-5); ctx.lineTo(r.x+r.w, r.y+r.h-5); ctx.stroke()
  ctx.restore()
}

// ========== INPUT ==========

let mouseDown = false, cursorInTextArea = false

function isInTextArea(x, y) {
  const bx = (renderer.width - COLUMN_WIDTH) / 2
  if (x >= renderer.width - SB_RIGHT_MARGIN - SB_WIDTH - 4) return false
  return x >= bx - 20 && x <= bx + COLUMN_WIDTH + 20 && y >= 0 && y <= renderer.height
}
function isFrozen() { return mouseDown || sbDragging || !cursorInTextArea }

canvas.addEventListener('mousedown', (e) => {
  const x = e.clientX, y = e.clientY
  if (isOnScrollbarThumb(x, y, currentLevel)) {
    sbDragging = true
    sbDragStartY = y
    sbDragStartOffsetY = (levelOffsets[currentLevel] ?? defaultOffset(currentLevel)).y
    e.preventDefault()
    return
  }
  if (isOnScrollbarTrack(x, y, currentLevel)) {
    // Page jump toward click point
    const g = getScrollbarGeom(currentLevel)
    const dir = y < g.thumbY ? -1 : 1
    const page = renderer.height * 0.8
    const off = levelOffsets[currentLevel] ?? defaultOffset(currentLevel)
    levelOffsets[currentLevel] = clampOffset(currentLevel, { x: off.x, y: off.y - dir * page })
    e.preventDefault()
    return
  }
  mouseDown = true
})
canvas.addEventListener('mouseup', () => { mouseDown = false; sbDragging = false })
window.addEventListener('mouseup', () => { mouseDown = false; sbDragging = false })

canvas.addEventListener('wheel', (e) => {
  e.preventDefault()
  if (isFrozen()) return
  if (Math.abs(displayLevel - currentLevel) > 0.5) return

  scrollAccum += e.deltaY
  if (Math.abs(scrollAccum) < SCROLL_THRESHOLD) return
  const direction = scrollAccum > 0 ? 1 : -1
  scrollAccum = 0

  const prevLevel = currentLevel
  if (direction > 0 && currentLevel < MAX_LEVEL) currentLevel++
  else if (direction < 0 && currentLevel > 0) currentLevel--

  if (currentLevel !== prevLevel) {
    const zoomingIn = currentLevel > prevLevel
    spawnZoomIndicator(zoomingIn ? 1 : -1)

    // Two cooperating mechanisms:
    //   Concept track — stable identity across a continuous zoom session.
    //   Phrase chain  — per-phrase matchIn/matchOut from embedding similarity,
    //                   used to (a) pick among multiple word occurrences
    //                   inside the concept's anchor and (b) place the cursor
    //                   when the tracked concept has no anchor at the new
    //                   level (e.g. above its min_visible_level).
    const oldOff = levelOffsets[prevLevel] ?? defaultOffset(prevLevel)
    const baseLeftX = (renderer.width - COLUMN_WIDTH) / 2
    const srcContentY = mouseY - oldOff.y
    const srcContentX = mouseX - baseLeftX - oldOff.x
    let placed = false

    // Phrase-chain projection: follow matchIn/matchOut one step to the new
    // level. Used both as a disambiguation hint and as a fallback placement.
    const srcPhrase = findPhraseAtCursor(prevLevel, srcContentY, srcContentX)
    const targetIdx = zoomingIn ? srcPhrase?.matchIn : srcPhrase?.matchOut
    const projected = (targetIdx != null && targetIdx >= 0)
      ? phrasesAtLevel[currentLevel]?.[targetIdx] ?? null
      : null

    if (!trackedConcept) {
      trackedConcept = findConceptAtCursor(prevLevel, oldOff)
      const hit = hitTestWord(prevLevel, oldOff)
      trackedWord = hit?.word ?? null
    }

    let targetConcept = trackedConcept
    // If the tracked concept has no anchor at the new level, use the
    // phrase-chain projection to place the cursor. Only re-acquire identity
    // when the concept is intentionally invisible at that level; if the data
    // is missing an anchor for a concept that should be visible, keep the
    // lock so it can snap back when the anchor reappears on the next level.
    if (targetConcept && !targetConcept.anchors[String(currentLevel)]) {
      if (projected) {
        levelOffsets[currentLevel] = clampOffset(currentLevel, { x: 0, y: mouseY - projected.y })
        placed = true
      }
      const intentionallyHidden = currentLevel < (targetConcept.min_visible_level ?? 0)
      if (intentionallyHidden) {
        const provisionalOff = levelOffsets[currentLevel] ?? defaultOffset(currentLevel)
        const reacquired = findConceptAtCursor(currentLevel, provisionalOff)
        if (reacquired) {
          trackedConcept = reacquired
          targetConcept = reacquired
        } else {
          targetConcept = null
        }
      } else {
        targetConcept = null
      }
    }

    if (targetConcept && targetConcept.anchors[String(currentLevel)]) {
      // Disambiguate within-anchor using the phrase-chain projection. When
      // the anchor contains multiple occurrences of the tracked word (e.g.
      // anchor mentions "Maya" four times), pick the occurrence nearest the
      // phrase projection, not just the first one.
      const anchor = targetConcept.anchors[String(currentLevel)]
      let hintChar = null
      if (projected && projected.nodeId === anchor.nodeId) {
        hintChar = Math.floor((projected.charStart + projected.charEnd) / 2)
      }
      const wordPos = trackedWord
        ? getConceptWordPosition(targetConcept, currentLevel, trackedWord, hintChar)
        : null
      const pos = wordPos || getConceptCenterPosition(targetConcept, currentLevel)
      if (pos) {
        levelOffsets[currentLevel] = clampOffset(currentLevel, {
          x: mouseX - baseLeftX - pos.contentX,
          y: mouseY - pos.contentY
        })
        placed = true
      }
    }

    // Last resort: pure phrase-chain placement (cursor wasn't on any
    // trackable concept AND the fallback above didn't fire).
    if (!placed && projected) {
      levelOffsets[currentLevel] = clampOffset(currentLevel, { x: 0, y: mouseY - projected.y })
    }

    offsetsLocked = true
    lockTimer = 0
  }
}, { passive: false })

function onMouseMove(e) {
  const movedX = e.clientX, movedY = e.clientY
  // Real cursor motion (>2px) ends the current zoom-tracking session so the
  // next wheel re-acquires whatever concept is now under the cursor.
  if (!sbDragging && (Math.abs(movedX - mouseX) > 2 || Math.abs(movedY - mouseY) > 2)) { trackedConcept = null; trackedWord = null }
  mouseX = movedX; mouseY = movedY

  if (sbDragging) {
    const g = getScrollbarGeom(currentLevel)
    if (g) {
      const travel = g.trackH - g.thumbH
      const dy = movedY - sbDragStartY
      const deltaFrac = travel > 0 ? dy / travel : 0
      const newY = sbDragStartOffsetY - deltaFrac * g.scrollRange
      const off = levelOffsets[currentLevel] ?? defaultOffset(currentLevel)
      levelOffsets[currentLevel] = clampOffset(currentLevel, { x: off.x, y: newY })
    }
    return
  }

  sbHover = isOnScrollbarThumb(movedX, movedY, currentLevel) || isOnScrollbarTrack(movedX, movedY, currentLevel)
  cursorInTextArea = isInTextArea(mouseX, mouseY)
  if (isFrozen() || offsetsLocked) return

  const off = levelOffsets[currentLevel] ?? defaultOffset(currentLevel)
  hoveredWord = hitTestWord(currentLevel, off)
  hoveredConcept = findConceptAtCursor(currentLevel, off)
}
canvas.addEventListener('mousemove', onMouseMove)
window.addEventListener('mousemove', (e) => { if (sbDragging) onMouseMove(e) })

canvas.addEventListener('mouseleave', () => { if (!sbDragging) { cursorInTextArea = false; hoveredWord = null; hoveredConcept = null; trackedConcept = null; trackedWord = null; sbHover = false } })
window.addEventListener('resize', () => renderer.resize())

// ========== HUD ==========

function generateLevelNames(count) {
  if (count <= 1) return ['original']
  if (count === 2) return ['overview', 'original']
  if (count === 3) return ['thesis', 'summary', 'original']
  const names = ['thesis']
  const middle = count - 2
  for (let i = 0; i < middle; i++) {
    const ratio = (i + 1) / (middle + 1)
    if (ratio < 0.25) names.push('overview')
    else if (ratio < 0.5) names.push('summary')
    else if (ratio < 0.75) names.push('expanded')
    else names.push('detailed')
  }
  names.push('original')
  const seen = {}
  return names.map(n => { seen[n] = (seen[n] || 0) + 1; return seen[n] > 1 ? `${n}-${seen[n]}` : n })
}

function drawHUD() {
  const ctx = renderer.ctx, dpr = renderer.dpr
  const w = canvas.clientWidth, h = canvas.clientHeight
  ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.font = '13px monospace'; ctx.textBaseline = 'bottom'

  const names = treeData?.levelNames || generateLevelNames(MAX_LEVEL + 1)
  ctx.fillStyle = 'rgba(255,255,255,0.35)'
  ctx.fillText(`Level ${currentLevel} — ${names[currentLevel] || `level-${currentLevel}`}`, 16, h - 12)

  const nodes = measuredLevels[currentLevel]
  if (nodes) {
    const words = nodes.reduce((s,n) => s + n.text.split(/\s+/).length, 0)
    const total = measuredLevels[MAX_LEVEL] ? measuredLevels[MAX_LEVEL].reduce((s,n) => s + n.text.split(/\s+/).length, 0) : words
    ctx.fillText(`${words} / ${total} words`, 16, h - 30)
  }

  if (hoveredWord) { ctx.fillStyle = 'rgba(120,180,255,0.5)'; ctx.fillText(`→ ${hoveredWord.word}`, 16, h - 48) }
  // Prefer the live-detected concept, except while tracking through a level
  // where the concept should be visible but its anchor is missing from data.
  const trackedAnchorGap = trackedConcept &&
    !trackedConcept.anchors?.[String(currentLevel)] &&
    currentLevel >= (trackedConcept.min_visible_level ?? 0)
  const labelConcept = trackedAnchorGap ? trackedConcept : (hoveredConcept || trackedConcept)
  if (labelConcept) {
    const dim = hoveredConcept ? 'rgba(255,200,100,0.5)' : 'rgba(255,200,100,0.25)'
    ctx.fillStyle = dim
    ctx.fillText(`◆ ${labelConcept.label}`, 16, h - 66)
  }

  ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(255,255,255,0.2)'
  ctx.fillText('Scroll: zoom  |  Drag scrollbar: pan  |  Move cursor: navigate', w - 16, h - 12)
  ctx.restore()
}

// ========== RENDER ==========

function smoothstep(t) { return t * t * (3 - 2 * t) }

function frame() {
  const diff = currentLevel - displayLevel
  displayLevel += diff * TRANSITION_SPEED
  if (Math.abs(diff) < 0.005) displayLevel = currentLevel
  const isTransitioning = Math.abs(displayLevel - currentLevel) > 0.01

  if (offsetsLocked && !isTransitioning) {
    lockTimer++
    if (lockTimer > 20) { offsetsLocked = false; lockTimer = 0 }
  }

  if (!offsetsLocked && !isTransitioning) {
    const off = levelOffsets[currentLevel]
    // Only auto-center X when there's no active concept-tracking session.
    // During tracking, offset.x was set intentionally by the wheel handler
    // to land the cursor on the target word — easing it toward 0 would
    // slide the text out from under the cursor (the "zoom, pause, then
    // side-scroll" visual jank).
    if (off && !trackedConcept) {
      if (Math.abs(off.x) > 0.5) off.x *= 0.95
      else off.x = 0
    }
    hoveredWord = hitTestWord(currentLevel, off)
    // Only re-detect concept if not locked (concept stays locked through zoom until mouse moves)
    hoveredConcept = findConceptAtCursor(currentLevel, off)
  }

  const baseLevel = Math.floor(displayLevel)
  const nextLevel = Math.min(baseLevel + 1, MAX_LEVEL)
  const t = displayLevel - baseLevel

  renderer.clear()
  if (Object.keys(measuredLevels).length === 0) { requestAnimationFrame(frame); return }

  if (!isTransitioning || baseLevel === nextLevel) {
    const off = levelOffsets[currentLevel] ?? defaultOffset(currentLevel)
    renderer.drawLevel(measuredLevels[currentLevel], FONT, LINE_HEIGHT, COLUMN_WIDTH, off.x, off.y, 1)
    drawWordHighlight()
  } else {
    const blend = smoothstep(t)
    const bo = levelOffsets[baseLevel] ?? defaultOffset(baseLevel)
    const no = levelOffsets[nextLevel] ?? defaultOffset(nextLevel)
    renderer.drawLevel(measuredLevels[baseLevel], FONT, LINE_HEIGHT, COLUMN_WIDTH, bo.x, bo.y, 1 - blend)
    renderer.drawLevel(measuredLevels[nextLevel], FONT, LINE_HEIGHT, COLUMN_WIDTH, no.x, no.y, blend)
  }

  updateAndDrawParticles()
  drawScrollbar()
  drawHUD()
  requestAnimationFrame(frame)
}

// ========== SCROLLBAR ==========

function drawScrollbar() {
  const g = getScrollbarGeom(currentLevel); if (!g) return
  const ctx = renderer.ctx, dpr = renderer.dpr
  ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  // Track
  ctx.fillStyle = 'rgba(255,255,255,0.04)'
  ctx.fillRect(g.trackX, g.trackY, SB_WIDTH, g.trackH)
  // Thumb
  const active = sbDragging || sbHover
  ctx.fillStyle = active ? 'rgba(150,190,255,0.55)' : 'rgba(255,255,255,0.22)'
  const r = 4
  const x = g.trackX, y = g.thumbY, w = SB_WIDTH, h = g.thumbH
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.fill()
  ctx.restore()
}

// ========== BOOT ==========

async function loadTree(jsonPath) {
  try {
    const resp = await fetch(jsonPath)
    if (!resp.ok) throw new Error(`Failed to load: ${jsonPath}`)
    treeData = await resp.json()
  } catch (e) { console.error(e); return }

  MAX_LEVEL = (treeData.levelCount || Object.keys(treeData.levels).length) - 1

  const r = measureAllLevels(treeData)
  measuredLevels = r.measured; levelHeights = r.heights
  buildPhraseIndex(treeData, measuredLevels)

  for (let i = 0; i <= MAX_LEVEL; i++) levelOffsets[i] = defaultOffset(i)
  currentLevel = 0; displayLevel = 0
}

async function loadConcepts(basePath) {
  try {
    const resp = await fetch(basePath)
    if (resp.ok) {
      const raw = await resp.json()
      // Support both shapes: bare array (old) and {concepts, characters} (new)
      if (Array.isArray(raw)) {
        concepts = raw
      } else if (raw && Array.isArray(raw.concepts)) {
        concepts = raw.concepts
      } else {
        concepts = []
      }
      console.log(`Loaded ${concepts.length} concepts`)
    } else {
      console.warn('No concepts.json — concept-based zoom disabled')
      concepts = []
    }
  } catch { concepts = [] }
}

async function init() {
  const params = new URLSearchParams(window.location.search)
  const file = params.get('file') || 'the-voting-problem-auto.json'
  const jsonPath = new URL(`../data/${file}`, import.meta.url).href

  // Derive concepts filename from tree filename
  const conceptsFile = file.replace('.json', '-concepts.json')
  const conceptsPath = new URL(`../data/${conceptsFile}`, import.meta.url).href

  await loadTree(jsonPath)
  await loadConcepts(conceptsPath)

  const picker = document.getElementById('file-picker')
  if (picker) {
    picker.value = file
    picker.addEventListener('change', async (e) => {
      const newFile = e.target.value
      const newPath = new URL(`../data/${newFile}`, import.meta.url).href
      const newConceptsFile = newFile.replace('.json', '-concepts.json')
      const newConceptsPath = new URL(`../data/${newConceptsFile}`, import.meta.url).href
      await loadTree(newPath)
      await loadConcepts(newConceptsPath)
      const url = new URL(window.location)
      url.searchParams.set('file', newFile)
      window.history.replaceState({}, '', url)
    })
  }

  requestAnimationFrame(frame)
}

init()

// Debug exports for headless testing
window._sz = {
  get treeData() { return treeData },
  get concepts() { return concepts },
  get measuredLevels() { return measuredLevels },
  get levelHeights() { return levelHeights },
  get currentLevel() { return currentLevel },
  get hoveredConcept() { return hoveredConcept },
  get hoveredWord() { return hoveredWord },
  get levelOffsets() { return levelOffsets },
  get phrasesAtLevel() { return phrasesAtLevel },
  get trackedConcept() { return trackedConcept },
  get trackedWord() { return trackedWord },
  findConceptAtCursor,
  getConceptPosition,
  getConceptCenterPosition,
  getConceptWordPosition,
  findPhraseAtCursor,
  hitTestWord,
  defaultOffset,
  // Test hooks for the regression runner.
  setTrackedConcept(c) { trackedConcept = c },
  setTrackedWord(w) { trackedWord = w },
  clearTrackedConcept() { trackedConcept = null; trackedWord = null },
  getScrollbarGeom,
  isOnScrollbarThumb,
  isOnScrollbarTrack,
  get sbDragging() { return sbDragging },
}
