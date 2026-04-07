import { prepareWithSegments, layoutWithLines } from '@chenglou/pretext'

// Cache prepared text to avoid re-measuring on every frame
const preparedCache = new Map()

/**
 * Prepare text for layout (one-time canvas measurement per text+font combo).
 * Returns a prepared object that can be used with layoutSegment().
 */
export function prepareText(text, font) {
  const key = text + '||' + font
  if (preparedCache.has(key)) return preparedCache.get(key)

  const prepared = prepareWithSegments(text, font)
  preparedCache.set(key, prepared)
  return prepared
}

/**
 * Layout prepared text at a given width.
 * Returns { lines, height, lineCount } where lines is an array of { text, width }.
 */
export function layoutText(prepared, maxWidth, lineHeight) {
  const result = layoutWithLines(prepared, maxWidth, lineHeight)
  return {
    lines: result.lines,
    height: result.height,
    lineCount: result.lineCount
  }
}

/**
 * Prepare and layout a tree node's text.
 * Returns { prepared, lines, height, lineCount }.
 */
export function measureNode(text, font, maxWidth, lineHeight) {
  const prepared = prepareText(text, font)
  const layout = layoutText(prepared, maxWidth, lineHeight)
  return { prepared, ...layout }
}

/**
 * Measure all nodes at a given level of the tree.
 * Returns an array of { nodeId, text, lines, height, lineCount, y } with cumulative y positions.
 */
export function measureLevel(nodes, font, maxWidth, lineHeight, gap = 20) {
  let y = 0
  const measured = []

  for (const node of nodes) {
    const { lines, height, lineCount } = measureNode(node.text, font, maxWidth, lineHeight)
    measured.push({
      nodeId: node.id,
      text: node.text,
      lines,
      height,
      lineCount,
      y
    })
    y += height + gap
  }

  return measured
}

export function clearCache() {
  preparedCache.clear()
}
