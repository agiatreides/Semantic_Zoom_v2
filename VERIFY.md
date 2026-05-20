# Verification

This file defines the release checks for the semantic zoom reader.

## Core Invariant

The cursor is the user's intent pointer. When the user zooms, the idea under
the cursor should remain under the cursor at the next level. If the exact word
survives the phrase-chain projection, the app should land on that word first;
concept-anchor placement is the fallback.

The fix must be generic. Do not special-case a token, concept id, document, or
label to make one regression pass.

## Local Server

```bash
npm run dev
```

Default URL:

```text
http://localhost:5181/?file=the-voting-problem-auto.json
```

## Static Checks

```bash
npm test
```

This runs:

```bash
npm run validate:data
npm run build
```

`validate:data` reports warnings for missing visible anchors. Warnings are
useful diagnostics; validation errors are release blockers.

## Manual Browser Checks

Run these against at least two corpora before changing zoom, hit-testing, or
layout code:

- `the-voting-problem-auto.json`
- `architecture-of-the-grin-auto.json`
- `the-bitter-lesson-auto.json`
- `ada-lovelace-wikipedia-auto.json`
- `fair-guiding-principles-excerpt-auto.json`

For each corpus:

1. Open `http://localhost:5181/?file=<corpus>`.
2. Confirm the canvas renders and the file picker is visible.
3. Left-click several words in different parts of the document.
4. Confirm the cursor lands on the same word when possible, or on the same
   concept when the exact word does not survive.
5. Right-click to zoom back out and confirm identity does not jump to a sibling.
6. Drag the text area and confirm it pans without triggering a zoom.
7. Scroll with the wheel or trackpad and confirm the zoom level does not change.
8. Check the browser console for errors.

## Debug API

The app exposes `window._sz` for headless and manual verification:

```js
window._sz.concepts
window._sz.currentLevel
window._sz.displayLevel
window._sz.hoveredConcept
window._sz.hoveredWord
window._sz.findConceptAtCursor(level, offset)
window._sz.getConceptPosition(concept, level)
window._sz.getConceptCenterPosition(concept, level)
window._sz.getConceptWordPosition(concept, level, word, hintChar)
window._sz.findPhraseAtCursor(level, contentY, contentX)
window._sz.hitTestWord(level, offset)
window._sz.levelOffsets
window._sz.defaultOffset(level)
window._sz.zoomAtCursor(direction)
window._sz.scrollCurrentLevel(deltaY, deltaX)
window._sz.getScrollbarGeom(level)
window._sz.sbDragging
window._sz.viewDragging
```

A browser harness can place the mouse over a concept by:

1. Looking up the concept in `window._sz.concepts`.
2. Calling `getConceptCenterPosition(concept, level)`.
3. Converting content coordinates to screen coordinates with the centered
   640px column.
4. Dispatching click or contextmenu events.
5. Reading `findConceptAtCursor(...)`, `hoveredWord`, and `trackedConcept`.

## Browser Smoke Matrix

The current publication-cleanup smoke was run on 2026-05-20:

| Corpus | Concepts | min-to-max + max-to-min transitions |
|--------|----------|--------------------------------------|
| `the-voting-problem-auto.json` | 19 | smoke passed |
| `architecture-of-the-grin-auto.json` | 16 | smoke passed |
| `the-bitter-lesson-auto.json` | 21 | smoke passed |
| `ada-lovelace-wikipedia-auto.json` | 20 | smoke passed |
| `fair-guiding-principles-excerpt-auto.json` | 23 | smoke passed |

Each smoke opened the corpus, confirmed the public picker entries,
left-clicked the first visible concept to zoom in, right-clicked back out,
checked that wheel scrolling and drag panning do not change levels, and
checked for console errors.

For zoom, hit-testing, or layout changes, run a full anchor-path regression
over every visible concept in both directions. The expected full matrix is
38 paths for Voting Problem, 32 for Architecture of the Grin, 42 for Bitter
Lesson, 40 for Ada Lovelace, and 46 for the FAIR excerpt.

## Anti-Reward-Hacking Checklist

Before shipping a zoom or anchor change:

- The diff does not mention a specific concept id, label, or document as logic.
- The diff does not bias toward a specific token.
- The change is in a generic mechanism: hit testing, concept lookup, word
  projection, phrase-chain bridging, layout, or input handling.
- At least one zoom-out path was tested, not only zoom-in.
- Drag-pan and wheel-pan still leave `currentLevel` unchanged.
- The browser console has no errors during the run.
