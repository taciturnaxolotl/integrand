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

**Hint?** sits under every result. Clicking it names the technique — *try a
substitution*, *integration by parts* — and clicking again gives up *u = ln(x)*.
Three steps, each asked for, because that a hint exists gives nothing away and
what u is has done the problem.

Both steps take the same beat whether or not there is anything to wait for.
Working out a technique runs from a twentieth of a second to two, and an
interface that is sometimes instant and sometimes not reads as unreliable. It comes from sympy's `integral_steps` rule tree, so it is a decision a
CAS actually made rather than a sentence a model produced, and it cannot be
confidently wrong.

Where the page knows its own maths, expressions light up as you move over them
and one click takes the whole thing — no rectangle to drag. Everything else
still crops.

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

During a selection the button becomes the way out of one: it stays put, turns
into a cross, and cancels — as does <kbd>Esc</kbd>. Toggle any site off in the
options page. To add a site that isn't listed,
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

## Deploying

Two images, built from one tree, because the two halves have nothing in common
but the code:

| | |
|---|---|
| **converter** | sympy, antlr and fastapi — 337MB, starts instantly |
| **ocr** | the same code plus a model and torch — gigabytes |

They meet at one route, `POST /v1/ocr`: image in, LaTeX out. Splitting them
means the part that has to be up whenever you snip is the cheap part, the
expensive part can be moved or switched off without taking the rest down, and
neither needs redeploying when the other changes.

```sh
docker compose up -d                        # both
docker compose up -d --no-deps integrand    # converter only
INTEGRAND_PORT=8799 docker compose up -d    # when 8765 is already yours
```

`--no-deps` is load-bearing: `depends_on` would otherwise start the model
alongside, which is the opposite of what you asked for.

Each half is built with uv and then left behind — the runtime stages start from
plain python and receive only the virtualenv, so no build toolchain is shipped.
Both run as a non-root user with `no-new-privileges`, the converter read-only
with all capabilities dropped, and both carry a healthcheck. The OCR container
is not published on the host; the converter reaches it over the compose
network, because nothing else has any business sending it images.

**Bring up the converter alone and it still works.** Snipping reports that OCR
is unreachable and says which host it tried, while `/v1/convert` and `/v1/hint`
carry on. Measured with the model not running at all:

```
POST /v1/convert  → sin(x), verified: true
POST /v1/hint     → {"technique":"integration by parts","detail":"u = x, dv = e^(x)"}
POST /v1/snip     → 502 {"error":"ocr_failed",
                         "detail":"no OCR service at http://ocr:8765/v1/ocr: …"}
```

That degraded state is intended rather than accidental. The extension can still
read maths off a page and still name a technique with no model deployed
anywhere.

Weights are pulled at build time. Downloading them on first use instead would
make the first snip after every deploy the slow one, and a box with no outbound
network would look healthy right up until someone used it.

The OCR image takes **CPU torch**. Left alone, uv resolves the CUDA build on
Linux and drags in fifteen `nvidia-*` packages plus triton — gigabytes of GPU
libraries the container will never load. `[tool.uv.sources]` points torch at
PyTorch's CPU index for `sys_platform == 'linux'` only, so macOS resolution is
untouched:

```
before   15 nvidia packages, triton
after    0, and torch 2.13.0+cpu on linux
```

That is not a compromise for deployment either — MPS measured 2.4x *slower*
than CPU on this model, which is why CoreML was dropped too.

### On another machine

`compose.yaml` builds from this checkout; `compose.ghcr.yaml` runs published
images and needs nothing else from the repo, so it can be copied to a host on
its own:

```sh
docker push ghcr.io/taciturnaxolotl/integrand:0.3.0
docker push ghcr.io/taciturnaxolotl/integrand-ocr:0.3.0

# on the host, alongside compose.yaml
echo "INTEGRAND_BIND=<its tailscale ip>" > .env
docker compose up -d
```

`INTEGRAND_BIND` defaults to loopback. Set it to the Tailscale address when
something else has to reach the service, which keeps it off the LAN either way.
Pulling is left explicit — `docker compose pull`. The images are public, so no
registry credential is needed anywhere.
Images are `linux/arm64`, built on Apple silicon for a host of the same shape;
a different architecture needs `docker buildx --platform`.

### Configuration

| | |
|---|---|
| `INTEGRAND_OCR` | `remote`, `pix2tex`, `unimernet`, `symbolab` |
| `INTEGRAND_OCR_URL` | where `remote` sends images |
| `INTEGRAND_OCR_TIMEOUT` | seconds to wait on it, default 30 |
| `INTEGRAND_ORIGINS` | CORS allowlist; set to `chrome-extension://<id>` |

### Why this is still Python

The core is `sympy` and about two hundred lines. `parse_latex`,
`integral_steps` — which is where the hints come from, grounded in a decision
the CAS actually made rather than a sentence a model generated — and `apart`
have no equivalent in another language. Rewriting would mean reimplementing a
computer algebra system, and the heavy dependency was never the algebra: it was
the OCR model, which is now a separate image that need not run at all.

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

Second and higher derivatives ride along too: `\frac{d^2}{dx^2}` is expanded
into nested first derivatives so sympy will parse it at all, and the repeat
count is sent as the site's own `difforder`, up to the fifth its dropdown
offers.

PDFs work too: Chrome's viewer is a normal `https:` document, so the overlay
paints over it and the crop captures the rendered page.

## Fixing the sites we read from

[`userscripts/`](userscripts/) carries fixes for the sites integrand works
against. So far: WebAssign's answer boxes vanish because MathJax is loaded once
per question and clobbers its own callbacks, and the bracket pairing that
disappeared when they moved off MathQuill. See
[userscripts/README.md](userscripts/README.md) — the causes are not guessable
from the symptoms.

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
