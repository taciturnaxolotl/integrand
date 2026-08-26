"""The snip service. Stateless by construction: nothing here touches disk.

Images arrive, get decoded in memory, get converted, and are dropped when the
request ends. There is no cache because there is nothing worth caching — OCR
keys on image bytes, and two crops of the same problem are never byte-identical.

    uv run --group service --group ocr uvicorn integrand.service:app --port 8000
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import os
import time
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import hint as hints
from . import ocr
from .convert import ConvertError, convert, parse

MAX_BODY_BYTES = 2 * 1024 * 1024
OCR_TIMEOUT_SECONDS = 15.0

#: Working out the technique is CPU-bound sympy and occasionally slow — six
#: seconds on the worst real problem measured. It shares the OCR cap so a burst
#: cannot take the box down, and gives up rather than holding a worker.
HINT_TIMEOUT_SECONDS = 6.0

#: Cap in-flight OCR below the core count. Rate limiting alone will not save a
#: small box: one slow queue is enough to exhaust it.
MAX_CONCURRENT_OCR = max(1, (os.cpu_count() or 2) - 1)

#: PNG and JPEG magic bytes. Arbitrary bytes do not reach an image decoder.
MAGIC = (b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff")

app = FastAPI(title="integrand")
app.add_middleware(
    CORSMiddleware,
    # chrome-extension:// is not a normal origin and a naive https-only
    # allowlist rejects it. Set INTEGRAND_ORIGINS to the extension's id.
    allow_origins=os.environ.get("INTEGRAND_ORIGINS", "*").split(","),
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["Content-Type"],
)

_started = time.monotonic()
_semaphore = asyncio.Semaphore(MAX_CONCURRENT_OCR)
_backend = None


class SnipRequest(BaseModel):
    image: str
    hint: str | None = None


class ConvertRequest(BaseModel):
    latex: str


class HintRequest(BaseModel):
    latex: str


class OcrRequest(BaseModel):
    image: str


@app.on_event("startup")
def _load_backend() -> None:
    global _backend
    _backend = ocr.load()


#: Served by the service itself rather than the proxy, so the page ships and
#: versions with the code that it describes, and `docker compose up` gives you
#: the whole thing rather than an API with no front door.
_LANDING = Path(__file__).resolve().parents[2] / "landing" / "index.html"


#: Favicon, social card and touch icon. Mounted rather than a route each,
#: because the set will grow and none of it is worth a handler.
if (_LANDING.parent / "assets").is_dir():
    app.mount(
        "/assets",
        StaticFiles(directory=_LANDING.parent / "assets"),
        name="assets",
    )


#: HEAD as well as GET. Uptime checks and link unfurlers reach for it, and a
#: 405 on the front page reads like the site is down.
@app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
def landing() -> Response:
    if not _LANDING.is_file():
        return JSONResponse(content={"service": "integrand", "docs": "/docs"})
    return FileResponse(_LANDING, media_type="text/html")


@app.get("/integrand.zip", include_in_schema=False)
def download() -> Response:
    """The extension, as built into this image."""
    archive = _LANDING.with_name("integrand.zip")
    if not archive.is_file():
        return JSONResponse(status_code=404, content={"error": "no build here"})
    return FileResponse(
        archive,
        media_type="application/zip",
        filename="integrand.zip",
    )


@app.get("/healthz")
def healthz() -> dict:
    return {
        "ok": True,
        "model_loaded": _backend is not None,
        "uptime_s": int(time.monotonic() - _started),
    }


def _converted(latex: str, extra: dict | None = None) -> JSONResponse:
    try:
        result = convert(latex)
    except ConvertError as exc:
        return JSONResponse(
            status_code=422,
            content={"error": exc.code, "latex": latex, "detail": exc.detail},
        )
    return JSONResponse(content={**result.as_dict(), **(extra or {})})


@app.post("/v1/convert")
def convert_endpoint(body: ConvertRequest) -> JSONResponse:
    started = time.perf_counter()
    response = _converted(body.latex)
    if response.status_code == 200:
        import json

        payload = json.loads(response.body)
        payload["ms"] = {"convert": round((time.perf_counter() - started) * 1000)}
        return JSONResponse(content=payload)
    return response


@app.post("/v1/hint")
async def hint_endpoint(body: HintRequest) -> JSONResponse:
    """The technique, in two parts. Never on the path to a result."""
    try:
        expression = parse(body.latex)
    except ConvertError as exc:
        return JSONResponse(status_code=422, content={"error": exc.code, "detail": exc.detail})

    async with _semaphore:
        try:
            found = await asyncio.wait_for(
                asyncio.to_thread(hints.describe, expression), timeout=HINT_TIMEOUT_SECONDS
            )
        except asyncio.TimeoutError:
            return JSONResponse(content={"hint": None, "reason": "took too long"})
    return JSONResponse(content={"hint": found.as_dict() if found else None})


def _decode(body_image: str, request: Request) -> bytes | JSONResponse:
    """The same gate for both routes. An OCR service is still a service."""
    if int(request.headers.get("content-length", 0)) > MAX_BODY_BYTES:
        return JSONResponse(status_code=413, content={"error": "image_too_large"})

    try:
        image = base64.b64decode(body_image.split(",")[-1], validate=True)
    except (binascii.Error, ValueError):
        return JSONResponse(status_code=400, content={"error": "bad_base64"})

    if not image.startswith(MAGIC):
        return JSONResponse(status_code=415, content={"error": "not_png_or_jpeg"})

    return image


async def _read(image: bytes) -> str | JSONResponse:
    """OCR under the shared cap, so no route can exhaust the box alone."""
    if _semaphore.locked() and _semaphore._value <= 0:
        return JSONResponse(
            status_code=503, content={"error": "busy"}, headers={"Retry-After": "2"}
        )

    async with _semaphore:
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(_backend, image), timeout=OCR_TIMEOUT_SECONDS
            )
        except asyncio.TimeoutError:
            return JSONResponse(status_code=504, content={"error": "ocr_timeout"})
        except Exception as exc:
            return JSONResponse(
                status_code=502, content={"error": "ocr_failed", "detail": str(exc)}
            )


@app.post("/v1/ocr")
async def read(body: OcrRequest, request: Request) -> JSONResponse:
    """Image in, LaTeX out, and nothing else.

    This is the whole contract between the two images. The converter never
    needs a model and the model never needs sympy, so each can be deployed,
    restarted and sized without reference to the other.
    """
    image = _decode(body.image, request)
    if isinstance(image, JSONResponse):
        return image

    latex = await _read(image)
    if isinstance(latex, JSONResponse):
        return latex

    return JSONResponse(content={"latex": latex})


@app.post("/v1/snip")
async def snip(body: SnipRequest, request: Request) -> JSONResponse:
    decoded = _decode(body.image, request)
    if isinstance(decoded, JSONResponse):
        return decoded
    image = decoded

    started = time.perf_counter()
    latex = await _read(image)
    if isinstance(latex, JSONResponse):
        return latex
    ocr_ms = round((time.perf_counter() - started) * 1000)

    convert_started = time.perf_counter()
    response = _converted(latex)
    convert_ms = round((time.perf_counter() - convert_started) * 1000)

    import json

    payload = json.loads(response.body)
    payload["ms"] = {"ocr": ocr_ms, "convert": convert_ms}
    return JSONResponse(status_code=response.status_code, content=payload)
