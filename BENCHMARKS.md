# OCR backend benchmark

Corpus: the 35 expressions in `tests/test_golden.py`, rendered with LaTeX and
`dvipng` (`scripts/render_corpus.py`), scored by `scripts/benchmark.py`.

Scoring is on the final infix string, not on LaTeX edit distance. A model that
returns cosmetically different LaTeX which converts to the same expression has
not made a mistake.

Machine: MacBook, Apple Silicon (arm64), torch 2.13, pix2tex 0.1.4.

## Backends

| backend | exact | p50 | p95 | on disk |
|---|---|---|---|---|
| **unimernet small** | **35/35** | 799ms | 1048ms | ~750MB |
| unimernet base | 35/35 | 1161ms | 1612ms | ~1.2GB |
| symbolab (network reference) | 34/35 | 401ms | 537ms | — |
| pix2tex / cpu | 27/35 | 160ms | 243ms | 97MB |
| pix2tex / mps | 26/35 | 397ms | 851ms | 97MB |

UniMERNet clears the corpus outright, and small matches base while being ~30%
faster, so small is the pick. It costs roughly 5x pix2tex's latency and 8x its
footprint; against that, pix2tex needs hand-fixing on a quarter of snips.

UniMERNet cannot share a process with the converter: it pulls omegaconf, which
pins antlr4-runtime to 4.9.3, while sympy's LaTeX parser needs 4.11. Run it in
its own environment and hand LaTeX across — `scripts/dump-ocr.py` does this for
benchmarking, and the service needs the same split to deploy it.

## Device

**CPU wins, and it isn't close.** MPS is ~2.4x slower. The decoder is
autoregressive over 50-150 tokens and per-kernel launch overhead dominates a
model this small; the ViT encoder's gain does not pay for it. CoreML was not
pursued: its best case is roughly GPU-shaped, and the GPU loses here.

## Resolution

pix2tex / cpu, exact matches:

| 110dpi | 220dpi | 330dpi |
|---|---|---|
| 24/35 | 27/35 | 20/35 |

**More resolution is worse.** pix2tex downsamples anything large back toward
its training scale, so a high-DPI crop arrives blurred. Target roughly 220dpi
equivalent — which is what `captureVisibleTab` already gives on a Retina
display. Upscale a 1x capture to 2x, and no further.

## Decoding

pix2tex samples at temperature 0.25 by default. Near-greedy decoding
(`temperature = 1e-8`) took exact matches from 22/35 to 26/35 and made both the
score and the failures reproducible. There is one correct answer; do not sample.

## WebAssign

Every integral from all ten assignments of one semester's calculus course,
cloned into grids and rendered at 2x so the pixels match a Retina capture.
UniMERNet small throughout.

| set | solvable | read correctly | correctly refused |
|---|---|---|---|
| 5.7 Integrals Involving Ln(u) | 35 | 35 | 1 |
| the other nine assignments | 72 | 72 | 7 |

**107/107 on everything that is actually an integral.** The eight refusals are
all right to refuse: four are abstract templates (`V = π∫₀ᵃ [f(x)]² dx`, where
`f` is an unknown function), two are an integral followed by instruction text
(`… dx; u = ln(x), dv = x² dx`), one has an integral on both sides of an
equation, and one is a reduction-formula fragment my grid clipped.

Getting there took nine converter fixes, every one found by real data rather
than by the synthetic corpus:

- implicit products — `x(x-8)` parses as a *function call*
- an exponent inside one binds to the group, not the product: `x(\ln x)^9`
- `\Big`/`\Bigl` sizing commands reaching the printer as a function
- `)(` adjacency
- bare trig arguments — `\sec 3t(…)` hands the function the whole product
- equations wrapped around the operator — `F(x) = ∫…`
- square brackets as grouping — `[f(x)]^2`, which sympy rejects outright
- a constant in front of the operator — `2π∫₀³ x⁴ dx`, folded inside since
  both operators are linear
- `~`, LaTeX's non-breaking space

All are regressions in the test suite now.

## Accuracy gap

pix2tex lands at 27/35 against Symbolab's 34/35 and UniMERNet's 35/35. Roughly
one snip in four needs hand-fixing, so the editable-LaTeX fallback is the main
path for a quarter of uses, not an error case.

Most remaining misses are a single misread variable (`x` read as `A`, `S`, `k`).
Those convert cleanly and pass the round-trip verification gate, because they
are valid expressions — just not the one on screen. No downstream check can
catch that class, which is why the OCR'd LaTeX should be visible on success and
not only on failure.
