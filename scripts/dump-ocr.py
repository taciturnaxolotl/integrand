"""Run an OCR backend over a rendered corpus and write the raw LaTeX to JSON.

This exists because some backends cannot share a process with the converter.
UniMERNet pulls omegaconf, which pins antlr4-runtime to 4.9.3; sympy's LaTeX
parser needs 4.11. Installing both breaks whichever loses. So OCR runs in its
own environment and hands over a JSON file, which `benchmark.py --ocr-json`
then scores with the converter in the normal environment.

`integrand.ocr` is loaded straight off disk rather than imported, because
importing the package would pull in the converter and the antlr version we are
trying to avoid.

    INTEGRAND_UNIMERNET_CFG=cfg/unimernet_base.yaml \
      path/to/other/venv/bin/python scripts/dump-ocr.py unimernet corpus out.json
"""

from __future__ import annotations

import importlib.util
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

spec = importlib.util.spec_from_file_location("_ocr", ROOT / "src/integrand/ocr.py")
_ocr = importlib.util.module_from_spec(spec)
sys.modules["_ocr"] = _ocr
spec.loader.exec_module(_ocr)


def main(backend_name: str, corpus: str, out: str, dpi: str = "220") -> int:
    corpus_dir = Path(corpus)
    labels = json.loads((corpus_dir / "labels.json").read_text())

    started = time.perf_counter()
    backend = _ocr.load(backend_name)
    print(f"loaded {backend_name} in {time.perf_counter() - started:.1f}s", file=sys.stderr)

    seen, latencies = {}, []
    for label in labels:
        # corpora rendered by render_corpus.py tag the dpi; ad-hoc ones may not
        name = next((n for n in label["images"] if f"@{dpi}." in n), label["images"][0])
        began = time.perf_counter()
        try:
            seen[name] = backend((corpus_dir / name).read_bytes())
        except Exception as exc:
            seen[name] = None
            print(f"  {name}: {exc}", file=sys.stderr)
            continue
        latencies.append((time.perf_counter() - began) * 1000)

    Path(out).write_text(json.dumps({"backend": backend_name, "dpi": int(dpi),
                                     "latencies_ms": latencies, "latex": seen}, indent=2) + "\n")
    print(f"wrote {len(seen)} results to {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(*sys.argv[1:]))
