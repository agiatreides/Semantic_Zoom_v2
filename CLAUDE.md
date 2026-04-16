# Semantic Zoom v2 — subproject CLAUDE.md

> Loaded automatically by ROUTER Rule 7 when working inside this directory.

## Intent (the goal)

**Feed in any prose, get zoom-without-drift out — fully automated.**

The user wants to drop in a research paper, a book chapter, a short
story, an essay, a long-form article, or any other piece of running
prose. Run a pipeline. Open the renderer. Hover over a word. Scroll.
The cursor stays anchored to that idea as the text gets coarser or
finer underneath. No hand-curation of concepts. No artisanal tree
authoring. ~6 zoom levels is the target (10 is overkill).

Anything in this project that requires a human to author per-document
data files is a bug, not a feature. Earlier experimental artifacts
(an older agent-generated 10-level tree, a hand-curated concepts
sidecar) have been deleted. The pipeline is the source of truth.

## What this project is

Canvas-based semantic-zoom reader. The user scrolls the wheel to zoom; the
text is replaced with a coarser/finer rendition. The intent is that the
**concept under the cursor** stays under the cursor across zoom levels.
That invariant is the entire product.

Stack: vite, vanilla JS, canvas 2D context. Data is pre-baked as JSON.
The pipeline:

1. `tools/generate-tree.js <text.txt>` → builds the multi-level tree
   (semantic chunking → contiguous clustering → Claude CLI summarization,
   bottom-up RAPTOR style). Currently produces ~6 levels.
2. `tools/extract-concepts.js <tree.json>` → produces a sibling
   `<basename>-concepts.json` with per-level anchors for each major
   concept. Required for zoom-without-drift; the renderer auto-loads it
   if it exists.

Both tools must be runnable on any prose input with no manual editing.

Sources of truth:

- `src/main.js` — boot, input, zoom logic, hit-testing. The wheel handler
  is the place where zoom anchoring happens.
- `src/renderer.js` — canvas drawing.
- `src/text-layout.js` — line wrapping / measurement.
- `tools/generate-tree.js` — offline corpus → tree builder.
- `data/*.json` — corpus + concepts.

## Hard rules

1. **`VERIFY.md` is the contract.** Before claiming a UI change works,
   run the regression set in `VERIFY.md`. Update the regression matrix
   with the date + result. The browser verification protocol in the
   project root `CLAUDE.md` ("Browser Verification Protocol") applies
   verbatim.

2. **Never special-case a concept, token, or label.** A prior agent
   "fixed" the `not` zoom by biasing toward the `not` token; the result
   was that ALL words zoomed toward `not`. Any fix must be a generic
   mechanism that treats every concept symmetrically. The anti-reward-
   hacking checklist in `VERIFY.md` is mandatory before declaring done.

3. **Concepts vs phrases.** The data file ships two separate anchor
   structures:
   - `concepts[].anchors[L]` — per-concept per-level anchor. Identity-
     preserving by construction. Use this for zoom positioning.
   - `treeData.levels[L].nodes[i].phrases[j].matchIn / matchOut` —
     per-phrase forward/backward index chains. Useful as a fallback /
     building block, but DOES NOT preserve concept identity reliably.
   The current wheel handler uses the phrase chain. The drift bug is
   most likely there.

4. **Use the `window._sz` debug API for headless testing.** It exposes
   `concepts`, `currentLevel`, `findConceptAtCursor`,
   `getConceptPosition`, `findPhraseAtCursor`, `levelOffsets`,
   `defaultOffset`. This is in `src/main.js` lines 568-584 — preserve it
   when refactoring; the verification loop depends on it.

5. **Single corpus today.** `the-voting-problem-auto.json` (6 levels,
   pipeline output) plus its `*-concepts.json` sidecar. Adding a new
   document = drop the `.txt` next to it, run `generate-tree.js`, run
   `extract-concepts.js`, add an option to `index.html`. Never patch
   data files by hand; if a concepts file is stale (anchors out of
   range), regenerate it.

## When debugging

- Reproduce first via the procedure in `VERIFY.md` Step 2.
- Inspect both `findConceptAtCursor` (concept-level identity) and
  `findPhraseAtCursor` (phrase-chain) to see where they diverge.
- Read `console --errors` after every interaction.
- Snapshot at each zoom level so the visual trail is preserved.

## Server quick reference

```
Start:  cd <projdir> && npx vite --port 5181 > /tmp/semzoom_v2.log 2>&1 &
Port:   5181
Check:  lsof -i :5181 -t
Kill:   lsof -ti :5181 | xargs kill 2>/dev/null
```

## File layout

```
Semantic_Zoom_v2/
├── CLAUDE.md         (this file)
├── VERIFY.md         (verification spec + regression matrix)
├── index.html        (single page, picks default corpus)
├── package.json      (npm: vite + semantic-chunking + skmeans + pretext)
├── vite.config.js    (port 5181)
├── src/
│   ├── main.js       (boot, input, zoom, hit-test, debug exports)
│   ├── renderer.js   (canvas)
│   ├── text-layout.js
│   └── style.css
├── tools/
│   ├── generate-tree.js         (offline tree builder)
│   ├── add-phrase-maps.js
│   └── lib/                     (cluster, schema, summarize)
└── data/
    ├── the-voting-problem.json              (hand-crafted, 10 levels)
    ├── the-voting-problem-auto.json         (auto, 6 levels — default)
    ├── the-voting-problem-auto-concepts.json (concept anchors)
    └── _leaf_spans.json, _summarization_tasks.json (build artifacts)
```
