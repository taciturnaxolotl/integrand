# syntax=docker/dockerfile:1
#
# Two images out of one tree, because the two halves of this service have
# nothing in common but the code.
#
#   converter   sympy, antlr and fastapi. Small, starts instantly, and is the
#               part that has to be up whenever you snip.
#   ocr         the same code plus a model and torch, which is gigabytes and
#               wants a machine with room.
#
# Splitting them means the always-on part is the cheap part, the expensive part
# can be moved, restarted or switched off without taking convert and hint down
# with it, and neither needs redeploying when the other changes. They meet at
# one route: POST /v1/ocr, image in and LaTeX out.
#
# Each half is built with uv and then *left behind*: the runtime stages start
# from plain python and receive only the virtualenv. A build toolchain in a
# deployed image is a couple of hundred megabytes of attack surface that never
# runs.

# ---- building ----------------------------------------------------------------

FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS build

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
COPY src ./src


FROM build AS build-converter
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --group service


FROM build AS build-ocr
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --group service --group ocr


# ---- running -----------------------------------------------------------------

FROM python:3.12-slim-bookworm AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app
# The project is installed into the venv as a link back to /app/src, so the
# source has to land at the same path it had at build time.
COPY src ./src

RUN useradd --system --create-home --uid 999 integrand
EXPOSE 8765
CMD ["uvicorn", "integrand.service:app", "--host", "0.0.0.0", "--port", "8765"]


FROM runtime AS converter

COPY --from=build-converter /app/.venv /app/.venv

# The page and its download live only here — the OCR image answers /v1/ocr and
# nothing else. Copied after the venv so editing the page rebuilds one small
# layer rather than everything above it.
COPY landing ./landing
COPY extension ./extension
RUN python -c "import shutil; shutil.make_archive('/app/landing/integrand', 'zip', '.', 'extension')"

# Talks to the other image by default. Point INTEGRAND_OCR_URL wherever it
# lives, or set INTEGRAND_OCR=symbolab to do without one entirely.
ENV INTEGRAND_OCR=remote \
    INTEGRAND_OCR_URL=http://ocr:8765/v1/ocr

USER integrand

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8765/healthz', timeout=3)"


FROM runtime AS ocr

COPY --from=build-ocr /app/.venv /app/.venv

ENV INTEGRAND_OCR=pix2tex \
    HF_HOME=/home/integrand/.cache/huggingface

# Pull the weights at build time. Downloading them on first use instead means
# the first snip after every deploy is the slow one, and a box with no outbound
# network is one that never works but looks healthy until someone uses it.
#
# Before dropping privileges, because pix2tex writes the checkpoint inside its
# own site-packages directory rather than a cache dir. Root writes it once at
# build; the runtime user only ever reads it.
RUN python -c "from pix2tex.cli import LatexOCR; LatexOCR()" && echo "weights cached"

USER integrand

# Loading the model is slow enough that a short start period would restart a
# container that was only still starting.
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 \
    CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8765/healthz', timeout=5)"
