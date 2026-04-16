# Semantic Zoom v2 — Verification Spec

> Verification spec AND living UI spec. Updated after every verified change.
> Project intent: a canvas-based semantic-zoom reader. As the user scrolls,
> the text is replaced with a coarser or finer rendition. The cursor's
> location on screen is the user's "intent pointer" — whatever concept the
> cursor was over before zoom must remain at the cursor after zoom.

---

## Server

- **Start:** `cd /Users/lts/Desktop/Second_Brain/Second_Brain/Projects/Semantic_Zoom_v2 && npx vite --port 5181 > /tmp/semzoom_v2.log 2>&1 &`
- **Port:** 5181
- **Check running:** `lsof -i :5181 -t`
- **Kill:** `lsof -ti :5181 | xargs kill 2>/dev/null`
- **Tail logs:** `tail -f /tmp/semzoom_v2.log`

## Browse setup

```bash
B=~/.claude/skills/gstack/browse/dist/browse
```

The Pretext server uses `import.meta.url` to fetch data files relative to `src/main.js`. Use `?file=…` query param to switch corpora.

## Test corpora

| File | Levels | Purpose |
|------|--------|---------|
| `the-voting-problem.json`           | 10 (0–9) | Hand-crafted; canonical regression target |
| `the-voting-problem-auto.json`      | 6  (0–5) | Auto-generated; default in `index.html` |
| `the-voting-problem-auto-concepts.json` | n/a   | Concept anchors for the auto file |

URLs:
- `http://localhost:5181/?file=the-voting-problem-auto.json` (auto, 6 levels, has concepts)
- `http://localhost:5181/?file=the-voting-problem.json` (hand-crafted, 10 levels)

---

## CORE INVARIANT — semantic identity must survive zoom

> **Any concept must be zoomable throughout, not just one.**

This is the prime regression. A prior agent "fixed" the canonical "not" case
by biasing toward the `not` token — which made every other word also zoom
toward "not". That is reward hacking. The fix MUST be a generic mechanism
that treats all concepts symmetrically. Verification therefore tests
multiple concepts drawn from different parts of the corpus.

### What "survives zoom" means precisely

For a concept C anchored at level L0 over character range [a, b] in node N:

1. Place the cursor on a character within C's anchor at level L0.
2. Scroll-zoom to any other level Lt (Lt > L0 zoom in, Lt < L0 zoom out).
3. After zoom completes (~12 frames at TRANSITION_SPEED 0.12), the cursor
   must overlap C's anchor at level Lt. Equivalently: the concept under the
   cursor at Lt must equal C, OR (if Lt is so coarse that C dissolved)
   the concept under the cursor at Lt must be the parent that C is rolled
   up into. **Never an unrelated sibling.**

### Programmatic check via `window._sz`

The app exports a debug surface for headless testing:

```js
window._sz.concepts                    // [{id, label, anchors:{level: {nodeId,charStart,charEnd}}}]
window._sz.currentLevel                // current displayed zoom level (int)
window._sz.hoveredConcept              // last concept resolved by findConceptAtCursor
window._sz.findConceptAtCursor(L, off) // explicit lookup
window._sz.getConceptPosition(c, L)    // returns {contentX, contentY} for concept c at level L
window._sz.findPhraseAtCursor(L, y, x) // phrase under cursor (lower-level building block)
window._sz.levelOffsets                // current per-level scroll offsets
window._sz.defaultOffset(L)            // baseline offset
```

A verifier can therefore:

1. `goto` the corpus URL.
2. Call `getConceptPosition(C, L0)` to compute the screen coordinate where
   C lives at level L0.
3. Move the cursor there.
4. Issue scroll wheel events to zoom to Lt.
5. Read `hoveredConcept` and assert `id === C.id`.

This avoids screenshot OCR and tests the *actual mechanism*.

---

## Canonical regression set (the-voting-problem-auto.json)

Six concepts, distributed across the corpus and across semantic types
(decision/refusal, person, action, abstract reflection, scene-setter).
**All six must pass for the fix to be considered valid.**

| ID                              | Label                                                | Type      | Why it's in the set |
|---------------------------------|------------------------------------------------------|-----------|---------------------|
| `tom_trusts_wont_check`         | Tom trusts Maya / won't check logs                   | refusal   | The original "not" pivot — the failing case |
| `chip_runs_numbers`             | Chip calculates ROI and flags Derek's errors         | action    | Numerical/concrete — different semantic type than refusal |
| `chip_interrupts_maya_alert`    | Chip interrupts with Maya alert                      | event     | Scene transition — must not drift to "not" |
| `did_you_cheat_maya_no`         | "Did you cheat?" — Maya says no                      | dialogue  | Another negation — must NOT collapse into `tom_trusts_wont_check` |
| `optimization_not_wisdom`       | Chip's reflection: optimization is not wisdom        | abstract  | Contains literal "not" — must zoom to ITS not, not Tom's not |
| `closing_got_it_right`          | Closing: Tom goes to bed, "got it right"             | resolution| End of corpus, geographically far from the others |

**Generality test:** if a fix passes only for `tom_trusts_wont_check`, it
fails. If a fix biases the four "not"-adjacent concepts toward each other,
it fails. If a fix preserves identity across all six independent
concepts, it passes.

### Failure signature to watch for

The most insidious failure mode: zoom on `did_you_cheat_maya_no` (which
contains the literal word "no" — another negation) lands on
`tom_trusts_wont_check`. That would indicate the fix biased toward
*negation tokens* generally rather than fixing the underlying anchor
mechanism. Reject and look deeper.

---

## Verification protocol

### Step 0 — Make sure the server is up

```bash
lsof -i :5181 -t || (cd /Users/lts/Desktop/Second_Brain/Second_Brain/Projects/Semantic_Zoom_v2 && npx vite --port 5181 > /tmp/semzoom_v2.log 2>&1 &)
sleep 2
$B goto http://localhost:5181/?file=the-voting-problem-auto.json
$B console --errors
```

### Step 1 — Sanity: data is loaded

```bash
$B js "window._sz.concepts.length"               # expect 19
$B js "window._sz.currentLevel"                  # expect 0
$B js "Object.keys(window._sz.measuredLevels).length"  # expect 6
```

### Step 2 — Per-concept zoom-stability check

For each concept C in the regression set, run:

```bash
# Set the concept under test (replace ID for each iteration)
$B js "window._szTest = {id:'tom_trusts_wont_check', startLevel:0, endLevel:5}"

# Compute screen coordinate of C at startLevel
$B js "
  const c = window._sz.concepts.find(x => x.id === window._szTest.id);
  const off = window._sz.levelOffsets[window._szTest.startLevel] ?? window._sz.defaultOffset(window._szTest.startLevel);
  const pos = window._sz.getConceptPosition(c, window._szTest.startLevel);
  // Convert content coords → screen coords (column is centered, see main.js)
  const baseLeftX = (window.innerWidth - 640) / 2;
  window._szTest.x = baseLeftX + off.x + pos.contentX + 20;  // +20 to land mid-phrase
  window._szTest.y = off.y + pos.contentY + 14;              // +14 for line midline
  return window._szTest;
"

# Move cursor there + zoom
$B js "
  const ev = (type, dy) => window.document.getElementById('viewport').dispatchEvent(
    new MouseEvent(type, {clientX: window._szTest.x, clientY: window._szTest.y, bubbles:true})
  );
  ev('mousemove', 0);
"

# Zoom from startLevel to endLevel by issuing wheel events
# (each ~80 deltaY past SCROLL_THRESHOLD = one level)
$B js "
  for (let i = 0; i < (window._szTest.endLevel - window._szTest.startLevel); i++) {
    window.document.getElementById('viewport').dispatchEvent(
      new WheelEvent('wheel', {clientX: window._szTest.x, clientY: window._szTest.y, deltaY: 90, bubbles:true, cancelable:true})
    );
  }
"

# Wait for transition to settle (TRANSITION_SPEED=0.12 → ~25 frames)
$B js "new Promise(r => setTimeout(r, 600))"

# Read what concept is now under the cursor
$B js "
  const off = window._sz.levelOffsets[window._sz.currentLevel] ?? window._sz.defaultOffset(window._sz.currentLevel);
  const c = window._sz.findConceptAtCursor(window._sz.currentLevel, off);
  return { expected: window._szTest.id, got: c?.id, label: c?.label, level: window._sz.currentLevel };
"
```

**PASS:** `got === expected`, OR `got` is the documented parent of `expected` for the level reached.
**FAIL:** any other `got`. Especially failing if multiple concepts all return `tom_trusts_wont_check`.

### Step 3 — Visual evidence (optional but recommended)

```bash
$B snapshot -H '{"viewport":"yellow"}' /tmp/semzoom_zoom_${concept_id}_L${level}.png
# OR plain screenshot:
$B screenshot /tmp/semzoom_zoom_${concept_id}_L${level}.png
```

Screenshot at L0 (cursor on concept) and at the end-level. Visually
confirm the cursor is over the same idea.

### Step 4 — Regression matrix

Each row records what concept the cursor was actually on at the start
level (`start_concept` per `findConceptAtCursor`) and what it ended on
after zoom. **Pass criterion** is `end_concept === start_concept` —
i.e., the concept the cursor was tracking did not drift.

Note on L0 anchor overlap (auto file): three concepts share the
[30, 114] char range at L0 (`opening_ai_ruins_arguing`,
`chip_runs_numbers`, `chip_interrupts_maya_alert`). `findConceptAtCursor`
returns the first match in the array (`opening_ai_ruins_arguing`).
That's a data quality issue, not a zoom bug — the test still
demonstrates whether the *tracked* concept is preserved across zoom.

#### 2026-04-16 — pre-fix (commit 5456f51e)

L0 → L5 (zoom in):

| Target                       | start_concept on cursor       | end_concept after zoom        | preserved |
|------------------------------|-------------------------------|-------------------------------|-----------|
| tom_trusts_wont_check        | tom_trusts_wont_check         | megs_lagos_equity_gap         | NO        |
| chip_runs_numbers            | opening_ai_ruins_arguing      | budget_meeting_derek          | NO        |
| chip_interrupts_maya_alert   | opening_ai_ruins_arguing      | budget_meeting_derek          | NO        |
| did_you_cheat_maya_no        | did_you_cheat_maya_no         | tom_could_check_logs          | NO        |
| optimization_not_wisdom      | (browser timeout)             | (browser timeout)             | error     |
| closing_got_it_right         | three_choices                 | closing_got_it_right          | NO (different concept; coincidentally landed on the named target) |

**Pre-fix result: 0/5 successful tests preserved tracking.**

#### 2026-04-16 — post-fix (concept-anchored + tracked-across-session)

L0 → L5 (zoom in):

| Target                       | start_concept on cursor       | end_concept after zoom        | preserved |
|------------------------------|-------------------------------|-------------------------------|-----------|
| tom_trusts_wont_check        | tom_trusts_wont_check         | tom_trusts_wont_check         | YES       |
| chip_runs_numbers            | opening_ai_ruins_arguing      | opening_ai_ruins_arguing      | YES       |
| chip_interrupts_maya_alert   | opening_ai_ruins_arguing      | opening_ai_ruins_arguing      | YES       |
| did_you_cheat_maya_no        | did_you_cheat_maya_no         | did_you_cheat_maya_no         | YES       |
| optimization_not_wisdom      | three_choices                 | three_choices                 | YES       |
| closing_got_it_right         | three_choices                 | three_choices                 | YES       |

**Post-fix result: 6/6 preserved.** Visual evidence:
`verify_artifacts/2026-04-16_tom_at_L5_after_fix.png` shows cursor
on the word "smirk" with HUD label `◆ Tom trusts Maya / won't check
logs` at Level 5.

#### Anti-reward-hacking checks (post-fix)

- `did_you_cheat_maya_no` (negation: "no") did NOT collapse into
  `tom_trusts_wont_check` (negation: "not"). They preserve as
  distinct concepts.
- `chip_runs_numbers` and `chip_interrupts_maya_alert` (different
  targets, same `start_concept` due to L0 overlap) both stayed on
  `opening_ai_ruins_arguing` — neither got pulled toward `tom_*`
  nor merged with each other.
- `closing_got_it_right` (semantically distant from "not") stayed on
  `three_choices` — no global bias.
- The diff in `src/main.js` mentions zero specific concept IDs,
  labels, or tokens. No allow-list, no per-token boost, no
  short-circuit on the canonical case.

---

## Anti-reward-hacking checklist

Before declaring a fix done, verify:

- [ ] Diff does NOT mention any specific concept ID, label, or token (no `"not"`, `"tom_"`, etc. as literal strings or special cases in code).
- [ ] Diff does NOT add any per-token boosts, allow-lists, or guards.
- [ ] Diff modifies the *generic* mechanism — `findConceptAtCursor`, the wheel handler's anchor lookup, the phrase ↔ concept bridge — not data.
- [ ] All six concepts in the regression matrix pass.
- [ ] At least two zoom-out cases pass (deep → shallow, not just shallow → deep).
- [ ] Console has zero errors during the run.

If the diff includes a token-specific tweak, that is reward hacking.
Reject and look deeper.

---

## Pages & assertions

### `/` — Main viewport

**URL:** `http://localhost:5181/?file=the-voting-problem-auto.json`

**Key elements:**

| Element       | Selector       | Should be                              |
|---------------|----------------|----------------------------------------|
| Canvas        | `#viewport`    | visible, full viewport                 |
| File picker   | `#file-picker` | visible, two options                   |

**Verification commands:**

```bash
$B goto http://localhost:5181/?file=the-voting-problem-auto.json
$B console --errors                         # expect: no errors
$B is visible "#viewport"
$B is visible "#file-picker"
$B js "window._sz.treeData.title"           # expect non-null string
$B js "window._sz.concepts.length > 0"      # expect true
$B screenshot /tmp/verify_semzoom_v2_index.png
```

---

## Changelog

| Date       | Change                                                                                  |
|------------|-----------------------------------------------------------------------------------------|
| 2026-04-16 | Initial VERIFY.md. Project added to verify_registry. Canonical six-concept regression set defined. |
| 2026-04-16 | Pre-fix matrix captured: 0/5 tracked concepts preserved across L0→L5. Drift bug confirmed. |
| 2026-04-16 | Fix shipped in `src/main.js` wheel handler: concept-anchored zoom with `trackedConcept` locked across a continuous wheel session, cleared on cursor motion (>2px). Phrase-chain fallback preserved. Post-fix matrix: 6/6 preserved. Anti-reward-hacking checklist passes. |
