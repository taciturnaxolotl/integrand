"""OCR backends: two local models and one over the network.

The extension only ever talks to the service, so changing model is a config
change rather than an extension rewrite.
"""

from __future__ import annotations

import base64
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
    """Loaded once at startup, so the first request is not the slow one.

    CPU on purpose: MPS measured 2.4x slower on this decoder, and UniMERNet is
    more accurate than either. See BENCHMARKS.md.
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


def unimernet() -> Backend:
    """UniMERNet, via the upstream package's config-driven loader.

    Needs its own environment: the package pins transformers 4.42, which pix2tex
    and anything modern will not share. Point INTEGRAND_UNIMERNET_CFG at a
    config yaml; see RECOGNITION.md.
    """
    import argparse

    import torch
    import unimernet.tasks as tasks
    from PIL import Image
    from unimernet.common.config import Config
    from unimernet.processors import load_processor

    cfg_path = os.environ["INTEGRAND_UNIMERNET_CFG"]
    cfg = Config(argparse.Namespace(cfg_path=cfg_path, options=None))
    model = tasks.setup_task(cfg).build_model(cfg).to("cpu").eval()
    vis = load_processor(
        "formula_image_eval", cfg.config.datasets.formula_rec_eval.vis_processor.eval
    )

    def run(image: bytes) -> str:
        tensor = vis(Image.open(io.BytesIO(image)).convert("RGB")).unsqueeze(0)
        with torch.no_grad():
            return model.generate({"image": tensor})["pred_str"][0]

    return run


def remote() -> Backend:
    """OCR on another box.

    This is what keeps the service image small. The converter is sympy and
    almost nothing else — a couple of hundred megabytes — while a model and its
    half a gigabyte of torch are a different kind of thing to deploy. Splitting
    them means the part that has to be up all the time is the cheap part, and
    the expensive part can live wherever there is room, or not run at all.

    Deliberately stdlib: adding an HTTP client to pull one JSON body would put
    a dependency into the very image whose smallness is the point.
    """
    import json
    import urllib.error
    import urllib.request

    url = os.environ.get("INTEGRAND_OCR_URL", "http://ocr:8765/v1/ocr")
    timeout = float(os.environ.get("INTEGRAND_OCR_TIMEOUT", "30"))

    def run(image: bytes) -> str:
        payload = json.dumps({"image": base64.b64encode(image).decode()}).encode()
        request = urllib.request.Request(
            url, data=payload, headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read())["latex"]
        except urllib.error.URLError as cause:
            # Say which box was not reachable; "connection refused" on its own
            # is a bad thing to read at midnight.
            raise RuntimeError(f"no OCR service at {url}: {cause.reason}") from cause

    return run


def load(name: str | None = None) -> Callable[[bytes], str]:
    name = name or os.environ.get("INTEGRAND_OCR", "symbolab")
    if name == "symbolab":
        return symbolab
    if name == "pix2tex":
        return pix2tex()
    if name == "unimernet":
        return unimernet()
    if name == "remote":
        return remote()
    raise ValueError(f"unknown OCR backend: {name!r}")
