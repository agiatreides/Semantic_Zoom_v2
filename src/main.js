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

  if (!cursorNodeId) return null

  const lvlStr = String(level)

  // First pass: collect ALL concepts whose anchor at this level contains the
  // cursor. Tie-break by SHORTEST anchor (most specific) — old behavior was
  // first-in-array which was unstable when concepts overlapped at L0.
  let containing = null  // {concept, span}
  let bestConcept = null
  let bestDistance = Infinity

  for (const concept of concepts) {
    const anchor = concept.anchors[lvlStr]
    if (!anchor || anchor.nodeId !== cursorNodeId) continue

    if (cursorCharIdx >= anchor.charStart && cursorCharIdx <= anchor.charEnd) {
      const span = anchor.charEnd - anchor.charStart
      if (!containing || span < containing.span) {
        containing = { concept, span }
      }
      continue
    }

    const dist = Math.min(
      Math.abs(cursorCharIdx - anchor.charStart),
      Math.abs(cursorCharIdx - anchor.charEnd)
    )
    if (dist < bestDistance) {
      bestDistance = dist
      bestConcept = concept
    }
  }

  if (containing) return containing.concept
  if (bestConcept && bestDistance < 200) return bestConcept

  // Fallback: find closest concept by content Y
  let closestByY = null
  let closestYDist = Infinity
  for (const concept of concepts) {
    const anchor = concept.anchors[lvlStr]
    if (!anchor) continue
    const anchorNode = nodes.find(n => n.nodeId === anchor.nodeId)
    if (!anchorNode) continue
    const anchorY = anchorNode.y + (anchor.charStart / Math.max(1, anchorNode.text?.length || 100)) * anchorNode.height
    const dist = Math.abs(contentY - anchorY)
    if (dist < closestYDist) {
      closestYDist = dist
      closestByY = concept
    }
  }

  return closestByY
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

// Position of the MIDDLE character of the anchor span. Aim for this from the
// wheel handler so the cursor lands centered on the concept, not at its
// leading edge where a neighboring concept's tail can grab it.
function getConceptCenterPosition(concept, level) {
  const anchor = concept.anchors[String(level)]
  if (!anchor) return null
  const nodes = measuredLevels[level]
  if (!nodes) return null
  const node = nodes.find(n => n.nodeId === anchor.nodeId)
  if (!node) return null
  const midChar = Math.floor((anchor.charStart + anchor.charEnd) / 2)
  return positionAtCharIdx(node, midChar)
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
function getConceptWordPosition(concept, level, word) {
  if (!word || word.length < 2) return null
  const anchor = concept.anchors[String(level)]
  if (!anchor) return null
  const nodes = measuredLevels[level]
  if (!nodes) return null
  const node = nodes.find(n => n.nodeId === anchor.nodeId)
  if (!node) return null

  const anchorText = node.text.substring(anchor.charStart, anchor.charEnd)
  // Strip leading/trailing non-word chars so we match "not" against "not,"
  // and "not." equally.
  const clean = word.replace(/^[^\w'-]+|[^\w'-]+$/g, '').toLowerCase()
  if (clean.length < 2) return null

  // Collect all words in the anchor text with their offsets
  const re = /[\w'-]+/g
  const words = []
  let m
  while ((m = re.exec(anchorText)) !== null) {
    words.push({ text: m[0], textLc: m[0].toLowerCase(), offset: m.index })
  }
  if (words.length === 0) return null

  // Tier 1: exact
  for (const w of words) {
    if (w.textLc === clean) {
      const midOffset = w.offset + Math.floor(w.text.length / 2)
      return positionAtCharIdx(node, anchor.charStart + midOffset)
    }
  }

  // Tier 2: stem match via 4-char prefix (handles cheating/cheated, trust/trusted, etc.)
  const stemLen = Math.min(clean.length, 4)
  if (clean.length >= 4) {
    const stem = clean.substring(0, stemLen)
    for (const w of words) {
      if (w.textLc.length >= stemLen && w.textLc.startsWith(stem)) {
        const midOffset = w.offset + Math.floor(w.text.length / 2)
        return positionAtCharIdx(node, anchor.charStart + midOffset)
      }
    }
  }

  // Tier 3: substring containment (handles log/logs, access/accessing)
  if (clean.length >= 4) {
    for (const w of words) {
      if (w.textLc.length >= 4 && (w.textLc.includes(clean) || clean.includes(w.textLc))) {
        const midOffset = w.offset + Math.floor(w.text.length / 2)
        return positionAtCharIdx(node, anchor.charStart + midOffset)
      }
    }
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

  const regex = /(\S+)(\s*)/g
  let match, accWidth = 0
  while ((match = regex.exec(hitNode.lines[lineIdx].text)) !== null) {
    const wt = match[1], tr = match[2]
    const ww = renderer.measureText(wt, FONT)
    const tw = renderer.measureText(tr, FONT)
    if (contentX >= accWidth && contentX < accWidth + ww) {
      return {
        word: wt, nodeId: hitNode.nodeId, lineIdx,
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
  return x >= bx - 20 && x <= bx + COLUMN_WIDTH + 20 && y >= 0 && y <= renderer.height
}
function isFrozen() { return mouseDown || !cursorInTextArea }

canvas.addEventListener('mousedown', () => { mouseDown = true })
canvas.addEventListener('mouseup', () => { mouseDown = false })
window.addEventListener('mouseup', () => { mouseDown = false })

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

    // Semantic zoom anchoring — concept first, phrase-chain fallback.
    // Concepts carry per-level anchors and preserve identity by construction.
    // The phrase chain (matchIn/matchOut) is a per-phrase forward index that
    // can drift across many levels.
    const oldOff = levelOffsets[prevLevel] ?? defaultOffset(prevLevel)
    let placed = false

    // Track ONE concept across a continuous zoom session. The user moves
    // the cursor to a word, then scrolls without moving — that whole session
    // is "I want to track THIS concept." Re-resolving the concept on every
    // wheel event lets neighboring concepts grab the cursor as line-wrap
    // shifts. So: lock the concept on the first wheel of a session, reuse
    // until the cursor moves (mousemove handler clears trackedConcept).
    if (!trackedConcept) {
      trackedConcept = findConceptAtCursor(prevLevel, oldOff)
      // Also capture the exact word under the cursor at session start.
      // If that word survives at deeper/shallower levels (e.g. "not"),
      // the wheel handler lands cursor on it specifically, not on the
      // anchor midpoint where a different word might sit.
      const hit = hitTestWord(prevLevel, oldOff)
      trackedWord = hit?.word ?? null
    }

    // If the tracked concept has no anchor at the new level (it's invisible
    // there because we zoomed past its min_visible_level), gracefully promote
    // to whatever concept lives where the cursor would otherwise land. Falls
    // through to the phrase-chain placement below if nothing fits.
    let targetConcept = trackedConcept
    if (targetConcept && !targetConcept.anchors[String(currentLevel)]) {
      // Place via phrase chain first (so cursor lands SOMEWHERE meaningful),
      // then re-acquire whatever concept is now under the cursor.
      const tmpContentY = mouseY - oldOff.y
      const baseLeftX = (renderer.width - COLUMN_WIDTH) / 2
      const tmpContentX = mouseX - baseLeftX - oldOff.x
      const phrase = findPhraseAtCursor(prevLevel, tmpContentY, tmpContentX)
      const targetIdx = zoomingIn ? phrase?.matchIn : phrase?.matchOut
      const target = targetIdx >= 0 ? phrasesAtLevel[currentLevel]?.[targetIdx] : null
      if (target) {
        levelOffsets[currentLevel] = clampOffset(currentLevel, { x: 0, y: mouseY - target.y })
        placed = true
      }
      const provisionalOff = levelOffsets[currentLevel] ?? defaultOffset(currentLevel)
      const reacquired = findConceptAtCursor(currentLevel, provisionalOff)
      if (reacquired) {
        trackedConcept = reacquired
        targetConcept = reacquired
      } else {
        targetConcept = null  // keep the phrase-chain placement, don't re-anchor
      }
    }

    if (targetConcept && targetConcept.anchors[String(currentLevel)]) {
      // Prefer the specific tracked word if it appears in the target anchor;
      // fall back to the anchor's midpoint. This keeps cursor on the same
      // word across levels when the word survives (e.g. "not").
      const wordPos = trackedWord ? getConceptWordPosition(targetConcept, currentLevel, trackedWord) : null
      const pos = wordPos || getConceptCenterPosition(targetConcept, currentLevel)
      if (pos) {
        // Adjust BOTH axes. Y brings the target line under the cursor.
        // X shifts the column so the target char sits under the cursor X,
        // so the underlined word actually ends up where the cursor is —
        // not just on the same line at the old X. Without the X shift,
        // the cursor stays at the old screen X and lands on whatever word
        // happens to occupy that X in the new layout.
        const baseLeftX = (renderer.width - COLUMN_WIDTH) / 2
        levelOffsets[currentLevel] = clampOffset(currentLevel, {
          x: mouseX - baseLeftX - pos.contentX,
          y: mouseY - pos.contentY
        })
        placed = true
      }
    }

    if (!placed) {
      const contentY = mouseY - oldOff.y
      const baseLeftX = (renderer.width - COLUMN_WIDTH) / 2
      const contentX = mouseX - baseLeftX - oldOff.x
      const phrase = findPhraseAtCursor(prevLevel, contentY, contentX)
      const targetIdx = zoomingIn ? phrase?.matchIn : phrase?.matchOut
      const target = targetIdx >= 0 ? phrasesAtLevel[currentLevel]?.[targetIdx] : null
      if (target) {
        levelOffsets[currentLevel] = clampOffset(currentLevel, { x: 0, y: mouseY - target.y })
      }
    }

    offsetsLocked = true
    lockTimer = 0
  }
}, { passive: false })

canvas.addEventListener('mousemove', (e) => {
  const movedX = e.clientX, movedY = e.clientY
  // Real cursor motion (>2px) ends the current zoom-tracking session so the
  // next wheel re-acquires whatever concept is now under the cursor.
  if (Math.abs(movedX - mouseX) > 2 || Math.abs(movedY - mouseY) > 2) { trackedConcept = null; trackedWord = null }
  mouseX = movedX; mouseY = movedY
  cursorInTextArea = isInTextArea(mouseX, mouseY)
  if (isFrozen() || offsetsLocked) return

  const off = levelOffsets[currentLevel] ?? defaultOffset(currentLevel)
  hoveredWord = hitTestWord(currentLevel, off)
  hoveredConcept = findConceptAtCursor(currentLevel, off)
})

canvas.addEventListener('mouseleave', () => { cursorInTextArea = false; hoveredWord = null; hoveredConcept = null; trackedConcept = null; trackedWord = null })
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
  if (hoveredConcept) { ctx.fillStyle = 'rgba(255,200,100,0.5)'; ctx.fillText(`◆ ${hoveredConcept.label}`, 16, h - 66) }

  ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(255,255,255,0.2)'
  ctx.fillText('Scroll: zoom  |  Move cursor: navigate', w - 16, h - 12)
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
    if (off && Math.abs(off.x) > 0.5) off.x *= 0.95
    else if (off) off.x = 0
    hoveredWord = hitTestWord(currentLevel, off)
    // Only re-detect concept if not locked (concept stays locked through zoom until mouse moves)
    hoveredConcept = findConceptAtCursor(currentLevel, off)
  }

  if (!isFrozen() && !offsetsLocked && !isTransitioning) {
    const screenH = renderer.height, contentH = levelHeights[currentLevel] || 0
    if (contentH > screenH) {
      const ez = screenH * 0.10, ms = 8
      let sd = 0
      if (mouseY > screenH - ez) { const d = (mouseY - (screenH - ez)) / ez; sd = -ms * d * d }
      else if (mouseY < ez) { const d = (ez - mouseY) / ez; sd = ms * d * d }
      if (sd !== 0) {
        const off = levelOffsets[currentLevel]
        off.y = clampOffset(currentLevel, { x: off.x, y: off.y + sd }).y
        hoveredWord = hitTestWord(currentLevel, off)
        hoveredConcept = findConceptAtCursor(currentLevel, off)
      }
    }
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
  drawHUD()
  requestAnimationFrame(frame)
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
  clearTrackedConcept() { trackedConcept = null; trackedWord = null }
}
