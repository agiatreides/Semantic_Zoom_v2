# Semantic Zoom v2

Canvas reader for semantic zooming over prose. Hover an idea, left-click to
zoom in, right-click to zoom out, and the text changes detail level while
the cursor stays anchored to the same concept. The wheel scrolls the current
level normally.

The checked-in demo corpora run without any model calls:

- `the-voting-problem-auto.json`
- `architecture-of-the-grin-auto.json`
- `the-bitter-lesson-auto.json`

## Run the Demo

```bash
npm install
npm run dev -- --port 5181
```

Open `http://localhost:5181/?file=the-voting-problem-auto.json`.

Use the picker in the upper-right corner to switch corpora. Left-click over
text to zoom in, right-click over text to zoom out, and use the wheel or
right scrollbar to pan long levels.

## Validate Data

```bash
npm run validate:data
```

The validator checks tree shape, phrase links, concept-anchor bounds, and
visible concepts that are missing anchors. Warnings are useful: missing
visible anchors can still render, but they are likely places to inspect if
cursor anchoring feels unstable.

Use strict mode when preparing release data:

```bash
node tools/validate-data.js --strict
```

## Generate a New Corpus

Drop a `.txt` file in `data/`, then run:

```bash
node tools/generate-tree.js data/my-document.txt
node tools/extract-concepts.js data/my-document-auto.json
node tools/generate-tree.js data/my-document.txt --concepts data/my-document-auto-concepts.json
node tools/extract-concepts.js data/my-document-auto.json
```

Then add an option for `my-document-auto.json` in `index.html`.

The pipeline is intended to be fully automatic. Do not hand-author per-document
concept files; stale or invalid anchors should be regenerated or repaired by
generic tooling.

## Core Files

- `src/main.js` — input handling, zoom anchoring, hit-testing, debug API.
- `src/renderer.js` — canvas rendering.
- `src/text-layout.js` — line wrapping and measurement.
- `tools/generate-tree.js` — text to multi-level tree.
- `tools/extract-concepts.js` — concept/signal extraction and anchor placement.
- `tools/rebuild-levels.js` — direct source-to-level rebuild for polished demo corpora.
- `VERIFY.md` — regression contract for UI changes.
