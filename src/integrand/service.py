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

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import ocr
from .convert import ConvertError, convert

MAX_BODY_BYTES = 2 * 1024 * 1024
OCR_TIMEOUT_SECONDS = 15.0

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


@app.on_event("startup")
def _load_backend() -> None:
    global _backend
    _backend = ocr.load()


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


@app.post("/v1/snip")
async def snip(body: SnipRequest, request: Request) -> JSONResponse:
    if int(request.headers.get("content-length", 0)) > MAX_BODY_BYTES:
        return JSONResponse(status_code=413, content={"error": "image_too_large"})

    try:
        image = base64.b64decode(body.image.split(",")[-1], validate=True)
    except (binascii.Error, ValueError):
        return JSONResponse(status_code=400, content={"error": "bad_base64"})

    if not image.startswith(MAGIC):
        return JSONResponse(status_code=415, content={"error": "not_png_or_jpeg"})

    if _semaphore.locked() and _semaphore._value <= 0:
        return JSONResponse(
            status_code=503,
            content={"error": "busy"},
            headers={"Retry-After": "2"},
        )

    started = time.perf_counter()
    async with _semaphore:
        try:
            latex = await asyncio.wait_for(
                asyncio.to_thread(_backend, image), timeout=OCR_TIMEOUT_SECONDS
            )
        except asyncio.TimeoutError:
            return JSONResponse(status_code=504, content={"error": "ocr_timeout"})
        except Exception as exc:
            return JSONResponse(
                status_code=502, content={"error": "ocr_failed", "detail": str(exc)}
            )
    ocr_ms = round((time.perf_counter() - started) * 1000)

    convert_started = time.perf_counter()
    response = _converted(latex)
    convert_ms = round((time.perf_counter() - convert_started) * 1000)

    import json

    payload = json.loads(response.body)
    payload["ms"] = {"ocr": ocr_ms, "convert": convert_ms}
    return JSONResponse(status_code=response.status_code, content=payload)
