r"""Score an OCR backend on the rendered golden corpus.

Scoring is in the unit that matters: did the whole pipeline land on the right
infix string? A backend that returns cosmetically different LaTeX but converts
to the same expression has not made a mistake, and edit distance on LaTeX would
say otherwise.

Backends are pluggable so the pix2tex CPU/MPS/CoreML comparison in milestone 2
drops straight in beside the reference numbers.

    uv run python scripts/render_corpus.py corpus
    uv run python scripts/benchmark.py corpus --backend symbolab --limit 15
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
from pathlib import Path

from integrand.convert import ConvertError, convert


def symbolab_backend(image: Path) -> str:
    """Reference numbers from a commercial model. Sends the image off-box."""
    import requests

    response = requests.post(
        "https://www.symbolab.com/api/getImageId",
        params={"sessionid": "1", "language": "en"},
        files={"data": (image.name, image.read_bytes(), "image/png")},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()["latex"]


def make_pix2tex(device: str):
    """The one we actually intend to ship.

    pix2tex hardcodes cuda-or-cpu and has no MPS path, so the device is moved
    after construction. Whether that move is a win is the whole question: the
    ViT encoder likes a GPU, but the decoder is autoregressive over ~50-150
    tokens and per-kernel launch overhead can swamp a model this small.
    """
    from munch import Munch
    from PIL import Image
    from pix2tex.cli import LatexOCR

    started = time.perf_counter()
    model = LatexOCR(
        Munch(
            config="settings/config.yaml",
            checkpoint="checkpoints/weights.pth",
            no_cuda=True,
            no_resize=False,
        )
    )
    # pix2tex samples at temperature .25 by default, which makes both the
    # accuracy number and the failures irreproducible. Near-greedy decoding is
    # the right call for OCR anyway: there is one correct answer.
    model.args.temperature = 1e-8
    if device != "cpu":
        model.args.device = device
        model.model = model.model.to(device)
        if model.image_resizer is not None:
            model.image_resizer = model.image_resizer.to(device)
    print(f"  model loaded on {device} in {time.perf_counter() - started:.1f}s")

    def run(image: Path) -> str:
        return model(Image.open(image))

    return run


def make_backend(name: str, device: str):
    if name == "symbolab":
        return symbolab_backend
    return make_pix2tex(device)


BACKENDS = ("symbolab", "pix2tex")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("corpus", type=Path)
    parser.add_argument("--backend", choices=BACKENDS, default="pix2tex")
    parser.add_argument("--device", default="cpu", help="cpu or mps (pix2tex only)")
    parser.add_argument("--dpi", type=int, default=220)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--delay", type=float, default=0.0, help="seconds between calls")
    args = parser.parse_args()

    labels = json.loads((args.corpus / "labels.json").read_text())
    if args.limit:
        labels = labels[: args.limit]
    backend = make_backend(args.backend, args.device)

    warmup = next((args.corpus / n for l in labels for n in l["images"] if f"@{args.dpi}." in n), None)
    if warmup is not None and args.backend != "symbolab":
        backend(warmup)  # lazy init and kernel compilation are not per-request costs

    exact = converted = verified = 0
    latencies, misses = [], []

    for label in labels:
        image = next(
            (args.corpus / name for name in label["images"] if f"@{args.dpi}." in name), None
        )
        if image is None:
            continue

        started = time.perf_counter()
        try:
            seen = backend(image)
        except Exception as exc:
            misses.append((label["latex"], f"backend error: {exc}"))
            continue
        latencies.append((time.perf_counter() - started) * 1000)

        try:
            result = convert(seen)
        except ConvertError as exc:
            misses.append((label["latex"], f"{exc.code}: {exc.detail}"))
            continue

        converted += 1
        verified += result.verified
        if result.infix == label["infix"]:
            exact += 1
        else:
            misses.append((label["latex"], f"infix {result.infix!r} != {label['infix']!r}"))

        time.sleep(args.delay)

    total = len(labels)
    label = args.backend if args.backend == "symbolab" else f"{args.backend}/{args.device}"
    print(f"\n{label} @ {args.dpi}dpi, {total} expressions")
    print(f"  converted  {converted}/{total}")
    print(f"  verified   {verified}/{total}")
    print(f"  exact      {exact}/{total}")
    if latencies:
        ordered = sorted(latencies)
        p95 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]
        print(f"  p50 {statistics.median(ordered):.0f}ms   p95 {p95:.0f}ms")
    if misses:
        print("\n  misses:")
        for latex, why in misses:
            print(f"    {latex}\n      {why}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
