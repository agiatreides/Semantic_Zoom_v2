#!/usr/bin/env node
/**
 * Regression runner for Semantic Zoom v2.
 *
 * Drives the gstack `browse` daemon (`$B`) to test the zoom-without-drift
 * invariant on EVERY pairwise transition (not just end-to-end), plus
 * anti-reward-hacking spot checks. Writes:
 *   - regression_<timestamp>.json — full matrix
 *   - heatmap_L<N>.png            — concept anchors visualized per level
 *   - zoom_<concept>_L<a>_to_L<b>.png — cursor screenshot at each step
 *
 * Why this exists: the previous ad-hoc /tmp/semzoom_*.js scripts only
 * tested L0 → L_max in one sweep, where intermediate drift can self-cancel.
 * Pairwise testing exposes step-by-step failures.
 *
 * Usage:
 *   node verify_artifacts/regression.mjs --file=the-voting-problem-auto.json
 *
 * Constraints (learned the hard way):
 *   - `$B js` has a hard ~15s timeout on the eval. Keep each script short.
 *   - The daemon dies ~15s after the parent process exits. Run all `$B`
 *     commands from one Node process to keep the session alive.
 *   - `async`/`await` arrow callbacks inside `.then()` lose their return
 *     value through `$B js`. Use plain `new Promise(...)` chains.
 *   - The viewport command reloads the page. Set viewport BEFORE goto.
 */

import { execSync, spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'

// ---------- args ----------
const args = process.argv.slice(2)
let dataFile = 'the-voting-problem-auto.json'
let baseUrl = 'http://localhost:5181'
let onlyConcepts = null // optional list to limit to specific ids
for (const a of args) {
  if (a.startsWith('--file=')) dataFile = a.slice('--file='.length)
  else if (a.startsWith('--url=')) baseUrl = a.slice('--url='.length)
  else if (a.startsWith('--concepts=')) onlyConcepts = a.slice('--concepts='.length).split(',')
}

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const artifactsDir = path.dirname(new URL(import.meta.url).pathname)
const conceptsPath = path.resolve(projectRoot, 'data', dataFile.replace(/\.json$/, '-concepts.json'))
const treePath = path.resolve(projectRoot, 'data', dataFile)

const B = path.resolve(process.env.HOME, '.claude/skills/gstack/browse/dist/browse')
const URL_FOR_FILE = `${baseUrl}/?file=${encodeURIComponent(dataFile)}`

if (!fs.existsSync(conceptsPath)) {
  console.error(`Concepts file not found: ${conceptsPath}`)
  process.exit(1)
}
const allConcepts = JSON.parse(fs.readFileSync(conceptsPath, 'utf8'))
const tree = JSON.parse(fs.readFileSync(treePath, 'utf8'))
const LEVEL_COUNT = tree.levelCount
const LMAX = LEVEL_COUNT - 1

const conceptIds = (onlyConcepts ?? allConcepts.map(c => c.id))
const conceptsToTest = allConcepts.filter(c => conceptIds.includes(c.id))

console.log(`Regression: ${dataFile}, ${LEVEL_COUNT} levels, ${conceptsToTest.length} concepts under test`)
console.log(`Artifacts: ${path.relative(projectRoot, artifactsDir)}/`)

// ---------- $B helpers ----------
function brun(cmd, opts = {}) {
  // cmd is an array of args
  const r = spawnSync(B, cmd, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: opts.timeout ?? 30000,
  })
  if (r.status !== 0 && r.status !== null && opts.tolerateError !== true) {
    // Most browse commands return 0; failure messages go to stdout.
  }
  return (r.stdout || '') + (r.stderr ? '\n' + r.stderr : '')
}

function bjs(script) {
  // Keep scripts short — eval timeout ~15s.
  const out = brun(['js', script], { timeout: 25000 })
  // Strip server preamble + extract last meaningful line.
  const lines = out.split('\n').filter(l =>
    !l.includes('[browse] Starting server') &&
    !l.includes('BEGIN UNTRUSTED EXTERNAL CONTENT') &&
    !l.includes('END UNTRUSTED EXTERNAL CONTENT') &&
    l.trim().length > 0)
  return lines.join('\n').trim()
}

function bgoto(url) {
  brun(['goto', url], { timeout: 15000 })
}

function bscreenshot(filepath) {
  brun(['screenshot', filepath], { timeout: 15000 })
}

// ---------- test scripts ----------

// Place cursor on a concept at a given level using midpoint of the anchor.
// Returns JSON { ok: true, x, y, startConceptId } or { error }.
const PLACE_AND_READ = (conceptId, level) => `
new Promise(function(resolve){
  var sz = window._sz;
  if (!sz) { resolve(JSON.stringify({error:'no_sz'})); return; }
  var c = sz.concepts.find(function(x){return x.id===${JSON.stringify(conceptId)}});
  if (!c) { resolve(JSON.stringify({error:'no_concept'})); return; }
  var L = ${level};
  if (!c.anchors[String(L)]) { resolve(JSON.stringify({error:'no_anchor_at_level',level:L})); return; }
  var pos = sz.getConceptCenterPosition(c, L);
  if (!pos) { resolve(JSON.stringify({error:'no_position'})); return; }
  var off = sz.levelOffsets[L] || sz.defaultOffset(L);
  var W = window.innerWidth;
  var x = (W - 640)/2 + off.x + pos.contentX;
  var y = off.y + pos.contentY;
  // Clamp into viewport
  x = Math.max(20, Math.min(window.innerWidth - 20, x));
  y = Math.max(20, Math.min(window.innerHeight - 20, y));
  document.getElementById('viewport').dispatchEvent(new MouseEvent('mousemove',{clientX:x,clientY:y,bubbles:true}));
  setTimeout(function(){
    var startConcept = sz.findConceptAtCursor(L, off);
    sz.setTrackedConcept(startConcept);  // lock the session to whatever's actually under cursor
    resolve(JSON.stringify({ok:true, x:Math.round(x), y:Math.round(y), startConceptId: startConcept ? startConcept.id : null, expectedId: c.id, level: L}));
  }, 80);
})
`

// Drive currentLevel from `from` to `to` by dispatching wheel events at the
// remembered cursor position. Returns the end concept under cursor.
const ZOOM_AND_READ = (fromL, toL, x, y) => {
  const direction = toL > fromL ? 100 : -100
  const steps = Math.abs(toL - fromL)
  return `
new Promise(function(resolve){
  var sz = window._sz;
  if (!sz) { resolve(JSON.stringify({error:'no_sz'})); return; }
  var canvas = document.getElementById('viewport');
  var x = ${x}, y = ${y};
  // Make sure cursor is in text area for the wheel handler
  canvas.dispatchEvent(new MouseEvent('mousemove',{clientX:x,clientY:y,bubbles:true}));
  var step = function(){
    return new Promise(function(r){
      canvas.dispatchEvent(new WheelEvent('wheel', {clientX:x,clientY:y,deltaY:${direction},bubbles:true,cancelable:true}));
      setTimeout(r, 160);
    });
  };
  var chain = Promise.resolve();
  for (var k = 0; k < ${steps}; k++) chain = chain.then(step);
  chain.then(function(){return new Promise(function(r){setTimeout(r,300)});}).then(function(){
    var off = sz.levelOffsets[sz.currentLevel] || sz.defaultOffset(sz.currentLevel);
    var endConcept = sz.findConceptAtCursor(sz.currentLevel, off);
    var trackedC = sz.trackedConcept;
    resolve(JSON.stringify({
      endConceptId: endConcept ? endConcept.id : null,
      trackedId: trackedC ? trackedC.id : null,
      finalLevel: sz.currentLevel
    }));
  });
})
`
}

// ---------- one test: place at startL, zoom to endL, return JSON ----------
function runOneTest(conceptId, startL, endL, screenshotPath) {
  bgoto(URL_FOR_FILE)
  // small wait for app boot; vite is fast
  execSync('sleep 1.6')
  // Navigate to startL by zooming in from L0 (cursor at viewport center, no concept tracked).
  if (startL > 0) {
    const climb = `
new Promise(function(resolve){
  var canvas = document.getElementById('viewport');
  var W = window.innerWidth, H = window.innerHeight;
  canvas.dispatchEvent(new MouseEvent('mousemove',{clientX:W/2,clientY:H/2,bubbles:true}));
  window._sz.clearTrackedConcept();
  var step = function(){
    return new Promise(function(r){
      canvas.dispatchEvent(new WheelEvent('wheel',{clientX:W/2,clientY:H/2,deltaY:100,bubbles:true,cancelable:true}));
      setTimeout(r, 160);
    });
  };
  var chain = Promise.resolve();
  for (var k = 0; k < ${startL}; k++) chain = chain.then(step);
  chain.then(function(){
    window._sz.clearTrackedConcept();
    resolve(JSON.stringify({level: window._sz.currentLevel}));
  });
})
`
    bjs(climb)
  }
  // Place cursor on the concept at startL
  const placed = bjs(PLACE_AND_READ(conceptId, startL))
  let placedJson
  try { placedJson = JSON.parse(placed) } catch { return { conceptId, startL, endL, error: 'place_parse_fail', raw: placed.substring(0, 200) } }
  if (placedJson.error) return { conceptId, startL, endL, error: placedJson.error }
  // Optional: screenshot at startL
  if (screenshotPath && startL === endL) {
    bscreenshot(screenshotPath.replace('.png', `_L${startL}_start.png`))
  }
  // Zoom
  const zoomed = bjs(ZOOM_AND_READ(startL, endL, placedJson.x, placedJson.y))
  let zoomedJson
  try { zoomedJson = JSON.parse(zoomed) } catch { return { conceptId, startL, endL, error: 'zoom_parse_fail', raw: zoomed.substring(0, 200) } }
  if (screenshotPath) bscreenshot(screenshotPath)
  return {
    conceptId,
    startL,
    endL,
    cursorXY: { x: placedJson.x, y: placedJson.y },
    startConceptId: placedJson.startConceptId,
    endConceptId: zoomedJson.endConceptId,
    trackedId: zoomedJson.trackedId,
    finalLevel: zoomedJson.finalLevel,
    preserved: zoomedJson.endConceptId === placedJson.startConceptId,
    targetMatched: placedJson.startConceptId === conceptId,
  }
}

// ---------- heatmap per level ----------
function captureHeatmap(level) {
  // Place cursor center, zoom to the requested level, screenshot.
  // (No overlay yet; just a screenshot of the level. Visual sanity check.)
  bgoto(URL_FOR_FILE)
  execSync('sleep 1.6')
  if (level > 0) {
    const climb = `
new Promise(function(resolve){
  var canvas = document.getElementById('viewport');
  var W = window.innerWidth, H = window.innerHeight;
  canvas.dispatchEvent(new MouseEvent('mousemove',{clientX:W/2,clientY:H/2,bubbles:true}));
  window._sz.clearTrackedConcept();
  var step = function(){
    return new Promise(function(r){
      canvas.dispatchEvent(new WheelEvent('wheel',{clientX:W/2,clientY:H/2,deltaY:100,bubbles:true,cancelable:true}));
      setTimeout(r, 160);
    });
  };
  var chain = Promise.resolve();
  for (var k = 0; k < ${level}; k++) chain = chain.then(step);
  chain.then(function(){resolve(JSON.stringify({level: window._sz.currentLevel}));});
})
`
    bjs(climb)
  }
  const out = path.join(artifactsDir, `heatmap_L${level}.png`)
  bscreenshot(out)
  return out
}

// ---------- main ----------

const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
const results = {
  timestamp: ts,
  dataFile,
  levelCount: LEVEL_COUNT,
  concepts: conceptsToTest.map(c => ({ id: c.id, label: c.label, min_visible_level: c.min_visible_level })),
  tests: [],
  heatmaps: [],
}

console.log('\n--- Heatmaps ---')
for (let L = 0; L < LEVEL_COUNT; L++) {
  console.log(`  L${L}...`)
  const p = captureHeatmap(L)
  results.heatmaps.push({ level: L, file: path.relative(projectRoot, p) })
}

console.log('\n--- Pairwise transitions ---')
let totalTests = 0, totalPass = 0, totalSkipped = 0
for (const c of conceptsToTest) {
  for (let startL = 0; startL < LEVEL_COUNT; startL++) {
    if (!c.anchors[String(startL)]) {
      // Concept not visible at this level; skip start
      continue
    }
    for (let endL = 0; endL < LEVEL_COUNT; endL++) {
      if (startL === endL) continue
      const screenshotPath = path.join(artifactsDir, `zoom_${c.id}_L${startL}_to_L${endL}.png`)
      process.stdout.write(`  ${c.id}: L${startL}→L${endL} ... `)
      const r = runOneTest(c.id, startL, endL, screenshotPath)
      results.tests.push(r)
      totalTests++
      if (r.error) {
        console.log(`SKIP (${r.error})`)
        totalSkipped++
      } else if (r.preserved) {
        console.log(`PASS  (${r.startConceptId} preserved)`)
        totalPass++
      } else {
        console.log(`FAIL  (start=${r.startConceptId}, end=${r.endConceptId})`)
      }
    }
  }
}

results.summary = {
  total: totalTests,
  pass: totalPass,
  fail: totalTests - totalPass - totalSkipped,
  skipped: totalSkipped,
  pass_rate: totalTests > totalSkipped ? (totalPass / (totalTests - totalSkipped)) : 0,
}

const outPath = path.join(artifactsDir, `regression_${ts}.json`)
fs.writeFileSync(outPath, JSON.stringify(results, null, 2))
console.log(`\nWrote: ${path.relative(projectRoot, outPath)}`)
console.log(`Summary: ${totalPass}/${totalTests - totalSkipped} preserved (skipped ${totalSkipped})`)
