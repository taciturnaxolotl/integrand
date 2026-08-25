# integrand

math snipping extension

Screenshot a math expression in the browser, land on
[integral-calculator.com](https://www.integral-calculator.com) or
[derivative-calculator.net](https://www.derivative-calculator.net) with the
problem already filled in.

## Running the prototype

```sh
# the service (Symbolab OCR by default; see the note below)
uv run --group service uvicorn integrand.service:app --port 8765

# or with the local model, which is what ships
INTEGRAND_OCR=pix2tex uv run --group service --group ocr \
  uvicorn integrand.service:app --port 8765
```

Then load `extension/` unpacked: `chrome://extensions` → developer mode →
**Load unpacked**. Drag over a problem, check what it read, hit **Open
calculator**.

Four ways to start a snip:

- the toolbar button
- <kbd>⌘⇧Y</kbd> / <kbd>Ctrl+Shift+Y</kbd>
- right-click → **Snip this maths problem**
- the **∫** on the right edge, on sites you have opted into

Nine homework sites ship switched on — WebAssign, MyOpenMath, Canvas,
DeltaMath, Gradescope, Khan Academy, Wikipedia, math.stackexchange, OpenStax —
each one a site the page reader can read directly rather than photograph. Even
there the button only appears on pages where it actually finds maths, so a
course's login page stays clean while its homework pages do not.

Toggle any of them off in the options page. To add a site that isn't listed,
open it and **right-click the toolbar icon**.

The extension only ever talks to the service, so swapping OCR backends does not
touch it. Before it captures anything it asks the page whether it already knows
its own maths — KaTeX, MathJax, MathML, Wikipedia alt text and WebAssign's
watex markup all carry it — and where they do, the result is exact and OCR
never runs. See [RECOGNITION.md](RECOGNITION.md).

> The default `symbolab` backend posts images to Symbolab's unauthenticated
> `getImageId` endpoint. It is there because it is accurate enough to develop
> against while the local model catches up. It is not something to ship: it is
> someone else's compute, and it breaks the promise that images never leave
> your box. Set `INTEGRAND_OCR=pix2tex` before letting anyone else near this.

## Testing

```sh
uv run pytest                              # 61 cases, no network
uv run python scripts/render_corpus.py corpus
uv run --group ocr python scripts/benchmark.py corpus --backend pix2tex --device cpu
```

```sh
node scripts/preview-panel.js          # render the result panel in every state
python3 -m http.server -d .preview 8799
```

See [BENCHMARKS.md](BENCHMARKS.md) for backend numbers.

This depends on someone else's free site and will break if David Scherfgen
changes his URL scheme.

The canonical repo for this is hosted on tangled over at [`https://tangled.org/dunkirk.sh/integrand`](https://tangled.org/dunkirk.sh/integrand)

<p align="center">
    <img src="https://raw.githubusercontent.com/taciturnaxolotl/carriage/main/.github/images/line-break.svg" />
</p>

<p align="center">
    <i><code>&copy; 2026-present <a href="https://dunkirk.sh">Kieran Klukas</a></code></i>
</p>

<p align="center">
    <a href="https://tangled.org/dunkirk.sh/integrand/blob/main/LICENSE.md"><img src="https://img.shields.io/static/v1.svg?style=for-the-badge&label=License&message=MIT&logoColor=d9e0ee&colorA=363a4f&colorB=b7bdf8"/></a>
</p>
