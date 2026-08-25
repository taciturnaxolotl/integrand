# OCR backend benchmark

Corpus: the 35 expressions in `tests/test_golden.py`, rendered with LaTeX and
`dvipng` (`scripts/render_corpus.py`), scored by `scripts/benchmark.py`.

Scoring is on the final infix string, not on LaTeX edit distance. A model that
returns cosmetically different LaTeX which converts to the same expression has
not made a mistake.

Machine: MacBook, Apple Silicon (arm64), torch 2.13, pix2tex 0.1.4.

## Device

| backend | exact | p50 | p95 |
|---|---|---|---|
| pix2tex / cpu | 27/35 | 160ms | 236ms |
| pix2tex / mps | 26/35 | 397ms | 851ms |
| symbolab (network reference) | 34/35 | 401ms | 537ms |

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

## Accuracy gap

pix2tex lands at 27/35 against Symbolab's 34/35. Roughly one snip in four will
need hand-fixing, so the editable-LaTeX fallback in the extension is the main
path for a quarter of uses, not an error case.

Most remaining misses are a single misread variable (`x` read as `A`, `S`, `k`).
Those convert cleanly and pass the round-trip verification gate, because they
are valid expressions — just not the one on screen. No downstream check can
catch that class, which is why the OCR'd LaTeX should be visible on success and
not only on failure.
