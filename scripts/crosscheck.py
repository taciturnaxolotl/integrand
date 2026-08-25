r"""End-to-end oracle: does our converted integrand match an independent solver?

Symbolab's `getImageId` endpoint is unauthenticated and returns both the OCR'd
LaTeX and a final antiderivative. Differentiating that antiderivative should
give back the integrand we produced. Nothing in that chain shares code with us,
so a match exercises OCR, normalisation, parsing and printing at once.

This is a development tool, not part of the service. It sends images to a third
party; run it on your own screenshots only.

    uv run python scripts/crosscheck.py shot.png [more.png ...]
"""

from __future__ import annotations

import sys
from pathlib import Path

import requests
from sympy import Symbol, diff

from integrand.convert import ConvertError, convert
from integrand.equivalence import agree
from integrand.normalize import normalize

ENDPOINT = "https://www.symbolab.com/api/getImageId"


def ocr(path: Path) -> dict:
    response = requests.post(
        ENDPOINT,
        params={"sessionid": "1", "language": "en"},
        files={"data": (path.name, path.read_bytes(), "image/jpeg")},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def antiderivative_matches(solution_latex: str, integrand, var) -> bool | None:
    """Strip the constant of integration, differentiate, compare.

    Returns None when the solution itself is beyond our parser, which is a
    limitation of the check rather than a failure of the conversion.
    """
    from sympy.parsing.latex import parse_latex

    stripped = normalize(solution_latex).replace("+C", "").replace("+c", "").strip()
    try:
        parsed = parse_latex(stripped)
    except Exception:
        return None
    # abs() only has a sensible derivative over the reals, and parse_latex
    # hands back symbols with no assumptions at all.
    real = Symbol(var.name, real=True)
    return agree(diff(parsed.subs(var, real), real), integrand.subs(var, real), real)


def main(paths: list[str]) -> int:
    failures = 0
    for raw in paths:
        path = Path(raw)
        seen = ocr(path)
        print(f"{path.name}\n  latex    {seen['latex']}")

        try:
            result = convert(seen["latex"])
        except ConvertError as exc:
            print(f"  REJECTED {exc.code}: {exc.detail}\n")
            failures += 1
            continue

        print(f"  infix    {result.infix}")
        print(f"  verified {result.verified}")

        from sympy.parsing.latex import parse_latex

        integrand = parse_latex(normalize(seen["latex"])).function
        agrees = antiderivative_matches(seen["solution"], integrand, Symbol(result.var))
        label = {True: "agrees", False: "DISAGREES", None: "unparseable"}[agrees]
        print(f"  oracle   {label}  ({seen['solution']})\n")
        if agrees is False or not result.verified:
            failures += 1

    print(f"{len(paths) - failures}/{len(paths)} clean")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] or ["-"]))
