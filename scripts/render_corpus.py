r"""Render the golden corpus to PNGs for OCR benchmarking.

The acceptance table in tests/test_golden.py is already the list of expressions
we care about, so it doubles as the benchmark corpus: every rendered image
arrives with ground-truth LaTeX *and* the infix it must ultimately produce.
That lets a benchmark score OCR in the unit that matters (did the pipeline emit
the right infix?) rather than edit distance on LaTeX strings.

Rendering with real LaTeX rather than a Python mathtext approximation matters
here: pix2tex was trained on LaTeX output, so anything else measures the
renderer as much as the model.

    uv run python scripts/render_corpus.py [outdir]
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))
from test_golden import GOLDEN  # noqa: E402

#: Roughly: a 1x screenshot, a Retina screenshot, and a zoomed-in crop.
DPIS = (110, 220, 330)

TEMPLATE = r"""\documentclass[12pt]{article}
\usepackage{amsmath,amssymb}
\pagestyle{empty}
\begin{document}
\[ %s \]
\end{document}
"""


def slug(latex: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", latex.lower().replace("\\", ""))
    return cleaned.strip("-")[:40] or "expr"


def render(latex: str, dpi: int, target: Path, workdir: Path) -> bool:
    (workdir / "doc.tex").write_text(TEMPLATE % latex)
    for command in (
        ["latex", "-interaction=nonstopmode", "-halt-on-error", "doc.tex"],
        ["dvipng", "-D", str(dpi), "-T", "tight", "-bg", "White", "-fg", "Black",
         "-q", "-o", str(target), "doc.dvi"],
    ):
        done = subprocess.run(command, cwd=workdir, capture_output=True)
        if done.returncode != 0:
            return False
    return target.exists()


def main(outdir: str = "corpus") -> int:
    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    labels, skipped = [], []

    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        for index, (latex, infix) in enumerate(GOLDEN):
            name = f"{index:02d}-{slug(latex)}"
            rendered = []
            for dpi in DPIS:
                target = out / f"{name}@{dpi}.png"
                if render(latex, dpi, target, workdir):
                    rendered.append(target.name)
            if not rendered:
                skipped.append(latex)
                continue
            labels.append({"latex": latex, "infix": infix, "images": rendered})

    (out / "labels.json").write_text(json.dumps(labels, indent=2) + "\n")
    print(f"{len(labels)} expressions, {sum(len(l['images']) for l in labels)} images -> {out}/")
    for latex in skipped:
        print(f"  skipped (LaTeX would not compile): {latex}")
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:]))
