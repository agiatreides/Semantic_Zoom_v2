/**
 * Summarization adapter.
 * Extractive mode: picks the most representative sentences from each cluster.
 * Claude mode: placeholder for future Claude Code skill integration.
 */

/**
 * Cosine similarity between two vectors.
 */
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
 * Split text into sentences (simple but handles common cases).
 */
function splitSentences(text) {
  // Split on sentence boundaries, keeping the delimiter
  const raw = text.split(/(?<=[.!?])\s+/)
  return raw.filter(s => s.trim().length > 0)
}

/**
 * Extractive summarization: for a cluster of text nodes,
 * pick the most representative sentences up to a target word count.
 *
 * @param {Array<{ text: string, embedding: number[] }>} members - Nodes in the cluster
 * @param {number} targetWords - Approximate target word count for summary
 * @returns {string} - Extractive summary text
 */
export function extractiveSummarize(members, targetWords) {
  if (members.length === 0) return ''
  if (members.length === 1 && members[0].text.split(/\s+/).length <= targetWords * 1.2) {
    return members[0].text
  }

  // Compute centroid of all member embeddings
  const dim = members[0].embedding.length
  const centroid = new Array(dim).fill(0)
  for (const m of members) {
    for (let i = 0; i < dim; i++) centroid[i] += m.embedding[i]
  }
  for (let i = 0; i < dim; i++) centroid[i] /= members.length

  // Collect all sentences from all members, ordered by appearance
  const allSentences = []
  for (const m of members) {
    const sentences = splitSentences(m.text)
    for (const s of sentences) {
      allSentences.push({ text: s, embedding: m.embedding })
    }
  }

  if (allSentences.length === 0) {
    return members.map(m => m.text).join(' ')
  }

  // Score each sentence by similarity to centroid
  const scored = allSentences.map((s, i) => ({
    ...s,
    index: i,
    score: cosineSim(s.embedding, centroid)
  }))

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score)

  // Greedily pick sentences until target word count reached, preserving order
  const picked = []
  let wordCount = 0
  for (const s of scored) {
    if (wordCount >= targetWords) break
    picked.push(s)
    wordCount += s.text.split(/\s+/).length
  }

  // Re-sort by original order for coherent reading
  picked.sort((a, b) => a.index - b.index)

  return picked.map(s => s.text).join(' ')
}

/**
 * Calculate target word count for a summary at a given level.
 * Higher levels (closer to root) are more compressed.
 * Roughly doubles words per level going down.
 *
 * @param {number} memberWordCount - Total words in the cluster's members
 * @param {number} currentLevel - Current level being built (0 = leaves)
 * @param {number} totalLevels - Total number of levels in the tree
 * @returns {number} - Target word count
 */
export function targetWordCount(memberWordCount, currentLevel, totalLevels) {
  // At the level just above leaves, keep ~60% of content
  // Each level up compresses further
  const compressionPerLevel = 0.55
  const levelsAboveLeaves = currentLevel
  const ratio = Math.pow(compressionPerLevel, levelsAboveLeaves + 1)
  return Math.max(20, Math.round(memberWordCount * ratio))
}
