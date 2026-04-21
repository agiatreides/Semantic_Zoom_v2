# Model Benchmark Report

Base tree: `data/the-voting-problem-auto.json`
Base concepts: `data/the-voting-problem-auto-concepts.json`
Generated: 2026-04-21T14:40:23.573Z

## Summary

| Model | Wall time | Claude-call time | Collapse? |
|-------|-----------|------------------|-----------|
| sonnet | 5.8 min | 19.5 min | no |
| haiku | 4.7 min | 16.3 min | no |

## Word counts vs target (±10% band is acceptable)

| Level | Target | sonnet | haiku |
|-------|--------|---|---|
| L0 | 116 | 125 (+8%) ✓ | 108 (-7%) ✓ |
| L1 | 348 | 369 (+6%) ✓ | 354 (+2%) ✓ |
| L2 | 765 | 791 (+3%) ✓ | 755 (-1%) ✓ |
| L3 | 1159 | 1242 (+7%) ✓ | 1029 (-11%) ✗ |
| L4 | 1739 | 1866 (+7%) ✓ | 1873 (+8%) ✓ |
| L5 | 2318 | 2318 (0%) ✓ | 2318 (0%) ✓ |

## Level spacing (ratio to next level up; >90% = collapse)

| Pair | sonnet | haiku |
|------|---|---|
| L0/L1 | 34% | 31% |
| L1/L2 | 47% | 47% |
| L2/L3 | 64% | 73% |
| L3/L4 | 67% | 55% |
| L4/L5 | 81% | 81% |

## Anchor coverage (placed/visible per level)

| Level | sonnet | haiku |
|-------|---|---|
| L0 | 3/3 | 3/3 |
| L1 | 12/12 | 12/12 |
| L2 | 19/19 | 19/19 |
| L3 | 19/19 | 19/19 |
| L4 | 19/19 | 19/19 |
| L5 | 19/19 | 19/19 |

## Per-call timings (seconds)

### sonnet
- gen:L0:a1: 47.5s
- anchor:L0: 4.6s
- gen:L4:a1: 113.9s
- gen:L1:a1: 117.2s
- gen:L2:a1: 143.6s
- gen:L3:a1: 149.6s
- anchor:L1: 79.2s
- gen:L4:a2: 113.6s
- anchor:L4: 57.1s
- anchor:L3: 144.1s
- anchor:L2: 202.5s
### haiku
- gen:L0:a1: 52.9s
- gen:L1:a1: 53.6s
- gen:L3:a1: 60.8s
- gen:L2:a1: 71.5s
- gen:L4:a1: 72.0s
- gen:L3:a2: 53.8s
- anchor:L2: 60.9s
- anchor:L0: 82.5s
- anchor:L4: 89.9s
- anchor:L1: 216.6s
- anchor:L3: 161.6s

## Files to read

### sonnet
- Tree JSON: `bench/sonnet/tree.json`
- Concepts JSON: `bench/sonnet/concepts.json`
- Rebuild log: `bench/sonnet/rebuild.log`
- Level texts: `bench/sonnet/levels/L{0..5}.txt`
### haiku
- Tree JSON: `bench/haiku/tree.json`
- Concepts JSON: `bench/haiku/concepts.json`
- Rebuild log: `bench/haiku/rebuild.log`
- Level texts: `bench/haiku/levels/L{0..5}.txt`
