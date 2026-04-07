import skmeans from 'skmeans'

/**
 * Cluster nodes into CONTIGUOUS groups.
 * For narrative text, parents must cover adjacent children (reading order).
 *
 * Uses a greedy approach: find natural break points where
 * semantic similarity between adjacent nodes is lowest.
 *
 * @param {Array} nodes - Array of { text, embedding: number[] }
 * @param {number} targetK - Target number of clusters
 * @returns {Array<{ members: number[] }>} - Clusters with member indices (contiguous)
 */
export function clusterNodes(nodes, targetK) {
  const k = Math.max(1, Math.min(targetK, nodes.length))

  if (k >= nodes.length) {
    return nodes.map((_, i) => ({ members: [i] }))
  }

  if (k === 1) {
    return [{ members: nodes.map((_, i) => i) }]
  }

  // Compute cosine similarity between each adjacent pair
  const similarities = []
  for (let i = 0; i < nodes.length - 1; i++) {
    similarities.push({
      index: i,
      sim: cosineSim(nodes[i].embedding, nodes[i + 1].embedding)
    })
  }

  // We need (k - 1) split points. Pick the positions with LOWEST similarity
  // (biggest topic shifts)
  similarities.sort((a, b) => a.sim - b.sim)
  const splitIndices = similarities
    .slice(0, k - 1)
    .map(s => s.index)
    .sort((a, b) => a - b)

  // Build contiguous clusters from split points
  const clusters = []
  let start = 0
  for (const splitIdx of splitIndices) {
    const members = []
    for (let i = start; i <= splitIdx; i++) members.push(i)
    clusters.push({ members })
    start = splitIdx + 1
  }
  // Last cluster
  const lastMembers = []
  for (let i = start; i < nodes.length; i++) lastMembers.push(i)
  clusters.push({ members: lastMembers })

  return clusters
}

function cosineSim(a, b) {
  let dot = 0, magA = 0, magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) + 1e-10)
}

/**
 * Calculate the target number of clusters for one reduction step.
 * Targets ~55% of current node count.
 */
export function targetClusterCount(nodeCount) {
  if (nodeCount <= 3) return 1
  return Math.max(1, Math.ceil(nodeCount * 0.55))
}
