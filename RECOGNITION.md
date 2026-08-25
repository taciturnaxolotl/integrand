# Ways to recognise the maths

Notes from surveying alternatives to pix2tex, which sits at 27/35 on the corpus
(see [BENCHMARKS.md](BENCHMARKS.md)). Two axes turned out to matter: better
models, and not doing OCR at all.

## Don't OCR what the page already knows

A lot of web maths ships its own LaTeX. Where it does, recognition is exact and
free, and the accuracy question disappears.

| source | selector | measured |
|---|---|---|
| KaTeX, MathJax v3, MathML | `annotation[encoding="application/x-tex"]`, visible host is `.katex` | 965 exact sources on katex.org/docs/supported |
| MathJax v2 | `script[type^="math/tex"]`, drawn node is `<script id>-Frame` | 307 exact sources on one math.stackexchange question |
| Wikipedia | `img[alt]`, alt holds `{\displaystyle …}` | 235 exact sources on one article |

Wikipedia paints the MathML hidden and shows an `<img>`, so candidates must be
filtered to nodes that actually have a box before geometry is used. MathJax v2
needs the same care from the other direction: the script's previous sibling is
a zero-size `.MathJax_Preview` placeholder, not the rendering, and reaching for
it finds 333 of 397 expressions and measures none of them.

MathJax v2 also typesets progressively — on a 397-expression page the frames
appear over several seconds — which is why the page anchor retries before
deciding a page has no maths.

Resolving a crop to a source works: score each candidate by the fraction of its
bounding box the crop covers and take the best above 0.5. Tested on Wikipedia
with a crop 14px proud of the formula (covered 1.0) and one 3px inside it
(covered 0.89) — both returned the exact LaTeX.

The `{\displaystyle …}` wrapper Wikipedia uses is already handled: `normalize`
strips `\displaystyle` and `_strip_wrapping_braces` drops the braces.

All of the above is implemented in `extension/content/page-math.js`, which the
overlay consults before it captures anything. OCR now only has to cover what is
genuinely just pixels.

## WebAssign needs its own path

WebAssign renders neither LaTeX nor MathML for questions. It uses "watex":
maths composed from HTML tables plus `img.watexintimage` (`img/integral.gif`)
for the integral sign. The class names are structural, not decorative —

    watexintcomplex[ watexintabove, watexintimageblock, watexintbelow ]
    watexfraction[ watexnumerator, watexdenominator ]

— so a recursive walk over those classes reconstructs LaTeX deterministically.
Answer fields are separately real MathML (`<math><mi>ln</mi>…`), which converts
too.

This matters because OCR is a poor fit there: the maths renders at **13px** and
a typical expression is ~60px wide. At devicePixelRatio 2 that is roughly our
110dpi corpus, which scored 24/35. Reconstructing from the DOM is both exact
and easier than fighting the resolution.

The walker is implemented and **agrees with hand-transcribed ground truth on
36/36 expressions** of one assignment — 35 converting identically and one (an
equation with an integral on both sides) refused by both.

The full vocabulary is small: `watexfraction`/`watexnumerator`/
`watexdenominator`, `watexintcomplex`/`watexintlimitcomplex` with
`watexintabove`/`watexintbelow`/`watexintcontent`, `watexsqrt` with an optional
`watexsqrtroot*` index, `watexparenleft`/`watexparenright`, and `<sup>`.

Two things were not guessable and had to be found by looking:

- **Delimiters are tables, not characters.** `watexparenleft` sits on a
  `<table>` whose only content is an image. Handling it at the image level
  drops it silently, which turns `x^{2/3}(8 + x^{1/3})` into
  `x^{2/3}·8 + x^{1/3}` — converts, verifies, wrong question.
- **Variables are Mathematical Alphanumeric codepoints**, not ASCII. WebAssign
  writes `𝜃` (U+1D703), not `θ`. `String.normalize("NFKD")` folds the whole
  block back to plain letters.

## Better models, if OCR is unavoidable

- **UniMERNet** — purpose-built for real-world formula recognition, trained on
  UniMER-1M (1M instances) with a test set covering practical distributions.
  Reports higher accuracy *and* speed than prior work. Tiny variant runs under
  ONNX Runtime. Best candidate for a drop-in replacement.
- **GOT-OCR2.0** — 580M unified OCR model, keeps formulas as LaTeX. Formula
  F1 0.865 with multi-crop inference (0.749 single-scale). Punches above much
  larger VLMs.
- **texify** (now folded into Surya) — outputs markdown with embedded LaTeX
  rather than pure LaTeX; built for inline maths in documents.
- **pix2text-mfr** — TrOCR architecture retrained on formula images.
- **Local VLMs on MLX** — Qwen3-VL 8B beats Qwen2.5-VL on OCR and maths at
  every benchmark; MonkeyOCR ships Apple-Silicon MLX builds. Accurate but far
  heavier than a 100MB specialist, and slower per request.
- **Mathpix** — commercial, still the accuracy ceiling, paid.

The backend seam in `src/integrand/ocr.py` already takes any of these.
