---
status: UNOFFICIAL - PENDING LORIN REVIEW
author: agent-backfill-draft
generated_date: 2026-04-18
project: Semantic Zoom v2
mode: full-draft
---

# Intent Spec — Semantic Zoom v2

> **IMPORTANT:** Gap-report and gap-closer agents MUST refuse to operate on this UNOFFICIAL spec until Lorin removes the `UNOFFICIAL` marker by promoting it to OFFICIAL. This draft is scaffolding assembled by an agent from code + project docs + Second Brain sweep. Lorin has not confirmed authorship of any claim here.

## What This Is

Semantic Zoom v2 is a canvas-based reader where the user scrolls to zoom through ~6 levels of progressively-coarser/finer renditions of the same text, with the idea **under the cursor staying under the cursor across zoom levels.** Per the project's own CLAUDE.md: *"Feed in any prose, get zoom-without-drift out — fully automated"* (per `Second_Brain/Projects/Semantic_Zoom_v2/CLAUDE.md` lines 7–19). V2 exists because v1 failed on two axes: (a) it required hand-curated per-document data files, and (b) earlier agent "fixes" for the zoom-drift bug were token-specific reward hacks rather than generic mechanism fixes (per `VERIFY.md` lines 42–56 and `CLAUDE.md` line 68).

The long intellectual line that motivates this work runs through two of Lorin's 2025 invention dictations: the July IDE-plugin dream of *"zoom out at max, you see a 3D representation of the code… zoom in, and eventually you do get to code once you kind of reach token parity"* (per `Second_Brain/Inventions/Bits/Developer_Tools/Semantic_Zoom_IDE_Plugin_Code_To_English.md` line 36, source C-0442), and the November re-framing as *"the nuts. After the poker, nuts. If you have the nuts, you know"* — the minimum set of load-bearing propositions such that removing any one breaks the document (per `Second_Brain/Inventions/Bits/Developer_Tools/Cogency_Breakdown_Text_Density_Tool.md` line 39, source C-0117). Semantic Zoom v1 was the first prototype; v2 is the split that tries to make the pipeline genuinely automatic and the zoom mechanism genuinely generic.

## How It Works

The project is a three-part pipeline that produces data files for a vanilla-JS + canvas renderer (inferred from `package.json` and the `tools/` + `src/` split).

**1. Tree generation** — `tools/generate-tree.js` (684 lines). Bottom-up RAPTOR-style build: semantic chunk the source `.txt` (via the `semantic-chunking` npm package + ONNX embeddings from `@huggingface/transformers`), cluster leaf nodes with k-means (`tools/lib/cluster.js`), summarize clusters into parents via Claude CLI calls (`tools/lib/summarize.js`, 411 lines), repeat upward until a single root. Output is reversed so root is level 0 and leaves are level N (roughly 6 levels for a 2-3k-word short story) (inferred from `tools/generate-tree.js:1-19` docstring).

**2. Concept extraction** — `tools/extract-concepts.js` (760 lines). Identifies "events" / "beats" in the source text, scores each a `min_visible_level` using the **poker-nuts framing** (*L0 contains only the events the story collapses without*), and propagates per-level anchors down through the tree via Claude CLI plus literal/fuzzy substring matching. Emits a sibling `<basename>-concepts.json` (per `CLAUDE.md` lines 36–44 and `VERIFY.md` lines 266–273).

**3. Re-reduction pass (v2-specific)** — rerunning `generate-tree.js --concepts <concepts.json>` re-reduces upper levels **using only the events whose `min_visible_level <= L`**. This is what pulls L0 out of the "12% lower ROI" summary-slop failure mode the earlier version produced; L0 is built from the nuts only, not from the full leaf population (per `CLAUDE.md` lines 40–44 and `VERIFY.md` changelog entry dated 2026-04-16 "Poker-nuts pipeline + L0→L1 fix").

**The renderer** — `src/main.js` (884 lines), `src/renderer.js`, `src/text-layout.js`. Canvas 2D; wheel-driven zoom with ~0.12 transition-speed crossfade; cursor-anchored zoom locks the tracked concept for the duration of a continuous wheel session and clears on >2px mouse motion. A `window._sz` debug API lets headless tests assert identity without OCR (per `CLAUDE.md` lines 94–100 and `VERIFY.md` lines 64–88). As of 2026-04-17 the app has a canvas-drawn scrollbar replacing edge-triggered auto-scroll (per `VERIFY.md` changelog 2026-04-17).

**Data orthogonality.** The data file ships two separate anchor structures: `concepts[].anchors[L]` (per-concept per-level, identity-preserving by construction, used for zoom positioning) and `treeData.levels[L].nodes[i].phrases[j].matchIn/matchOut` (per-phrase forward/backward chains, useful as fallback but does NOT preserve concept identity reliably). The wheel handler prefers concept anchors and falls back to the phrase chain (per `CLAUDE.md` lines 85–94).

**Cursor targeting — the user-facing contract.** The cursor is the user's intent pointer. The reader hovers over a WORD, and the system locks onto the CONCEPT most semantically relevant to that word (not whatever concept happens to have an anchor geographically nearest to the cursor). The rules the renderer is expected to enforce:

1. **Hover locks onto the semantically-right concept.** Hovering on "logs" locks onto the concept whose L_max snippet contains "logs" — even if the cursor's current paragraph has no concept anchor of its own. Hovering on "relationship" locks onto the concept whose snippet contains "relationship". The locked concept is shown in the HUD (`◆ Tom refuses to access his daughter's logs`).
2. **Scrolling zooms while preserving the locked concept.** Once a concept is locked, subsequent scroll-wheel events zoom in or out and keep the cursor on THAT concept's anchor at every new level. The text shifts; the cursor does not.
3. **Moving the cursor to a different word re-targets.** Moving the cursor (more than ~2 pixels) ends the current zoom session. The next scroll-wheel event re-acquires whichever concept is semantically matched by the new hovered word. The user never has to "release" a lock explicitly.
4. **Drift is defined by the user's intent, not by Y-distance.** A zoom result that places the cursor on "another part of the story" — content that does not semantically match the word the user started with — is a bug. The anchor lookup must prefer lexical match of the hovered word against each concept's defining content, and only fall back to spatial proximity when no word match exists.

The prior "closest-by-Y" fallback violated this contract: when a word had no concept anchor in its own paragraph, the cursor would lock onto whichever anchor's Y was nearest, even if that anchor was about an unrelated moment. The April 20 fix in `src/main.js findConceptAtCursor` adds a semantic-word-match fallback (stem-match the hovered word against each concept's label + L_max anchor text, pick the closest-Y match among those that test positive) before ever falling to pure spatial proximity.

**Current corpus** — two short stories from the 72 Futures fiction pipeline: `the-voting-problem-auto.json` (default) and `architecture-of-the-grin-auto.json`. Tree builds are 6 levels each; concept files are regenerated sidecars, never hand-edited (per `CLAUDE.md` lines 102–107 and `data/` listing).

## What Done Looks Like

From `CLAUDE.md` lines 7–15: the user drops any prose `.txt` (research paper, book chapter, short story, essay, long-form article) into `data/`, runs two commands, reloads the page, and gets a reader where hovering over any word and scrolling keeps that word's concept under the cursor across all 6 levels. Concretely:

1. **Fully automated pipeline.** Zero hand-curation. Any prose input → valid tree + concepts sidecar. No per-document JSON authorship by a human (per `CLAUDE.md` lines 17–19).
2. **The regression matrix passes.** All six canonical concepts in `VERIFY.md` (`tom_trusts_wont_check`, `chip_runs_numbers`, `chip_interrupts_maya_alert`, `did_you_cheat_maya_no`, `optimization_not_wisdom`, `closing_got_it_right`) preserve identity across L0↔L5 zooms in both directions (per `VERIFY.md` lines 95–111). As of the 2026-04-17 changelog, this is passing on one corpus.
3. **Genre-aware extraction.** Short-story extraction is fully tuned (`PROMPT_NUTS_V2`); classifier `tools/classify-genre.js` routes documents to one of ten genres; stubs exist for the other nine, each with a TODO naming the schema to plug in (inferred from `tools/classify-genre.js:1-33` + `SIGNAL_HIERARCHY_REVIEW.md` §15). "Done" for v2 means at minimum one non-fiction genre (essay OR research paper) has its schema filled in and its own regression corpus.
4. **The cold-reader invariant holds.** L0, read with no prior context, lets a cold reader enter the story, follow the pivotal turn, and land with the meaning. *"Maya is accused. He could check the logs. He doesn't."* — not *"The story explores parental oversight"* (per `CLAUDE.md` lines 71–77, `SIGNAL_HIERARCHY_REVIEW.md` §14e).
5. **No reward-hacking diff.** Any future fix touches the generic mechanism (`findConceptAtCursor`, wheel-handler anchor lookup, phrase↔concept bridge) and does not mention specific tokens, concept IDs, or labels as literals in code (per `VERIFY.md` lines 266–279 and a global feedback rule in `MEMORY.md` → `feedback_semantic_zoom_no_reward_hacking.md`).

## Non-Goals

- **Not v1 (`Second_Brain/Projects/Semantic_Zoom/`).** V1 is the 10-level hand-curated prototype with 204 phrase-anchored concepts aligned by haiku agents (per `Second_Brain/Projects/Semantic_Zoom/ORIENTATION.md` lines 87–113). V2 replaces human authoring with the three-step pipeline; v2 is explicitly 6 levels, not 10 (per `CLAUDE.md` lines 14 + 30).
- **Not summarization.** Every level is the SAME story told tighter — same voice, same tense, same perspective, same character agency. The reader is reading the work, not a description of it (per `CLAUDE.md` lines 71–77; same principle carried forward from v1's ORIENTATION.md lines 7–9).
- **Not an IDE plugin.** The C-0442 origin dream applied semantic zoom to code; the prototype applies it to prose because the alignment problem is more tractable on narrative than on code semantics (per `Second_Brain/Wiki/projects/Semantic_Zoom.md` lines 38–40). Code is deferred, not abandoned.
- **Not a topic map / theme-coloring tool.** The sibling project Idea Classifier owns theme-recurrence visualization (per `Second_Brain/Projects/Idea_Classifier/intent_spec.md` lines 4–20). Per Lorin's April 16 dictation, Semantic Zoom is now understood as *a facet of the Idea Classifier umbrella* alongside Newspaper Fact-Checker (per `Second_Brain/Journal_Personal/Project_Deck_Review_April_16_2026.md` line 35), but v2's narrower job is the zoom reader specifically, not the cross-referencing color system.
- **Not multi-document.** One document at a time. No corpus-wide concept graph, no cross-document anchors.

## Constraints

- **Hardware.** 16GB laptop; `@huggingface/transformers` runs ONNX embeddings locally at build time. Claude CLI is invoked via `execSync` (`tools/generate-tree.js:30`), not the API — Lorin is Pro-Max and never uses API keys (per `MEMORY.md` → `feedback_no_api_keys.md`).
- **Port.** Vite dev server on `5181` (v1 uses `5180` — do not collide). Headless testing only via `$B`, never `open` a URL (per `CLAUDE.md` lines 117–123 and global `permission_gotchas.md`).
- **Tech stack.** Vanilla JS + canvas 2D; npm deps are intentionally minimal (`vite`, `semantic-chunking`, `skmeans`, `@chenglou/pretext`, `@huggingface/transformers` dev-only) (per `package.json`).
- **File naming.** Data files never patched by hand. If a concepts file is stale (anchors out of range), regenerate — don't hand-edit (per `CLAUDE.md` lines 103–107).
- **Anti-reward-hacking gate.** The six-concept regression matrix and the anti-hack checklist in `VERIFY.md` lines 266–279 are mandatory before declaring any zoom-mechanism fix done. The project has already burned one "fix" that biased toward the `not` token and broke every other word (per `VERIFY.md` lines 45–51 and `MEMORY.md` → `feedback_semantic_zoom_no_reward_hacking.md`).
- **Browser Verification Protocol** from the top-level `CLAUDE.md` applies verbatim; `VERIFY.md` is the contract (per `Second_Brain/Projects/Semantic_Zoom_v2/CLAUDE.md` lines 58–64).

## Related Second Brain Content

Files outside the project folder that inform or frame this project:

- **`Second_Brain/Inventions/Bits/Developer_Tools/Semantic_Zoom_IDE_Plugin_Code_To_English.md`** — the July 2025 origin dictation (C-0442) — zoom-out = 3D code in essence, zoom-in = tokens, pre-generated, updated live.
- **`Second_Brain/Inventions/Bits/Developer_Tools/Cogency_Breakdown_Text_Density_Tool.md`** — the November 2025 dictation (C-0117) that names "the nuts" and defines the poker-essential framing that drives the `min_visible_level` machinery.
- **`Second_Brain/Projects/Semantic_Zoom/ORIENTATION.md` + `CLAUDE.md`** — v1's canonical principle ("every zoom level represents the complete content from start to end") and 10-level hand-curated architecture; v2 inherits the principle and replaces the hand-curation.
- **`Second_Brain/Wiki/projects/Semantic_Zoom.md`** — Template C synthesis tying v1 into the broader Second Brain project web and naming Idea Classifier + Sifting Machine as sister projects.
- **`Second_Brain/Projects/Idea_Classifier/intent_spec.md`** — OFFICIAL intent for the sibling project; the recurring-topic color-map vision that Semantic Zoom v2 is a "facet of" per Lorin's April 16 deck review.
- **`Second_Brain/Journal_Personal/Project_Deck_Review_April_16_2026.md`** — Lorin's own framing: *"Semantic Zoom is also part of the idea classifier… I believe Semantic Zoom is one of the furthest along in that regard."*
- **`Second_Brain/Inventions/Bits/AI_Tools/AI_Book_Distillation_Fair_Use_794290b616844595b851645d71e527d1.md`** + **`Second_Brain/Predictions/DeepSeek-OCR Token Cost Halving Prediction.md`** + **`Second_Brain/Journal_Intellectual/AI_Technical/Language as Compressed Data vs Visual Information.md`** — adjacent thinking on text compression; framing context, not direct input.
- **`Second_Brain/Orientation_Docs/INTENT_SPEC_INVENTORY.md`** — flags both v1 and v2 as MISSING intent specs; v2 listed as "Active split from v1."

Queries used: `"semantic zoom text compression"`, `"importance guided hierarchy zoom"`, `"phrase map concept extraction"`, `"tree constrained zoom visualization"`, plus grep for `Semantic Zoom`, `poker.nuts`, and `Projects:.*Semantic.Zoom`.

## Confidence + Open Questions

- **Confidence:** medium-high. The project has dense local documentation (CLAUDE.md, VERIFY.md with a full dated changelog, SIGNAL_HIERARCHY_REVIEW.md) and ~3,500 lines of code; the "what" and "how" are well-grounded in cited source. The "why this is split from v1" framing is inferred from the deltas (6 vs 10 levels, pipeline vs hand-curated, `tools/generate-tree.js` vs v1's `build_concepts.cjs`) rather than stated in a dedicated v2-charter file.
- **Evidence base:** project folder read in full (CLAUDE.md, VERIFY.md, SIGNAL_HIERARCHY_REVIEW.md, package.json, index.html, all `tools/` entrypoints inspected, `src/main.js` header); v1's ORIENTATION.md + CLAUDE.md read (read-only); four sb_embed semantic queries; grep sweeps for project name, "poker nuts," and Projects: field; reviewed Wiki synthesis + April 16 deck review + two origin invention files + Idea Classifier intent spec.
- **Open questions for Lorin:**
  1. Is v2 meant to **replace** v1 eventually, or coexist (v1 keeps the 10-level curated artifact, v2 owns the automated pipeline)? v1's `ORIENTATION.md` frames 10 levels as canonical; v2's `CLAUDE.md` calls 10 "overkill."
  2. Under the Idea Classifier umbrella framing (per April 16 deck review), does v2 stay a standalone deck project, or get absorbed into Idea Classifier as a rendering surface?
  3. Is the v2 "done" bar short-story-only, or does it require at least one non-fiction genre shipped? The draft above assumes the latter; SIGNAL_HIERARCHY_REVIEW.md §17–18 defers this.
  4. The 2026-04-17 scrollbar work implies long-form docs are in scope — what's the target word-count ceiling? Affects level count and pipeline cost.
  5. Voice anchors (SIGNAL_HIERARCHY_REVIEW.md §14g): regular concepts with tuned `min_visible_level`, or a separate always-preserved layer?
