"""OCR backends. One in-process model, one over the network.

Swapping these is the whole point of the seam: the extension only ever talks to
this service, so replacing Symbolab with pix2tex is a config change rather than
an extension rewrite.
"""

from __future__ import annotations

import io
import os
from typing import Callable, Protocol


class Backend(Protocol):
    def __call__(self, image: bytes) -> str: ...


def symbolab(image: bytes) -> str:
    """Sends the image off-box. For development only; see README."""
    import requests

    response = requests.post(
        "https://www.symbolab.com/api/getImageId",
        params={"sessionid": "1", "language": "en"},
        files={"data": ("snip.png", image, "image/png")},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()["latex"]


def pix2tex() -> Backend:
    """Load the model once, at startup, so the first request is not the slow one.

    CPU on purpose: MPS measured 2.4x slower on this decoder. See BENCHMARKS.md.
    """
    from munch import Munch
    from PIL import Image
    from pix2tex.cli import LatexOCR

    model = LatexOCR(
        Munch(
            config="settings/config.yaml",
            checkpoint="checkpoints/weights.pth",
            no_cuda=True,
            no_resize=False,
        )
    )
    model.args.temperature = 1e-8  # greedy; there is one correct answer

    def run(image: bytes) -> str:
        return model(Image.open(io.BytesIO(image)))

    return run


def load(name: str | None = None) -> Callable[[bytes], str]:
    name = name or os.environ.get("INTEGRAND_OCR", "symbolab")
    if name == "symbolab":
        return symbolab
    if name == "pix2tex":
        return pix2tex()
    raise ValueError(f"unknown OCR backend: {name!r}")
