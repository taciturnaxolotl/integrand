"""LaTeX -> the infix syntax integral-calculator.com / derivative-calculator.net eat.

Three stages: normalize (regex), parse (sympy), print (custom StrPrinter).
Every result is round-tripped before it is handed back, because a converter
bug that produces valid-but-wrong infix is worse than one that crashes.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from urllib.parse import quote

from sympy import (
    Abs, Derivative, E, Integral, Pow, Rational, Symbol, sqrt, log, pi, simplify,
)
from sympy import functions as sympy_functions
from sympy.parsing.latex import parse_latex
from sympy.parsing.sympy_parser import parse_expr

from .normalize import normalize
from .printer import FUNCTIONS, UnsupportedFunction, to_infix

INTEGRAL_URL = "https://www.integral-calculator.com/#"
DERIVATIVE_URL = "https://www.derivative-calculator.net/#"

_LATEX_COMMAND = re.compile(r"\\[a-zA-Z]+")
_WORD = re.compile(r"[A-Za-z]{2,}")
_DIFFERENTIAL = re.compile(r"^d[a-zA-Z]$")


class ConvertError(Exception):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


@dataclass
class Result:
    latex: str
    infix: str
    kind: str
    var: str
    bounds: tuple[str, str] | None
    url: str
    verified: bool

    def as_dict(self) -> dict:
        return asdict(self)


def _reject_implicit_words(latex: str) -> None:
    """Catch multi-letter names sympy would shred into implicit products.

    `abs(x-3)` parses cleanly as a*b*s(x-3). It round-trips perfectly, so the
    verification gate cannot see it. Only a pre-parse check can.
    """
    stripped = _LATEX_COMMAND.sub(" ", latex)
    for word in _WORD.findall(stripped):
        if not _DIFFERENTIAL.match(word):
            raise ConvertError(
                "convert_failed", f"bare word would parse as a product: {word!r}"
            )


def _parse(latex: str):
    try:
        expr = parse_latex(latex)
    except Exception as exc:  # sympy raises several unrelated types here
        raise ConvertError("convert_failed", f"parse error: {exc}".strip()) from exc
    # parse_latex hands back plain symbols for the constants in some
    # positions and the real thing in others (`\pi` is a Symbol next to an
    # implicit product, but sympy's pi inside a bound). Canonicalise both so
    # verification compares like with like.
    return expr.subs({Symbol("e"): E, Symbol("pi"): pi})


def _route(expr) -> tuple[str, object, Symbol, tuple | None]:
    if isinstance(expr, Integral):
        if len(expr.limits) != 1:
            raise ConvertError("unsupported_operator", "multiple integrals")
        limit = expr.limits[0]
        bounds = tuple(limit[1:]) if len(limit) == 3 else None
        return "integral", expr.function, limit[0], bounds
    if isinstance(expr, Derivative):
        if len(expr.variables) != 1:
            raise ConvertError("unsupported_operator", "higher-order derivatives")
        return "derivative", expr.expr, expr.variables[0], None
    raise ConvertError(
        "unsupported_operator",
        f"expected an integral or derivative, got {type(expr).__name__}",
    )


def _back_parse(infix: str):
    """Read our own output back, using the site's spellings."""
    names = {site: getattr(sympy_functions, name, None) for name, site in FUNCTIONS.items()}
    local = {site: fn for site, fn in names.items() if fn is not None}
    local.update(
        e=E,
        pi=pi,
        ln=log,
        log=lambda base, arg: log(arg, base),
        root=lambda n, arg: Pow(arg, Rational(1, n)),
        sqrt=sqrt,
        abs=Abs,
    )
    return parse_expr(infix.replace("^", "**"), local_dict=local)


def _verify(original, infix: str) -> bool:
    try:
        return simplify(original - _back_parse(infix)) == 0
    except Exception:
        return False


def _build_url(kind: str, infix: str, var: str, bounds: tuple[str, str] | None) -> str:
    """Both sites read `#`-delimited k=v pairs at parse time.

    The param names come from the inline bootstrap script on each page:
    integral-calculator uses intvar/lbound/ubound, derivative-calculator uses
    diffvar/difforder/showsteps. They decodeURIComponent each value, so an
    encoded `+` survives; encoding the whole value keeps `&` and `=` out.
    """
    if kind == "integral":
        params = [("expr", infix), ("intvar", var)]
        if bounds:
            params += [("lbound", bounds[0]), ("ubound", bounds[1])]
        base = INTEGRAL_URL
    else:
        params = [("expr", infix), ("diffvar", var), ("showsteps", "1")]
        base = DERIVATIVE_URL
    return base + "&".join(f"{k}={quote(v, safe='')}" for k, v in params)


def convert(latex: str, hint: str | None = None) -> Result:
    cleaned = normalize(latex)
    _reject_implicit_words(cleaned)
    kind, body, var, bounds = _route(_parse(cleaned))

    try:
        infix = to_infix(body)
    except UnsupportedFunction as exc:
        raise ConvertError("convert_failed", f"unsupported function: {exc}") from exc

    printed_bounds = tuple(to_infix(b) for b in bounds) if bounds else None
    return Result(
        latex=latex,
        infix=infix,
        kind=kind,
        var=str(var),
        bounds=printed_bounds,
        url=_build_url(kind, infix, str(var), printed_bounds),
        verified=_verify(body, infix),
    )
