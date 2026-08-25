"""LaTeX -> the infix syntax integral-calculator.com / derivative-calculator.net eat.

Three stages: normalize (regex), parse (sympy), print (custom StrPrinter).
Every result is round-tripped before it is handed back, because a converter
bug that produces valid-but-wrong infix is worse than one that crashes.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from html import unescape
from urllib.parse import quote

from sympy import (
    Abs, Derivative, E, Eq, Function, Integral, Mul, Pow, Rational, Symbol,
    sqrt, log, pi,
)
from sympy import functions as sympy_functions
from sympy.parsing.latex import parse_latex
from sympy.printing.mathml import mathml
from sympy.parsing.sympy_parser import parse_expr

from .equivalence import agree
from .normalize import normalize
from .printer import FUNCTIONS, UnsupportedFunction, to_infix

INTEGRAL_URL = "https://www.integral-calculator.com/#"
DERIVATIVE_URL = "https://www.derivative-calculator.net/#"

_LATEX_COMMAND = re.compile(r"\\[a-zA-Z]+")
_WORD = re.compile(r"[A-Za-z]{2,}")

#: Names sympy would shred into a product of single letters. Bare `xy` is fine
#: (it really is x times y), but a bare `abs` or `sin` means OCR dropped a
#: backslash and the parse would be quietly wrong.
_FUNCTION_WORDS = frozenset(FUNCTIONS) | frozenset(FUNCTIONS.values()) | {
    "abs", "ln", "log", "exp", "sqrt", "root", "lim", "min", "max", "det",
    "arcsinh", "arccosh", "arctanh", "mod", "deg", "gcd", "lcm",
}


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
    mathml: str | None
    order: int

    def as_dict(self) -> dict:
        return asdict(self)


def _reject_implicit_words(latex: str) -> None:
    """Catch function names sympy would shred into implicit products.

    `abs(x-3)` parses cleanly as a*b*s(x-3). It round-trips perfectly, so the
    verification gate cannot see it; only a pre-parse check can. The check is
    deliberately narrow: real OCR output is full of legitimate glued products
    like `xy^2`, and rejecting those cost 17% of the corpus.
    """
    stripped = _LATEX_COMMAND.sub(" ", latex)
    for word in _WORD.findall(stripped):
        if word.lower() in _FUNCTION_WORDS:
            raise ConvertError(
                "convert_failed", f"bare function name would parse as a product: {word!r}"
            )


def _parse_failure(exc: Exception) -> str:
    """One readable line out of sympy's three-line caret diagram.

    It reports failures as a description, the input, and a row of tildes under
    the offending column. That is fine in a terminal and unreadable in a panel
    316 pixels wide, so keep the position and drop the drawing.
    """
    lines = str(exc).splitlines()
    if len(lines) >= 3 and set(lines[-1]) <= set("~^ ") and "^" in lines[-1]:
        column = lines[-1].index("^")
        source = lines[-2]
        fragment = source[max(0, column - 10) : column + 10].strip()
        return f"could not read the maths near “{fragment}”"
    return "could not read this as maths"


def _parse(latex: str):
    try:
        expr = parse_latex(latex)
    except Exception as exc:  # sympy raises several unrelated types here
        raise ConvertError("convert_failed", _parse_failure(exc)) from exc
    # parse_latex hands back plain symbols for the constants in some
    # positions and the real thing in others (`\pi` is a Symbol next to an
    # implicit product, but sympy's pi inside a bound). Canonicalise both so
    # verification compares like with like.
    return expr.subs({Symbol("e"): E, Symbol("pi"): pi})


#: derivative-calculator.net's order dropdown stops at the fifth.
MAX_DERIVATIVE_ORDER = 5


def _route(expr) -> tuple[str, object, Symbol, tuple | None, int]:
    # `F(x) = \int_0^x f(t) dt` is a normal way for a problem to be written, and
    # a crop of it catches the whole line. One operator on one side is
    # unambiguous; two would be a guess, so that still refuses.
    if isinstance(expr, Eq):
        sides = [side for side in expr.args if side.atoms(Integral, Derivative)]
        if len(sides) != 1:
            raise ConvertError(
                "unsupported_operator", "an equation with no single integral or derivative"
            )
        return _route(sides[0])

    # `2\pi \int_0^3 x^4 dx` — a constant in front of the operator, which the
    # shell and disk methods produce constantly. Both operators are linear, so
    # the factor folds inside and the answer is unchanged.
    if isinstance(expr, Mul):
        inner = [arg for arg in expr.args if isinstance(arg, (Integral, Derivative))]
        if len(inner) == 1:
            operator = inner[0]
            outside = Mul(*[arg for arg in expr.args if arg is not operator])
            if isinstance(operator, Integral):
                folded = Integral(outside * operator.function, *operator.limits)
            else:
                folded = Derivative(outside * operator.expr, *operator.variables)
            return _route(folded)
    if isinstance(expr, Integral):
        if len(expr.limits) != 1:
            raise ConvertError("unsupported_operator", "multiple integrals")
        limit = expr.limits[0]
        bounds = tuple(limit[1:]) if len(limit) == 3 else None
        return "integral", expr.function, limit[0], bounds, 1
    if isinstance(expr, Derivative):
        # Nested first derivatives arrive collapsed, so the repeat count is the
        # order and the site takes it as difforder rather than us differentiating.
        variables = expr.variables
        if len(set(variables)) != 1:
            raise ConvertError("unsupported_operator", "a mixed partial derivative")
        if len(variables) > MAX_DERIVATIVE_ORDER:
            raise ConvertError(
                "unsupported_operator", f"a derivative of order {len(variables)}"
            )
        return "derivative", expr.expr, variables[0], None, len(variables)
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


def _verify(original, infix: str, var) -> bool:
    try:
        return agree(original, _back_parse(infix), var)
    except Exception:
        return False


#: For a base that will be shown as a subscript rather than a second argument.
_SUBSCRIPT = str.maketrans("0123456789", "₀₁₂₃₄₅₆₇₈₉")


def _readable_logs(expr):
    """Spell logs the way they are written, for display only.

    sympy's `log` *is* the natural log, and both `log(x)` and the two-argument
    `log(x, E)` that `\ln` parses to print as "log" — so the render read
    `log(x, e)` beside an infix line saying `ln(x)`. A numeric base reads worse
    still: `log(x, 10)` looks like a log of two things.
    """
    swaps = {}
    for call in expr.atoms(log):
        if len(call.args) == 1 or call.args[1] is E:
            swaps[call] = Function("ln")(call.args[0])
        elif call.args[1].is_Integer:
            base = str(call.args[1]).translate(_SUBSCRIPT)
            swaps[call] = Function(f"log{base}")(call.args[0])
    return expr.xreplace(swaps) if swaps else expr


def _mathml(expr) -> str | None:
    """Presentation MathML for the whole expression, differential and all.

    Rendering what we *parsed* rather than what OCR emitted is the more useful
    check: a misread variable produces a valid expression that passes every
    downstream test, so the only thing that catches it is seeing `e^A` where
    the page said `e^x`.
    """
    try:
        body = unescape(mathml(_readable_logs(expr), printer="presentation"))
    except Exception:
        return None
    return f'<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">{body}</math>'


def _build_url(
    kind: str, infix: str, var: str, bounds: tuple[str, str] | None, order: int
) -> str:
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
        if order > 1:
            params.append(("difforder", str(order)))
        base = DERIVATIVE_URL
    return base + "&".join(f"{k}={quote(v, safe='')}" for k, v in params)


def convert(latex: str, hint: str | None = None) -> Result:
    cleaned = normalize(latex)
    _reject_implicit_words(cleaned)
    expression = _parse(cleaned)
    kind, body, var, bounds, order = _route(expression)

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
        url=_build_url(kind, infix, str(var), printed_bounds, order),
        verified=_verify(body, infix, var),
        mathml=_mathml(expression),
        order=order,
    )
