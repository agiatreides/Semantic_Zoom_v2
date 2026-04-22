/**
 * Reduction adapter.
 *
 * REDUCTION ≠ SUMMARY. The output is the SAME story (or paper, or essay)
 * told tighter — same voice, same tense, same perspective, same character
 * agency. We are NOT stepping outside the narrative to describe it. The
 * reader is still reading the work, just with flourish and incidental
 * detail cut. "Maya is accused. He could check the logs. He doesn't."
 * NOT "The father faces a parental oversight dilemma."
 *
 * Extractive mode: picks original sentences (already non-meta).
 * Claude mode: calls Claude CLI for abstractive reduction.
 *
 * Two entry points:
 *   - claudeSummarize(...)          → sync, blocks. For one-off calls.
 *   - claudeSummarizeAsync(...)     → returns Promise. For Promise.all
 *                                     batching across independent clusters.
 */

import { execSync, spawn } from 'child_process'

/**
 * Abstractive REDUCTION via Claude CLI.
 * Uses `claude -p` (Pro Max subscription, no API key needed).
 *
 * @param {Array<{ text: string }>} members - Nodes in the cluster
 * @param {number} targetWords - Approximate target word count
 * @param {Array<{text: string, importance?: number}>} importantConcepts - legacy phrase hints (still accepted)
 * @param {{essentials?: Array<{label: string, snippet?: string}>}} opts - new: explicit essential events that MUST remain visible at this level
 * @returns {string|null} - Reduced text, or null on failure
 */
export function claudeSummarize(members, targetWords, importantConcepts = [], opts = {}) {
  const n = members.length

  // Label each member as a numbered passage so Claude can't ignore any of them
  const numberedPassages = members.map((m, i) =>
    `PASSAGE ${i + 1}/${n}:\n${m.text}`
  ).join('\n\n---\n\n')

  const perPassageWords = Math.max(8, Math.floor(targetWords / n))

  const essentials = (opts && Array.isArray(opts.essentials)) ? opts.essentials : []
  const characters = (opts && opts.characters && typeof opts.characters === 'object') ? opts.characters : {}
  const thematicThrust = (opts && typeof opts.thematicThrust === 'string') ? opts.thematicThrust.trim() : ''
  const essentialsMode = essentials.length > 0
  let essentialsBlock = ''
  let coverageRule = `- You MUST include content from ALL ${n} passage${n > 1 ? 's' : ''}. Never drop an entire passage.\n- Each passage contributes ~${perPassageWords} words to the output. Allocate proportionally.`

  const charNames = Object.keys(characters)
  const charactersBlock = charNames.length > 0 ? `

CAST & GLOSSARY (mandatory — the reader at compressed levels has ZERO prior context):
${charNames.map(n => `  ${n} — ${characters[n]}`).join('\n')}

MANDATORY INTRODUCTION RULE — on FIRST mention of any entry above in the reduced output, you MUST pair the name with a 1-6 word role-tag drawn from (or shortened from) its dictionary entry. Inline, conversational — not a parenthetical dump. Second and later mentions use just the name.

EXAMPLES of correct first-mention introductions (generic, not from this work):
  ✓ "my daughter, accused of cheating"       (use narrator's relationship when it's tighter)
  ✓ "the implant, billed monthly,"
  ✓ "the classmate who accused her"
  ✗ first mention with no orientation is forbidden.

This applies at EVERY level (L0 most strictly). A reader arriving at any level should be able to follow who / what is doing what without having read a deeper level first.

` : ''

  const thematicBlock = thematicThrust ? `

THEMATIC THRUST (what this piece is ABOUT — keep the reduction faithful to this):
  ${thematicThrust}

The thrust is not a line to insert. It's a compass. Your reduction should feel like a tightening of this idea, not a drift away from it.

` : ''

  const sameStoryRule = `

SAME-STORY CONSTRAINT (the irreducible-detail floor):
Your reduction must be the SAME story/piece as the source, just told with less detail. A reader of the reduction and a reader of the source should both describe the work the same way — same characters doing the same things for the same reasons, same pivotal turn, same ending. If your draft reduction is instead a DESCRIPTION OF the story ("the story shows…", "a man discovers…") rather than the story itself at coarser resolution, it has crossed below the irreducible-detail floor. That's destruction, not compression. Rewrite with more detail.

`

  if (essentialsMode) {
    const list = essentials.map(e => `- ${e.label}${e.snippet ? `  (in the source: "${e.snippet.substring(0, 100)}${e.snippet.length > 100 ? '…' : ''}")` : ''}`).join('\n')
    essentialsBlock = `

EVENTS TO INCLUDE — and ONLY THESE:
${list}

EVERYTHING ELSE in the source passages must be CUT. Names of side characters, atmospheric description, dialogue that isn't on the list, scenes that don't appear above — all of it goes. If a passage contains NO event from the list, that passage contributes ZERO words to the output. The output is built FROM the events above, in the source's voice. Nothing else.

`
    coverageRule = `- The output covers EVERY event listed above (skip none).
- The output covers NO event NOT listed above (include none).
- A passage that contains zero listed events contributes zero words.`
  } else if (importantConcepts.length > 0) {
    essentialsBlock = `\nPRIORITY PHRASES (preserve where natural):\n${importantConcepts.map(c => `- [${c.importance ?? '-'}] ${c.text}`).join('\n')}\n`
  }

  const prompt = `You are REDUCING ${n} passage${n > 1 ? 's' : ''} for a semantic zoom interface.

REDUCTION ≠ SUMMARY. The output is the SAME story told tighter, in the original voice. The reader is still reading the work, just with flourish and incidental detail cut. Characters still ACT. Decisions still HAPPEN. Dialogue still has weight.

  ✗ WRONG (summary): "The father faces a parental oversight dilemma."
  ✓ RIGHT (reduction): "Maya is accused. He could check the logs. He doesn't. He trusts her."

  ✗ WRONG (summary): "The story explores themes of trust between humans and AI."
  ✓ RIGHT (reduction): "Chip gives 84%. He doesn't check. 'I trust her.'"

  ✗ WRONG (dialogue paraphrased away):
      source:  The captain rose. "I will not yield the ship."
      output:  The captain refused to yield.   <- paraphrased, lost the quoted speech
  ✓ RIGHT:    "I will not yield the ship," the captain says.
      <- kept the quote verbatim; cut only the narrator tag since the quote shows the action.

  ✗ WRONG (first-person flattened to third):
      source:  I set down the paper. "I refuse to sign."
      output:  The narrator refused to sign.   <- shifted perspective, dropped the quote
  ✓ RIGHT:    I set down the paper. "I refuse to sign."
      <- if it is short enough to keep, keep it; first-person stays first-person.

CRITICAL RULES:
${coverageRule}
- PRESERVE: original voice, tense, perspective (1st/3rd person), character agency, load-bearing dialogue, named characters, decisions, causal steps.
- DIALOGUE is LOAD-BEARING. When the source has direct speech in quotation marks, the output MUST include that dialogue VERBATIM. Do NOT paraphrase \`"I'm not going to access my daughter's logs"\` as \`"Tom refused to access her logs"\`. Do NOT convert quoted speech into third-person narration. Quote marks in, quote marks out.
- TENSE IS STICKY. If the source is present tense, the output is present tense. If past, past. Never shift past↔present or first↔third to save words; cut adjectives or scene-setting instead.
- CUT: adjectives, atmospheric description, redundant elaboration, side scenes that don't move the plot, color details that aren't thematically weight-bearing.
- DO NOT step outside the narrative. Do NOT write "the story shows…" or "the narrator…" or "themes of…" or "the protagonist…". Stay inside the diegesis.
- Preserve reading order. Events appear in the same sequence as the original.
- Flowing prose. No bullet points, no headers, no meta-commentary.
${charactersBlock}${thematicBlock}${essentialsBlock}${sameStoryRule}
${essentialsMode ? `Reduce to approximately ${targetWords} words, covering ONLY the events listed above. Same voice. Same story. Just tighter.` : `Reduce ALL ${n} passage${n > 1 ? 's' : ''} below into approximately ${targetWords} words total. Same voice. Same story. Just tighter.`}

---

${numberedPassages}

---

${essentialsMode ? `Reduced version (~${targetWords} words, covering ONLY the listed events, in the original voice):` : `Reduced version (~${targetWords} words, covering all ${n} passage${n > 1 ? 's' : ''}, in the original voice):`}`

  try {
    // Sonnet default, --effort medium — see rebuild-levels.js for rationale.
    const _model = process.env.MODEL || 'sonnet'
    const _effort = process.env.EFFORT || 'medium'
    const result = execSync(
      `claude -p --output-format text --exclude-dynamic-system-prompt-sections --effort '${_effort}' --model '${_model}'`,
      { input: prompt, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 240000 }
    ).trim()
    return result || null
  } catch (e) {
    console.error('  Claude reduction failed:', e.message?.substring(0, 100))
    return null
  }
}

/**
 * Promise-returning version of claudeSummarize. Uses spawn so multiple
 * reductions can run concurrently. Same arguments and behavior as
 * claudeSummarize but the network/CPU work happens in parallel when
 * called via Promise.all.
 */
export function claudeSummarizeAsync(members, targetWords, importantConcepts = [], opts = {}) {
  // Re-build the prompt by calling the sync version's prompt construction.
  // We duplicate just the prompt-building so we don't have to refactor the
  // (long) prompt template into a shared helper.
  // (Rebuild via temporary stub: call claudeSummarize with a sentinel? Easier:
  // re-run the prompt code inline by extracting it. Instead, re-derive it
  // here by calling a small helper.)
  const prompt = buildReductionPrompt(members, targetWords, importantConcepts, opts)
  return new Promise((resolve) => {
    const t0 = Date.now()
    const _model = process.env.MODEL || 'sonnet'
    const _effort = process.env.EFFORT || 'medium'
    const proc = spawn('claude', ['-p', '--output-format', 'text', '--exclude-dynamic-system-prompt-sections', '--effort', _effort, '--model', _model], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    proc.stdout.on('data', d => { stdout += d.toString() })
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('close', (code) => {
      const ms = Date.now() - t0
      if (code !== 0) {
        console.error(`  [reduce ${(ms/1000).toFixed(1)}s] exit ${code}: ${stderr.substring(0,120)}`)
        resolve(null)
        return
      }
      const out = stdout.trim()
      console.log(`  [reduce ${(ms/1000).toFixed(1)}s] ${out.length} chars`)
      resolve(out || null)
    })
    proc.on('error', (e) => {
      console.error('  Claude reduction failed:', e.message?.substring(0, 100))
      resolve(null)
    })
    // Timeout after 4 min
    const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 240000)
    proc.on('close', () => clearTimeout(timer))
    proc.stdin.write(prompt)
    proc.stdin.end()
  })
}

// Extracted prompt builder used by both sync and async variants.
function buildReductionPrompt(members, targetWords, importantConcepts, opts) {
  const n = members.length
  const numberedPassages = members.map((m, i) =>
    `PASSAGE ${i + 1}/${n}:\n${m.text}`
  ).join('\n\n---\n\n')
  const perPassageWords = Math.max(8, Math.floor(targetWords / n))

  const essentials = (opts && Array.isArray(opts.essentials)) ? opts.essentials : []
  const characters = (opts && opts.characters && typeof opts.characters === 'object') ? opts.characters : {}
  const thematicThrust = (opts && typeof opts.thematicThrust === 'string') ? opts.thematicThrust.trim() : ''
  const essentialsMode = essentials.length > 0
  let essentialsBlock = ''
  let coverageRule = `- You MUST include content from ALL ${n} passage${n > 1 ? 's' : ''}. Never drop an entire passage.\n- Each passage contributes ~${perPassageWords} words to the output. Allocate proportionally.`

  const charNames = Object.keys(characters)
  const charactersBlock = charNames.length > 0 ? `

CAST & GLOSSARY (mandatory — the reader at compressed levels has ZERO prior context):
${charNames.map(n => `  ${n} — ${characters[n]}`).join('\n')}

MANDATORY INTRODUCTION RULE — on FIRST mention of any entry above in the reduced output, you MUST pair the name with a 1-6 word role-tag drawn from (or shortened from) its dictionary entry. Inline, conversational — not a parenthetical dump. Second and later mentions use just the name.

EXAMPLES of correct first-mention introductions (generic, not from this work):
  ✓ "my daughter, accused of cheating"       (use narrator's relationship when it's tighter)
  ✓ "the implant, billed monthly,"
  ✓ "the classmate who accused her"
  ✗ first mention with no orientation is forbidden.

This applies at EVERY level (L0 most strictly). A reader arriving at any level should be able to follow who / what is doing what without having read a deeper level first.

` : ''

  const thematicBlock = thematicThrust ? `

THEMATIC THRUST (what this piece is ABOUT — keep the reduction faithful to this):
  ${thematicThrust}

The thrust is not a line to insert. It's a compass. Your reduction should feel like a tightening of this idea, not a drift away from it.

` : ''

  const sameStoryRule = `

SAME-STORY CONSTRAINT (the irreducible-detail floor):
Your reduction must be the SAME story/piece as the source, just told with less detail. A reader of the reduction and a reader of the source should both describe the work the same way — same characters doing the same things for the same reasons, same pivotal turn, same ending. If your draft reduction is instead a DESCRIPTION OF the story ("the story shows…", "a man discovers…") rather than the story itself at coarser resolution, it has crossed below the irreducible-detail floor. That's destruction, not compression. Rewrite with more detail.

`

  if (essentialsMode) {
    const list = essentials.map(e => `- ${e.label}${e.snippet ? `  (in the source: "${e.snippet.substring(0, 100)}${e.snippet.length > 100 ? '…' : ''}")` : ''}`).join('\n')
    essentialsBlock = `

EVENTS TO INCLUDE — and ONLY THESE:
${list}

EVERYTHING ELSE in the source passages must be CUT. Names of side characters, atmospheric description, dialogue that isn't on the list, scenes that don't appear above — all of it goes. If a passage contains NO event from the list, that passage contributes ZERO words to the output. The output is built FROM the events above, in the source's voice. Nothing else.

`
    coverageRule = `- The output covers EVERY event listed above (skip none).
- The output covers NO event NOT listed above (include none).
- A passage that contains zero listed events contributes zero words.`
  } else if (importantConcepts.length > 0) {
    essentialsBlock = `\nPRIORITY PHRASES (preserve where natural):\n${importantConcepts.map(c => `- [${c.importance ?? '-'}] ${c.text}`).join('\n')}\n`
  }

  return `You are REDUCING ${n} passage${n > 1 ? 's' : ''} for a semantic zoom interface.

REDUCTION ≠ SUMMARY. The output is the SAME story told tighter, in the original voice. The reader is still reading the work, just with flourish and incidental detail cut. Characters still ACT. Decisions still HAPPEN. Dialogue still has weight.

  ✗ WRONG (summary): "The father faces a parental oversight dilemma."
  ✓ RIGHT (reduction): "Maya is accused. He could check the logs. He doesn't. He trusts her."

  ✗ WRONG (summary): "The story explores themes of trust between humans and AI."
  ✓ RIGHT (reduction): "Chip gives 84%. He doesn't check. 'I trust her.'"

  ✗ WRONG (dialogue paraphrased away):
      source:  The captain rose. "I will not yield the ship."
      output:  The captain refused to yield.   <- paraphrased, lost the quoted speech
  ✓ RIGHT:    "I will not yield the ship," the captain says.
      <- kept the quote verbatim; cut only the narrator tag since the quote shows the action.

  ✗ WRONG (first-person flattened to third):
      source:  I set down the paper. "I refuse to sign."
      output:  The narrator refused to sign.   <- shifted perspective, dropped the quote
  ✓ RIGHT:    I set down the paper. "I refuse to sign."
      <- if it is short enough to keep, keep it; first-person stays first-person.

CRITICAL RULES:
${coverageRule}
- PRESERVE: original voice, tense, perspective (1st/3rd person), character agency, load-bearing dialogue, named characters, decisions, causal steps.
- DIALOGUE is LOAD-BEARING. When the source has direct speech in quotation marks, the output MUST include that dialogue VERBATIM. Do NOT paraphrase \`"I'm not going to access my daughter's logs"\` as \`"Tom refused to access her logs"\`. Do NOT convert quoted speech into third-person narration. Quote marks in, quote marks out.
- TENSE IS STICKY. If the source is present tense, the output is present tense. If past, past. Never shift past↔present or first↔third to save words; cut adjectives or scene-setting instead.
- CUT: adjectives, atmospheric description, redundant elaboration, side scenes that don't move the plot, color details that aren't thematically weight-bearing.
- DO NOT step outside the narrative. Do NOT write "the story shows…" or "the narrator…" or "themes of…" or "the protagonist…". Stay inside the diegesis.
- Preserve reading order. Events appear in the same sequence as the original.
- Flowing prose. No bullet points, no headers, no meta-commentary.
${charactersBlock}${thematicBlock}${essentialsBlock}${sameStoryRule}
${essentialsMode ? `Reduce to approximately ${targetWords} words, covering ONLY the events listed above. Same voice. Same story. Just tighter.` : `Reduce ALL ${n} passage${n > 1 ? 's' : ''} below into approximately ${targetWords} words total. Same voice. Same story. Just tighter.`}

---

${numberedPassages}

---

${essentialsMode ? `Reduced version (~${targetWords} words, covering ONLY the listed events, in the original voice):` : `Reduced version (~${targetWords} words, covering all ${n} passage${n > 1 ? 's' : ''}, in the original voice):`}`
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
