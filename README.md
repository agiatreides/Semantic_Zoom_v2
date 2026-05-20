# Semantic Zoom

Canvas-based reader for zooming through prose without losing your place.
Left-click a word to zoom into more detail, right-click to zoom out, and the
text under the cursor stays anchored to the same idea. Drag, scroll, or use
the right scrollbar to pan long levels.

## Demo

<video src="https://github.com/agiatreides/Semantic_Zoom_v2/raw/main/media/bitter-lesson-zoom.mp4" poster="https://github.com/agiatreides/Semantic_Zoom_v2/raw/main/media/bitter-lesson-zoom-poster.png" controls muted playsinline width="760"></video>

The clip zooms into Rich Sutton's "The Bitter Lesson" from the phrase
"plateaus and inhibits progress" while keeping the selected idea under the
cursor. [Download the clip](media/bitter-lesson-zoom.mp4) if the player does
not load.

The checked-in corpora run entirely from static JSON:

- `the-voting-problem-auto.json` - synthetic short story
- `architecture-of-the-grin-auto.json` - synthetic short story
- `the-bitter-lesson-auto.json` - public-domain essay
- `ada-lovelace-wikipedia-auto.json` - reference biography excerpt
- `fair-guiding-principles-excerpt-auto.json` - research-paper excerpt

## Quickstart

```bash
npm install
npm run dev
```

Open `http://localhost:5181/?file=the-voting-problem-auto.json`.

Use the picker in the upper-right corner to switch corpora.

## Controls

- Left click over text: zoom in.
- Right click over text: zoom out.
- Drag on the text area: pan the current level.
- Mouse wheel or trackpad scroll: pan normally.
- Right scrollbar: drag or page through long levels.

## Validate

```bash
npm test
```

This runs the corpus validator and a production build. The validator checks
tree shape, phrase links, concept-anchor bounds, and missing visible anchors.
Warnings identify data quality issues worth inspecting, but only validation
errors fail the command.

## Generate A Corpus

The demo data is prebuilt. Generating new corpora is optional and requires a
local `claude` CLI in `PATH`.

```bash
npm run ingest:fast -- data/my-document.txt
```

Then add the generated `my-document-auto.json` file to the picker in
`index.html`.

Useful options:

```bash
npm run ingest:fast -- data/my-document.txt --levels 6 --concept-count 16
npm run ingest:fast -- data/my-document.txt --effort medium --no-batch
npm run repair:links -- data/my-document-auto.json --phrase-maps
```

The pipeline is intended to be automatic. Do not hand-author per-document
concept files; stale or invalid anchors should be regenerated or repaired by
generic tooling.

## Architecture

- `src/main.js` - app boot, input handling, zoom anchoring, hit testing,
  debug API.
- `src/renderer.js` - canvas drawing.
- `src/text-layout.js` - line wrapping and measurement.
- `tools/ingest-fast.js` - one-command corpus ingest path.
- `tools/extract-concepts.js` - concept extraction and anchor placement.
- `tools/rebuild-levels.js` - source-to-level rebuild for polished corpora.
- `tools/rebuild-child-links.js` - model-free parent/child link repair.
- `tools/validate-data.js` - static corpus validation.

The runtime uses two anchor layers:

- `concepts[].anchors[level]` preserves semantic identity across zooms.
- `nodes[].phrases[].matchIn/matchOut` provides a phrase-chain fallback and
  helps choose the best surviving word when text changes between levels.

The debug surface is available as `window._sz` while the app is running. See
`VERIFY.md` for the invariants and browser-check procedure.

## Data And Licensing

Source attribution for checked-in corpora is in `data/SOURCES.md`. Third-party
package and model notices are in `THIRD_PARTY_NOTICES.md`. Generated JSON
corpora are derived from the adjacent `.txt` files and inherit their source
text licenses. The application code is MIT licensed.
