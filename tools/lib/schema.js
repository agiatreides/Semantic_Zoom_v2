/**
 * Validates a semantic zoom tree JSON structure.
 * Returns an array of error strings (empty = valid).
 */
export function validateTree(tree) {
  const errors = []

  if (!tree || typeof tree !== 'object') {
    return ['Tree must be a non-null object']
  }

  if (typeof tree.title !== 'string' || !tree.title) {
    errors.push('Missing or empty "title"')
  }

  if (typeof tree.levelCount !== 'number' || tree.levelCount < 1) {
    errors.push('"levelCount" must be a positive integer')
  }

  if (!tree.levels || typeof tree.levels !== 'object') {
    errors.push('Missing "levels" object')
    return errors
  }

  const maxLevel = tree.levelCount - 1

  // Collect all node IDs across all levels
  const allNodeIds = new Set()
  const nodesByLevel = {}

  for (let i = 0; i <= maxLevel; i++) {
    const level = tree.levels[String(i)]
    if (!level) {
      errors.push(`Missing level "${i}"`)
      continue
    }
    if (!Array.isArray(level.nodes)) {
      errors.push(`Level "${i}" missing "nodes" array`)
      continue
    }

    nodesByLevel[i] = new Set()
    for (const node of level.nodes) {
      if (!node.id) {
        errors.push(`Node in level ${i} missing "id"`)
        continue
      }
      if (allNodeIds.has(node.id)) {
        errors.push(`Duplicate node ID: "${node.id}"`)
      }
      allNodeIds.add(node.id)
      nodesByLevel[i].add(node.id)

      if (typeof node.text !== 'string' || !node.text.trim()) {
        errors.push(`Node "${node.id}" has empty or missing text`)
      }
      if (!Array.isArray(node.children)) {
        errors.push(`Node "${node.id}" missing "children" array`)
      }
    }
  }

  // Validate parent-child links
  const childrenReferenced = new Set()
  for (let i = 0; i <= maxLevel; i++) {
    const level = tree.levels[String(i)]
    if (!level || !Array.isArray(level.nodes)) continue

    for (const node of level.nodes) {
      if (!Array.isArray(node.children)) continue

      for (const childId of node.children) {
        if (!allNodeIds.has(childId)) {
          errors.push(`Node "${node.id}" references non-existent child "${childId}"`)
        } else if (i < maxLevel && nodesByLevel[i + 1] && !nodesByLevel[i + 1].has(childId)) {
          errors.push(`Node "${node.id}" child "${childId}" not in next level ${i + 1}`)
        }
        childrenReferenced.add(childId)
      }
    }
  }

  // Check for orphaned nodes (every non-root node should be someone's child)
  if (nodesByLevel[0]) {
    for (let i = 1; i <= maxLevel; i++) {
      if (!nodesByLevel[i]) continue
      for (const nodeId of nodesByLevel[i]) {
        if (!childrenReferenced.has(nodeId)) {
          errors.push(`Orphaned node: "${nodeId}" (not referenced as a child)`)
        }
      }
    }
  }

  // Check leaf nodes have empty children
  if (nodesByLevel[maxLevel]) {
    const level = tree.levels[String(maxLevel)]
    if (level && Array.isArray(level.nodes)) {
      for (const node of level.nodes) {
        if (Array.isArray(node.children) && node.children.length > 0) {
          errors.push(`Leaf node "${node.id}" at max level has non-empty children`)
        }
      }
    }
  }

  return errors
}
