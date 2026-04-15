/**
 * Summarization adapter.
 * Extractive mode: picks the most representative sentences from each cluster.
 * Claude mode: calls Claude CLI for abstractive summarization.
 */

import { execSync } from 'child_process'

/**
 * Abstractive summarization via Claude CLI.
 * Uses `claude -p` (Pro Max subscription, no API key needed).
 *
 * @param {Array<{ text: string }>} members - Nodes in the cluster
 * @param {number} targetWords - Approximate target word count
 * @returns {string|null} - Summary text, or null on failure
 */
export function claudeSummarize(members, targetWords, importantConcepts = []) {
  const n = members.length

  // Label each member as a numbered passage so Claude can't ignore any of them
  const numberedPassages = members.map((m, i) =>
    `PASSAGE ${i + 1}/${n}:\n${m.text}`
  ).join('\n\n---\n\n')

  const perPassageWords = Math.max(8, Math.floor(targetWords / n))

  const conceptGuidance = importantConcepts.length > 0
    ? `\nPRIORITY CONCEPTS (include these, highest importance first):\n${importantConcepts.map(c => `- [${c.importance}] ${c.text}`).join('\n')}\n`
    : ''

  const prompt = `You are compressing ${n} passage${n > 1 ? 's' : ''} for a semantic zoom interface.

CRITICAL RULES:
- You MUST include content from ALL ${n} passage${n > 1 ? 's' : ''}. Never drop an entire passage.
- Every passage contributes ~${perPassageWords} words to the output. Allocate budget proportionally.
- This is COMPRESSION, not summarization. Don't extract themes. Compress the PLOT.
- Preserve reading order. Events appear in the same sequence as the original.
- Preserve character names, key dialogue phrases, and pivotal decisions.
- Write flowing prose. No bullet points, no headers, no meta-commentary.
${conceptGuidance}
Compress ALL ${n} passage${n > 1 ? 's' : ''} below into approximately ${targetWords} words total:

---

${numberedPassages}

---

Compressed version (~${targetWords} words, covering all ${n} passage${n > 1 ? 's' : ''}):`

  try {
    const result = execSync(
      'claude -p --output-format text',
      { input: prompt, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 120000 }
    ).trim()
    return result || null
  } catch (e) {
    console.error('  Claude summarization failed:', e.message?.substring(0, 100))
    return null
  }
}

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
export function targetWordCount(memberWordCount, currentLevel, totalLevels, totalDocWords = 0) {
  // Each level up compresses further — 55% of previous level's content
  const compressionPerLevel = 0.55
  const levelsAboveLeaves = currentLevel
  const ratio = Math.pow(compressionPerLevel, levelsAboveLeaves + 1)
  // Floor: 2.5% of total document size. No compression below this.
  // A 2000-word story → floor 50. A 200K novel → floor 5000.
  // If the cluster is already below the floor, keep it as-is (don't compress).
  const floor = totalDocWords > 0 ? Math.round(totalDocWords * 0.025) : Math.round(memberWordCount * 0.025)
  const target = Math.max(floor, Math.round(memberWordCount * ratio))
  return Math.min(memberWordCount, target)
}
