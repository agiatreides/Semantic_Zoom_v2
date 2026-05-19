/**
 * Rebuild parent/child links for independently generated linear levels.
 *
 * `rebuild-levels.js` writes every level directly from the source, so there is
 * no natural cluster tree left behind. The document is still linear, though:
 * every level tells the same piece in source order. This pass aligns adjacent
 * levels by cumulative word position and assigns each lower-level node to the
 * upper-level node whose normalized span overlaps it most.
 */

function wordCount(text) {
  return (text || '').split(/\s+/).filter(Boolean).length
}

function levelRanges(nodes) {
  const counts = nodes.map(n => Math.max(1, wordCount(n.text)))
  const total = counts.reduce((sum, n) => sum + n, 0) || counts.length || 1
  let cursor = 0
  return nodes.map((node, i) => {
    const start = cursor / total
    cursor += counts[i]
    const end = cursor / total
    return {
      node,
      start,
      end,
      mid: (start + end) / 2,
    }
  })
}

function overlap(a, b) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
}

function midpointDistance(a, b) {
  return Math.abs(a.mid - b.mid)
}

function bestParentForChild(child, parentRanges) {
  let best = null
  for (const parent of parentRanges) {
    const ov = overlap(parent, child)
    const dist = midpointDistance(parent, child)
    if (!best ||
      ov > best.overlap ||
      (ov === best.overlap && dist < best.distance)) {
      best = { parent, overlap: ov, distance: dist }
    }
  }
  return best?.parent || null
}

function nearestChildForParent(parent, childRanges) {
  let best = null
  for (const child of childRanges) {
    const dist = midpointDistance(parent, child)
    if (!best || dist < best.distance) best = { child, distance: dist }
  }
  return best?.child || null
}

export function rebuildLinearChildLinks(tree) {
  const levelCount = tree.levelCount ?? Object.keys(tree.levels || {}).length
  let totalLinks = 0

  for (let L = 0; L < levelCount - 1; L++) {
    const parents = tree.levels[String(L)]?.nodes || []
    const children = tree.levels[String(L + 1)]?.nodes || []
    if (parents.length === 0) continue

    if (children.length === 0) {
      for (const parent of parents) parent.children = []
      continue
    }

    const parentRanges = levelRanges(parents)
    const childRanges = levelRanges(children)
    const links = new Map(parents.map(parent => [parent.id, []]))

    for (const child of childRanges) {
      const parent = bestParentForChild(child, parentRanges)
      if (parent) links.get(parent.node.id).push(child.node.id)
    }

    // Keep every parent navigable when possible. A duplicate child link is
    // acceptable here; the renderer uses links as phrase-search constraints,
    // not as an ownership proof.
    for (const parent of parentRanges) {
      const list = links.get(parent.node.id)
      if (list.length > 0) continue
      const child = nearestChildForParent(parent, childRanges)
      if (child) list.push(child.node.id)
    }

    for (const parent of parents) {
      const childIds = links.get(parent.id) || []
      parent.children = [...new Set(childIds)]
      totalLinks += parent.children.length
    }
  }

  const leaves = tree.levels[String(levelCount - 1)]?.nodes || []
  for (const leaf of leaves) leaf.children = []

  return { totalLinks }
}
