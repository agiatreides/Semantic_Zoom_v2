# Signal Hierarchy — Review & Proposed Redesign

> Scope: the prompts in `tools/extract-concepts.js` (event identification +
> min_visible_level) and `tools/lib/summarize.js` (per-level reduction).
> This doc is a **proposal to iterate on**, not a commitment to implement.
> Mark it up — reject framings, reorder priorities, ask for examples.

---

## 1. Two concerns got conflated. Separate them.

There are **two orthogonal axes** that both degrade L0 quality:

| Axis | What it controls | Current state | My earlier fix |
|------|------------------|---------------|---------------|
| **Orientation** — who/what is in the scene | Cold-readability: does a reader who has never seen the piece know who is acting? | Glossary dict exists but was applied loosely; now tightened with MANDATORY first-mention intro rule | ✅ Already shipped earlier today |
| **Signal hierarchy** — which propositions survive compression | Does L0 actually contain the load-bearing claims, or a punchline without the setup? | Bound to narrative-fiction framing ("causal chain", "inciting event") | ❌ Not addressed yet — this doc is about this |

The glossary fix solved orientation. It did **not** solve signal hierarchy. The user's question is about the second axis.

---

## 2. Diagnose the current prompt

`tools/extract-concepts.js:164-223` — `POKER_NUTS_PROMPT`. The fiction bias is baked in at three points:

**Line 171-181** — event definition:
> An "event" is a discrete THING THAT HAPPENS — a decision, an action, a dialogue exchange, a turn in the plot.

**Line 201-208** — story-arc template:
> A story is: [inciting event / pressure] → [complication or stakes] → [protagonist's response] → [outcome]

**Line 205-208** — corpus-specific example:
> "Tom refuses to check the logs" alone is NOT the nuts… The real L0 nuts for a trust-vs-verify story would be something like: [Tyler accuses Maya of cheating] → [Tom has the option to verify via AI logs] → [Tom refuses]

If you feed this prompt a New Yorker essay, a physics paper, or a cooking recipe, Claude will:
- Try to find a "protagonist" when there is none
- Invent a "causal chain" where there's an argumentative chain
- Label the thesis as an "event" and force-fit a verb
- Miss the actual load-bearing signal (thesis, key result, critical step)

The pipeline is currently a **narrative-fiction zoom reader** wearing a "semantic zoom" label.

---

## 3. Genre-agnostic principle (the through-line)

**"The nuts" = the minimum set of load-bearing propositions such that removing any one breaks the document's central logical structure.**

That criterion holds across every genre. What changes across genres is the **type** of proposition that counts as load-bearing:

- In narrative fiction → load-bearing events (decisions, turns)
- In argumentative writing → load-bearing claims (thesis, key evidence, rebuttal)
- In expository/explanatory writing → load-bearing definitions + implications
- In procedural writing → load-bearing steps (skip one → the procedure fails)
- In biographical/historical writing → load-bearing turning points
- In research papers → load-bearing contributions (problem, method, result, implication)

The criterion stays. The **target shape** changes.

---

## 4. Proposal: schemas, not few-shot examples

Few-shot examples balloon tokens (500+ per example) and bias toward the example's genre. Schemas are **~20-50 tokens each** and give Claude a target shape without prejudicing content.

Proposed schemas (one per genre):

| Genre | Schema |
|-------|--------|
| **Narrative** | `setup → inciting event → protagonist response → outcome` |
| **Argument** | `thesis → core evidence → counterclaim → rebuttal → conclusion` |
| **Expository** | `claim / definition → elaboration → implication` |
| **Procedural** | `prerequisites → critical steps (skip-breaks-it) → outcome test` |
| **Biographical** | `pivotal events → causal turns → consequences` |
| **Contribution** (research paper) | `problem → method → result → significance` |

Claude is asked: "Fit the document to the schema. Identify each element. Each element becomes a candidate for L0 or L1 depending on how load-bearing it is for this particular document."

The genre is the 20-token context. The schema is the target shape. The rest of the prompt stays generic.

---

## 5. Pipeline restructure — one cheap Pass 0

**Add a Pass 0 before Pass 1** in `extract-concepts.js`:

- **Pass 0** (new, ~1 cheap Claude call): Classify the document's primary mode — narrative / argument / expository / procedural / biographical / contribution / hybrid. Also emit the document's one-sentence thesis or central question.
- **Pass 1** (existing, redesigned): Given genre + thesis, apply the genre-specific schema to identify load-bearing propositions with `min_visible_level`. Keep the unified output shape (`events` remains the field name; it just now may hold claims or steps depending on genre).
- **Pass 2 & beyond** (unchanged): per-level anchor propagation.

Cost: one extra small Claude call per document. Negligible compared to the 20+ reduction calls already made.

---

## 6. What is genre-invariant (factor these out, keep them universal)

Regardless of schema, these are always load-bearing for a cold reader:

1. **Glossary** — named entities, products, technical terms. The reader needs to know what they are. *Already shipped.*
2. **Direct quotes / testimony** — when the piece uses verbatim speech or sourced quotation, preserving that speech verbatim at upper levels is load-bearing. *Already tightened.*
3. **Quantitative claims** — "500 million subscribers", "12% efficiency reduction", "84% probability". Numbers carry load across all genres.
4. **Proper-noun first mentions** — related to (1) but specifically the structural rule.

These four features go in the universal reduction prompt. They don't depend on genre.

---

## 7. Where the current failure modes actually live

| Failure | Axis | Where to fix |
|---------|------|--------------|
| "Tom" not introduced as narrator/father | Orientation | Glossary rule (shipped) |
| "NeuraBless" not explained | Orientation | Glossary — extend to entities (shipped for grin) |
| Cursor on "Maya" at L0 lands on 3rd/4th Maya at L2 | Cursor targeting | `src/main.js` `getConceptWordPosition` — separate from this review |
| L0 reads as punchline without setup | Signal hierarchy | Prompt redesign (this review) |
| "12% ROI" survived at L0 (pre-poker-nuts) | Signal hierarchy | Already addressed by poker-nuts framing |
| Novel-shaped reduction applied to a physics paper | Signal hierarchy | Genre detection (this review) |

Most user complaints to date have been orientation. Signal hierarchy is the **next** leverage point; it becomes visible only when we try non-fiction corpora.

---

## 8. Does this framework pass the three-genre test?

Advisor's test: *"Would this review apply to a New Yorker essay, a physics paper, and a cooking recipe?"*

| Document | Best-fit schema | L0 would contain | Cursor behaviour |
|----------|-----------------|------------------|------------------|
| **New Yorker essay** ("arguments wrapped in anecdote") | Argument + embedded narrative frame | Opening anecdote's pivot + thesis + 1 key example + conclusion | Hovering a name in the anecdote zooms stably; hovering the thesis zooms stably |
| **Physics paper** | Contribution | Problem statement + core result + one implication | Hovering the key finding preserves through all levels |
| **Cooking recipe** | Procedural | Ingredients list + 2-3 critical steps + outcome test | Hovering "rest the dough" expands to the timing + why it matters |

The framework holds. Hybrid documents (essay-with-narrative) are the stress case — see Open Questions.

---

## 9. Honest tradeoffs

**Pro one-universal-prompt** (don't do this work):
- Cheaper to maintain (one prompt)
- No genre-detection call
- Simpler pipeline

**Pro genre-aware (this proposal)**:
- Actually generalizes beyond fiction
- Each genre gets a prompt built for it, not retrofitted
- Token-light via schemas
- One extra cheap call per document

The cost of *not* doing this is that every non-fiction document will produce a novel-shaped reduction, and the reader will get the wrong signals at L0.

---

## 10. Open questions (for the user)

1. **Hybrid genres** — a New Yorker essay is argument-wrapped-in-narrative. Does the pipeline pick the dominant genre? Or run both schemas and merge? Or let Pass 0 emit a blended schema?
2. **Level count by genre** — a 2000-word short story has 6-7 levels today. Does a 10,000-word paper need more? Fewer? Does the schema dictate depth?
3. **Cursor-first-mention (the Maya case)** — is this a signal-hierarchy problem (Maya's introduction should be essential at L2+) or a cursor-targeting problem (when tracked word has multiple occurrences at a level, prefer the introductory one)? My position: **separate issue**, lives in `src/main.js`, not in the prompt redesign.
4. **Validation corpus** — should we pick a target document per genre to benchmark against before committing to genre-awareness? A New Yorker essay + a research paper + a recipe would cover most of the space. (*Not small, but: if we pick 3 documents now, run the current pipeline against them, and observe what breaks, we have a concrete failure list to design against.*)

---

## 11. Suggested next step

Before any code changes: pick **one non-fiction test corpus** (an essay or a paper). Run the *current* pipeline against it. Observe the failure modes concretely. That tells us whether the theoretical case in this doc holds in practice, and whether the proposal needs sharpening before implementation.

*The temptation is to start writing prompt code. Resist. The review is the work right now.*

---

## 12. User direction (after reading sections 1-11)

The user redirected scope:

> Focus on short stories. Get the poker-nuts prompt working properly there
> first. Then build the genre classifier with stubs for other types —
> common strategies where possible, because we don't want specific
> approaches for multiple genres where a shared one applies.

So the plan splits into two tracks:

1. **Short-story POKER_NUTS_PROMPT v2** (below) — the prompt needs concrete surgery for fiction before any genre routing matters.
2. **Genre classifier + stubs** (section 15) — scaffolds non-fiction genres minimally; short-story gets the fully-tuned prompt; other genres get placeholder routing + TODO stubs so the plumbing works end-to-end.

The rest of this doc is the deeper reflection the user asked for.

---

## 13. What's actually wrong with the current POKER_NUTS_PROMPT for short stories

Re-reading `tools/extract-concepts.js:164-223` against Lorin's taste signals and the two corpora in `data/`:

### 13a. It's event-centric; it misses reveals and shifts

> *"An event is a discrete THING THAT HAPPENS — a decision, an action, a dialogue exchange, a turn in the plot. Events are verb-driven."*

Good short fiction's nuts often aren't events. They're:

- **Reveals** — the narrator *is* the killer; she *wasn't* who she seemed.
- **Inner shifts** — "I realized I no longer cared."
- **Tonal pivots** — the moment a comedy becomes a tragedy (Arthur signs up for Gold in the grin; the prose register itself changes).
- **Perspective-reality mismatches** — unreliable narrator pulls back the curtain.

The current prompt will force-fit a verb onto these and lose them. "Arthur realizes logic is mud" is **closer to an inner shift than an event**. The forced verb "realizes" is a rounding.

### 13b. It doesn't ask for thematic thrust

A short story compresses MEANING, not just plot. Kafka's *Metamorphosis* opens with Gregor as a bug — trivial event, earth-moving meaning. The current prompt will find the event (turned into bug), call it min_visible_level=0, and miss that this story is *about* alienation and family obligation.

Without a thematic channel, L0 can be factually complete and still spiritually empty.

### 13c. Poker-nuts is a single-axis collapse test

The current test:
> *"If I cut this event from the level-N reduction, can the reader still follow what happened?"*

That's a **plot continuity** test. A short story collapses along four axes, not one:

| Axis | Collapse looks like |
|------|--------------------|
| **Plot** | "Wait, how did they get from A to C?" |
| **Stakes** | "Why should I care?" |
| **Meaning** | "What was the point?" |
| **Voice** | "This could be any story. There's nothing of the writer left." |

An event can be cuttable under "plot" but not "meaning." The test should multi-axis.

### 13d. Endings aren't privileged

The final beat of a good short story does more lifting than any middle beat. Current prompt treats all events as peers. In the grin: "Speech centers deactivated. Narrative Anchor discarded." is the story. That line alone. In the voting problem: "I decided because of what it would mean. What it would say about us. About who I want to be." is the story.

**A short story's ending is almost always L0-essential.** The prompt should say so.

### 13e. Openings aren't privileged

Openings establish world, voice, POV — they're how the reader enters. Often there's no "event" in the opening. But without it, the reader is lost at L0.

> *"So here's the thing about having a superintelligent AI living in your head: it ruins your ability to argue."*

That's the voting problem's opening. No verb-driven event. But it sets up EVERYTHING. Needs to survive at L0 or L1.

### 13f. Voice signal is ignored

The grin's voice IS the point. NeuraBless™ corporate-memo collage interleaved with Arthur's degrading diary. A reduction that captures the plot but flattens the voice is not the same story.

Short stories should identify **1-3 passages that carry the voice**, not just events. Those get anchor priority.

### 13g. The "L0 must be a causal chain" guidance is prose, not a gate

Lines 201-209 say it. But it's buried in paragraph prose that Claude can skim. A checklist would force the check.

### 13h. The example is the canonical corpus

> *"The real L0 nuts for a trust-vs-verify story would be something like: [Tyler accuses Maya of cheating] → [Tom has the option to verify via AI logs] → [Tom refuses]"*

Anti-reward-hacking (CLAUDE.md § Hard Rules): this Tom/Maya example biases Claude to look for similar patterns in other stories. Violates the rule. Needs replacement with a generic schema.

### 13i. No fiction-subgenre distinction

Flash fiction (500 words, a single image), literary short story (3000 words, slow-build), plot-driven story (3000 words, fast turns), parable (short, thematic) — these aren't the same thing. Current prompt treats them uniformly.

*Probably defer — but flag as a future-possible layer.*

### 13j. min_visible_level is per-event, not cross-checked

Each event gets a level in isolation. The prompt doesn't verify: "do all your L0 events together give a complete reading?" Left as an exercise for Claude's implicit taste.

A cross-check — "read your L0 set aloud as if it were the only thing a reader will see; is it complete?" — would tighten things.

---

## 14. Proposed POKER_NUTS_PROMPT v2 (for short stories)

Concrete redesign. Not yet written as code — this is the *spec* for the prompt. Keep for review before editing `extract-concepts.js`.

### 14a. Broaden the unit from "event" to "beat"

> *A **beat** is a moment that does load-bearing work in the story. It is usually one of:
> - an **action** or decision (verb-driven)
> - a **dialogue** exchange that carries stakes or reveals character
> - an **inner shift** — realization, change of stance, resolve
> - a **reveal** — new information that reframes what came before
> - a **tonal pivot** — the moment the register shifts (comic → tragic, realist → absurd)
> - a **voice-carrying passage** — a line or paragraph whose DICTION establishes the story's register*

### 14b. Multi-axis poker-nuts test

> *For each beat, ask four questions, not one:*
> - *Plot — if I cut it, can the reader still follow what happens?*
> - *Stakes — if I cut it, does the reader still care?*
> - *Meaning — if I cut it, does the story still mean what it means?*
> - *Voice — if I cut it, does the story still sound like THIS story?*
>
> *A beat is L0-essential if cutting it would collapse the story on at least one axis. A beat is L_max-only if cutting it would collapse nothing.*

### 14c. Explicit opening + ending privilege

> *The first beat and the last beat of a short story are almost always L0-essential. The opening establishes world, voice, POV. The ending lands the meaning. Give them strong consideration.*

Framed as a bias, not a hard rule — some stories break this (in media res, cyclical structures). Claude is allowed to override if the story warrants.

### 14d. Require a thematic thrust statement

> *In addition to the beats, return a single sentence answering: "What is this story ABOUT?" Not the plot. The thematic concern or central question.*

This anchors Claude's L0 completeness check and is useful metadata for the L0 reduction (we can pass it to `summarize.js` as a guide).

### 14e. L0 completeness gate

> *After assigning min_visible_levels, read back the set of L0 beats as if it were the ONLY thing a reader will see. Can a cold reader:*
> - *Enter the story? (world + POV established?)*
> - *Follow the pivotal turn? (cause → choice → consequence visible?)*
> - *Land with you? (ending gives meaning?)*
>
> *If any are No, promote another beat to L0. Iterate once.*

Explicit self-check, structured as a gate.

### 14f. Replace Tom/Maya example with a generic schema + one neutral one-liner

> *Fiction beats usually fit this shape:*
> *`[entry into world] → [pressure / rising action] → [pivotal choice or reveal] → [outcome / meaning]`*
>
> *(Example shape only — not a template to match. Some short stories are cyclical, some end mid-action, some are single-tableau. The schema is a bias, not a cage.)*

### 14g. Voice anchors

> *Separately from beats, identify up to 3 **voice-carrying passages** — lines or short paragraphs whose diction establishes the story's register. These may or may not overlap with beats. They become candidate anchors for the upper levels, so the reduced text can still SOUND like the story.*

### 14h. Tone: "identify, don't invent"

> *Every beat must be PRESENT in the text. You are not writing a better story; you are finding the most-compressed subset of THIS story that still reads as this story.*

(Already in the current prompt; strengthen phrasing.)

---

## 15. Genre classifier + stubs architecture

Minimal scaffolding so the pipeline can route on genre without over-engineering the non-fiction paths yet.

### 15a. New tool: `tools/classify-genre.js`

- One Claude call per document
- Input: first ~1000 words of the source text
- Output: JSON — `{ genre: "short_story", confidence: 0.9, secondary: null }`
- Supported genres: `short_story`, `novella`, `novel_excerpt`, `essay`, `argument`, `exposition`, `procedural`, `research_paper`, `biography_memoir`, `reference` (Wikipedia-style)

### 15b. Dispatch in `extract-concepts.js`

```
genre = classify(input)
promptBuilder = PROMPT_REGISTRY[genre] || PROMPT_REGISTRY.default
prompt = promptBuilder(text, totalWords, levelCount, targetCount)
```

### 15c. Prompt registry

- `short_story` → fully-built PROMPT_NUTS_V2 (the real work, per section 14)
- Every other genre → a stub that logs a warning and falls through to the narrative prompt. Includes a TODO comment block in the code marking what each stub needs to become.

### 15d. The stubs need a TODO block each, naming the schema

A stub for `essay` looks like:

```javascript
// TODO(argument-schema): replace with argument-specific prompt
// Proposed schema: thesis → core evidence → counterclaim → rebuttal → conclusion
// See SIGNAL_HIERARCHY_REVIEW.md section 4.
function essayPrompt(...) {
  console.warn('[genre=essay] using narrative fallback — refine me.')
  return shortStoryPrompt(...)
}
```

Visible, self-documenting, easy to claim and fill.

---

## 16. Which genres can share a strategy (grouping proposal)

Don't build 10 prompts. Build **5 or 6 strategies**, let genres map in:

| Strategy | Genres served | Schema |
|----------|---------------|--------|
| **Narrative** | short_story, novella, novel_excerpt, biography_memoir (partially) | setup → pressure → pivot → outcome (with voice anchors) |
| **Argument** | essay, op-ed, blog post (when argumentative), academic argument | thesis → evidence → counter → rebuttal → conclusion |
| **Exposition** | Wikipedia entry, reference, explainer blog, textbook chapter | claim/definition → elaboration → implication |
| **Procedural** | recipe, how-to, manual | prerequisites → critical steps → outcome test |
| **Research** | scientific article, white paper | problem → method → result → significance |
| **Personal narrative** (hybrid) | memoir, autobiography, personal essay | narrative schema + thematic channel (explicit "what is this about?") |

Six strategies cover ~90% of the space. Hybrid / edge-case docs fall back to narrative + thematic channel.

---

## 17. Updated open questions

1. **Voice anchors at the renderer** — section 14g proposes voice-carrying passages. Does the renderer treat them as regular concepts (`min_visible_level` handling), or a separate layer (always preserved, independent of concept zoom)? My intuition: regular concepts with `min_visible_level` tuned low.
2. **Multi-axis test — does Claude actually do it?** Section 14b asks four questions per beat. Claude might flatten them. Worth probing in a small test before committing.
3. **L0 completeness gate (section 14e)** — this is a self-review loop in the same prompt. Adds tokens but probably worth it. OK to try?
4. **Thematic-thrust sentence (section 14d)** — should this be stored in the tree JSON and passed to the reduction prompt as a guide? Or just used once at extract time? My intuition: both; store it and inject into `summarize.js` as context.
5. **Stubs: how loud?** Section 15d suggests `console.warn`. Alternative: a required `--genre-confirm` flag when non-narrative is routed, so the operator explicitly OKs a stub run. Stricter.
6. **Short-story subgenres (flash / literary / plot-driven / parable)** — defer, or include a one-line hint field at classification time?

---

## 18. Suggested concrete next step (updated)

1. Get alignment on sections 13 and 14 with the user (this doc).
2. Implement PROMPT_NUTS_V2 for short stories in `extract-concepts.js`.
3. Implement `classify-genre.js` with stubs for the other 9 genres.
4. Re-run on both corpora (voting problem + grin) and compare L0.
5. Only then consider expanding a single non-fiction genre to concrete prompt.

*Still resist writing prompt code until sections 13-14 are signed off.*
