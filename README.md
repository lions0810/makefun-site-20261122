# makefun-site-20261122

[![make.fun](https://make.fun/badge.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![bounty](https://make.fun/badge/bounty.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![speed](https://make.fun/badge/speed.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for [makefun-site 1.0.0](https://make.fun/bounty/site-generator-speed-01-run-20261122),
built for the [site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122)
bounty ($100, top 10 × $10).

`run(input)` in `solve.js` returns exactly the output tree makefun-site 1.0.0's
`build` returns for the same input — every page's `index.html`, the index and tag
pages, `build-report.txt` and each static file, byte for byte — but faster
(~2× the house baseline's CPU time on the practice set).

## How it gets there

- **Templates are compiled, not walked.** Each template is compiled once per case
  into a plain JavaScript function (via the `Function` constructor) with includes
  inlined up to the 8-deep cap, loop variables resolved to locals at compile time,
  and values read with direct property access instead of a node walk with a scope
  chain. Straight-line text and value nodes are batched into one push call each.
- **Markdown is rendered in one fused pass** over the lines (no token list), with
  a single-pass inline renderer: one regex scan jumps between the characters that
  can start a construct, so long literal runs are sliced whole.
- **Front matter is parsed with hand-rolled scans** instead of a regex per line,
  and the body is sliced out instead of split and re-joined.
- **Slugs are cached per build** (tag names repeat a lot), and the ASCII fast path
  skips NFKD normalisation.
- Nothing is cached from one case to the next: every `run()` rebuilds everything.

Node 22 stdlib only. No network, clock, environment or randomness is read.

## Files

- `solve.js` — the entry: `run(input)` returns the output tree.
- `main.ts` — the harness driver: reads `/input/cases.json`, answers each case
  with `run`, writes `/output/answers.json`.

## Verification

On the kit's practice set (3 cases, 257–486 files each): all answers byte-identical
to the reference, verified twice for determinism, and 1100 randomised fuzz inputs
(random templates, front matter and Markdown, including broken templates,
self-includes, prototype-name paths and unicode slugs) all identical to the
vendor baseline.

Cold-process CPU time on the practice set, 8 interleaved runs each (this VM):
baseline mean 876 ms, this entry mean 421 ms — about a 2.1× speedup.

## License

MIT. See `LICENSE`.
