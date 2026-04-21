#!/usr/bin/env node
/**
 * Multi-word cursor-precision regression. Tests that for a SET of words
 * spread across the L0 text, the cursor tracks each word across a zoom
 * sweep from L0 downward. Catches the "cheated drifts several lines off
 * by L3" class of failure that single-word testing missed.
 *
 * Output:
 *   - JSON summary at verify_artifacts/multi_word_regression_<ts>.json
 *   - Per-word screenshots at verify_artifacts/word_<word>_L<N>.png
 *
 * Usage:
 *   node verify_artifacts/multi_word_regression.mjs
 *   node verify_artifacts/multi_word_regression.mjs --words=not,cheated,Maya,Chip,Tyler,logs
 */

import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const artifactsDir = path.dirname(new URL(import.meta.url).pathname)
const B = path.resolve(process.env.HOME, '.claude/skills/gstack/browse/dist/browse')
const TARGET_URL = 'http://localhost:5181/?file=the-voting-problem-auto.json'

// Default test words — spread across the L0 text of the current corpus.
// Keep these present in L0 (the causal-chain reduction); words from older
// drafts (cheated, Chip, 84%) don't exist in the current L0 and will skip.
let WORDS = ['not', 'cheating', 'Maya', 'Tom', 'Tyler', 'logs', 'trust', 'daughter']
const args = process.argv.slice(2)
for (const a of args) {
  if (a.startsWith('--words=')) WORDS = a.slice('--words='.length).split(',').filter(Boolean)
}

function brun(cmdArgs, timeout = 25000) {
  const r = spawnSync(B, cmdArgs, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout })
  return (r.stdout || '') + (r.stderr ? '\n' + r.stderr : '')
}

function bjs(script) {
  const out = brun(['js', script], 25000)
  const lines = out.split('\n').filter(l =>
    !l.includes('[browse] Starting server') &&
    !l.includes('BEGIN UNTRUSTED') &&
    !l.includes('END UNTRUSTED') &&
    l.trim().length > 0)
  return lines.join('\n').trim()
}

function bgoto(url) { brun(['goto', url], 15000) }
function bscreenshot(f) { brun(['screenshot', f], 15000) }

// Simulate user hovering on a specific word at L0, then zooming through all levels.
// Returns per-level trace: word under cursor, concept under cursor.
const ZOOM_TRACE_SCRIPT = (word, maxLevel) => `
new Promise(function(resolve){
  var sz = window._sz;
  var canvas = document.getElementById('viewport');
  var W = window.innerWidth;
  var target = ${JSON.stringify(word)};
  // L0 may have multiple nodes (each paragraph). Search all nodes; take the first hit.
  var lcTarget = target.toLowerCase();
  var allL0Nodes = sz.measuredLevels[0];
  var hitNode = null, hitIdx = -1;
  for (var ni = 0; ni < allL0Nodes.length; ni++) {
    var nd = allL0Nodes[ni];
    var i = nd.text.toLowerCase().indexOf(lcTarget);
    if (i >= 0) { hitNode = nd; hitIdx = i; break; }
  }
  if (!hitNode) { resolve(JSON.stringify({error: 'word_not_in_L0', word: target})); return; }
  var node = hitNode;
  var idx = hitIdx;
  var m = [node.text.substring(idx, idx + target.length)];
  var charsAcc = 0, lineIdx = 0;
  for (var li = 0; li < node.lines.length; li++) {
    var lc = node.lines[li].text.length;
    if (charsAcc + lc > idx) { lineIdx = li; break; }
    charsAcc += lc;
  }
  var prefix = node.lines[lineIdx].text.substring(0, idx - charsAcc);
  var ctx = document.createElement('canvas').getContext('2d');
  ctx.font = '18px Georgia, serif';
  var offX = ctx.measureText(prefix).width + (m[0].length * 9 / 2); // middle of word approx
  var off0 = sz.levelOffsets[0] || sz.defaultOffset(0);
  var x = (W - 640) / 2 + off0.x + offX;
  var y = off0.y + node.y + lineIdx * 28 + 14;
  canvas.dispatchEvent(new MouseEvent('mousemove', {clientX: x, clientY: y, bubbles: true}));
  setTimeout(function(){
    var trail = [{level: 0, word: sz.hitTestWord(0, off0)?.word, concept: sz.findConceptAtCursor(0, off0)?.id}];
    var step = function(){
      return new Promise(function(r){
        canvas.dispatchEvent(new WheelEvent('wheel', {clientX: x, clientY: y, deltaY: 100, bubbles: true, cancelable: true}));
        setTimeout(function(){
          var off = sz.levelOffsets[sz.currentLevel] || sz.defaultOffset(sz.currentLevel);
          trail.push({level: sz.currentLevel, word: sz.hitTestWord(sz.currentLevel, off)?.word, concept: sz.findConceptAtCursor(sz.currentLevel, off)?.id});
          r();
        }, 250);
      });
    };
    var chain = Promise.resolve();
    for (var k = 0; k < ${maxLevel}; k++) chain = chain.then(step);
    chain.then(function(){
      resolve(JSON.stringify({
        word: target,
        cursorXY: { x: Math.round(x), y: Math.round(y) },
        trackedWord: sz.trackedWord,
        trackedConcept: sz.trackedConcept ? sz.trackedConcept.id : null,
        trail: trail
      }));
    });
  }, 100);
})
`

const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
const results = { timestamp: ts, words_tested: WORDS, results: [] }

// Figure out level count by reading the data file
const tree = JSON.parse(fs.readFileSync(path.resolve(projectRoot, 'data/the-voting-problem-auto.json'), 'utf8'))
const LMAX = tree.levelCount - 1

console.log(`Multi-word cursor regression — testing ${WORDS.length} words × L0→L${LMAX}\n`)

// Poll until the page module has booted (window._sz defined). The browse
// daemon queues commands but doesn't wait for JS modules to load; under
// cumulative latency a fixed sleep drops the trace script on a blank page.
const READY_POLL = `
new Promise(function(resolve){
  var start = Date.now();
  var tick = function(){
    if (window._sz && window._sz.treeData && window._sz.measuredLevels &&
        window._sz.measuredLevels[0] && window._sz.measuredLevels[0].length > 0) {
      resolve(JSON.stringify({ready: true, ms: Date.now()-start}));
    } else if (Date.now()-start > 8000) {
      resolve(JSON.stringify({ready: false, ms: Date.now()-start, has_sz: !!window._sz}));
    } else {
      setTimeout(tick, 50);
    }
  };
  tick();
})
`

for (const word of WORDS) {
  process.stdout.write(`  "${word}" ... `)
  bgoto(TARGET_URL)
  const readyRaw = bjs(READY_POLL)
  let ready
  try { ready = JSON.parse(readyRaw) } catch { ready = { ready: false, raw: readyRaw.substring(0, 120) } }
  if (!ready.ready) {
    console.log(`SKIP (not_ready after ${ready.ms ?? '?'}ms)`)
    results.results.push({ error: 'not_ready', word, detail: ready })
    continue
  }
  const out = bjs(ZOOM_TRACE_SCRIPT(word, LMAX))
  let parsed
  try { parsed = JSON.parse(out) }
  catch { parsed = { error: 'parse_fail', raw: out.substring(0, 200) } }
  // Capture a screenshot at the end level
  bscreenshot(path.join(artifactsDir, `word_${word.replace(/[^\w]/g, '_')}_end.png`))

  // Analyze trail
  if (parsed.error) {
    console.log(`SKIP (${parsed.error})`)
    results.results.push(parsed)
    continue
  }
  const trail = parsed.trail || []
  const firstConcept = trail[0]?.concept
  const wordSeq = trail.map(t => t.word || '-')
  const conceptKept = trail.filter(t => t.concept === firstConcept).length
  const conceptStability = `${conceptKept}/${trail.length}`
  const wordMatches = trail.filter(t => t.word && t.word.toLowerCase().replace(/[^\w]/g,'').startsWith(word.toLowerCase().slice(0,4))).length
  console.log(`concept ${conceptStability} stable, word-stem matches ${wordMatches}/${trail.length}, words: [${wordSeq.join(' → ')}]`)
  parsed.conceptStability = conceptStability
  parsed.wordStemMatches = `${wordMatches}/${trail.length}`
  results.results.push(parsed)
}

const outPath = path.join(artifactsDir, `multi_word_regression_${ts}.json`)
fs.writeFileSync(outPath, JSON.stringify(results, null, 2))
console.log(`\nWrote: ${path.relative(projectRoot, outPath)}`)
