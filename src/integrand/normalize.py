r"""Lossless cleanup of LaTeX that sympy's parser chokes on.

Order matters. `\left|x-3\right|` only parses once the delimiters are gone,
and `\mathop{}\!\mathrm{d}` has to be recognised before `\!` is stripped.
"""

import re

#: LaTeX operator names. Models routinely emit `\mathrm{arctan}` where a human
#: writes `\arctan`; stripping the wrapper to a bare word would leave sympy to
#: read it as a product of seven symbols, so restore the command instead.
_OPERATORS = (
    "arcsin|arccos|arctan|arcsec|arccsc|arccot|arsinh|arcosh|artanh"
    "|sinh|cosh|tanh|sech|csch|coth|sin|cos|tan|sec|csc|cot"
    "|ln|log|exp|det|dim|gcd|lim|max|min|deg|arg"
)

#: Some models emit one space between every token — `\frac { d } { d x }`.
#: Whitespace touching a brace never carries meaning, and every structural rule
#: below matches on tight braces, so this runs first.
_LOOSE_BRACES = re.compile(r"\s*([{}])\s*")

_SUBSTITUTIONS: list[tuple[str, str]] = [
    (r"\\mathop\{\}\s*\\!?\s*\\mathrm\{d\}", "d"),
    (r"\\mathrm\{d\}", "d"),
    (rf"\\(?:mathrm|operatorname|mathop|mathnormal)\{{({_OPERATORS})\}}", r"\\\1"),
    # a single letter in a decorative font is still just a variable
    (r"\\(?:mathcal|mathbb|mathfrak|mathsf|mathbf|boldsymbol)\{([A-Za-z])\}", r"\1"),
    (r"\\(?:dfrac|tfrac)\b", r"\\frac"),
    (r"\\left\.|\\right\.", ""),
    (r"\\left|\\right", ""),
    # \big \Bigg \Bigl \bigr … — sizing hints with no meaning for us
    (r"\\[bB]igg?[lrm]?", ""),
    # not \b: an underscore is a word character, so `\limits_{1}` has no
    # boundary after "limits" and the styling survives into the parser
    (r"\\(?:displaystyle|limits|nolimits)(?![a-zA-Z])", ""),
    (r"\\(?:quad|qquad)\b", " "),
    (r"\\[,;:!]", ""),
    (r"~", " "),  # LaTeX's non-breaking space
    (r"\\ ", " "),
    (r"\\(?:cdot|times|ast)\b", "*"),
    # `\frac{d}{d x}` — models space the differential the way they space
    # everything else, and sympy needs `dx` welded to see a derivative. Only
    # `d` welds: `\partial y` must keep its space or the command runs on.
    (r"\{d\s+([a-zA-Z])\}", r"{d\1}"),
    # and they wrap the operator in a redundant brace group. This has to come
    # after the styling strips: `{\displaystyle\int}` is only `{\int}` by then.
    (r"\{(\\frac\{(?:d|\\partial)\}\{[^{}]*\})\}", r"\1"),
    # the trailing space matters: brace tightening has already removed the one
    # that separated the command from what follows, and `\int` + `x` is `\intx`
    (r"\{\s*(\\(?:iiint|iint|int|oint|sum|prod)(?:[_^](?:\{[^{}]*\}|\S))*)\s*\}", r"\1 "),
    (r"\{\\rm\s+([^{}]*)\}", r"\1"),
    (r"\\(?:text|mathrm|mathit)\{([^{}]*)\}", r"\1"),
]

#: OCR happily returns the real glyph where a human would type a command.
_UNICODE = {
    "\u2212": "-",  # minus sign
    "\u2013": "-",  # en dash
    "\u2014": "-",  # em dash
    "\u00b7": "*",  # middle dot
    "\u00d7": "*",  # multiplication sign
    "\u2044": "/",  # fraction slash — what a rendered ⅕ copies out as
    "\u2215": "/",  # division slash
    "\u00f7": "/",  # division sign
    "\u221e": r"\infty ",
    "\u03c0": r"\pi ",
    "\u2202": r"\partial ",
    "\u222b": r"\int ",
    "\u2211": r"\sum ",
    "\u0393": r"\Gamma ",
    "\u03b8": r"\theta ",
    "\u03b1": r"\alpha ",
    "\u03b2": r"\beta ",
}

#: A differential glued to the integrand: `\int xdx`, `\int 2\pi rdr`. OCR
#: drops the space a human would type, and without it sympy reads `dx` as a
#: product of two symbols and loses the variable of integration.
_GLUED_DIFFERENTIAL = re.compile(r"(?<=[a-zA-Z0-9})])d([a-zA-Z])\s*$")


#: `\sec 3t (…)` — a trig function written without parentheses. sympy hands the
#: whole following product to the function, so `\sec 3t(\sec 3t + \tan 3t)`
#: becomes sec of everything. Bracing the minimal argument restores the
#: intended reading. An exponent on the function itself (`\ln^2(x)`) does not
#: match, because `^` follows the command directly.
_BARE_ARGUMENT = re.compile(
    r"\\(sin|cos|tan|sec|csc|cot|sinh|cosh|tanh|sech|csch|coth|ln|log|exp)"
    r"\s+(\d*\s*(?:[a-zA-Z]|\\[a-zA-Z]+)(?:\^(?:\{[^{}]*\}|\w))?)"
)

#: `\frac{d^2}{dx^2}` — sympy's parser has no rule for it and reads `d`, the
#: variable and the exponents as a product of symbols, so a second derivative
#: is refused rather than taken. Nested first derivatives it does understand,
#: and they collapse to the same `Derivative(f, (x, 2))`.
_HIGHER_ORDER = re.compile(
    r"\\frac\{(d|\\partial)\^\{?(\d+)\}?\}"
    r"\{\1\s*((?:[a-zA-Z]|\\[a-zA-Z]+))\^\{?\2\}?\}"
)

#: What derivative-calculator.net's own order dropdown accepts.
_MAX_ORDER = 5


def _expand_higher_order(latex: str) -> str:
    def repeat(match: re.Match) -> str:
        operator, order, variable = match.group(1), int(match.group(2)), match.group(3)
        if not 2 <= order <= _MAX_ORDER:
            return match.group(0)
        gap = " " if operator == "\\partial" else ""
        return f"\\frac{{{operator}}}{{{operator}{gap}{variable}}}" * order

    return _HIGHER_ORDER.sub(repeat, latex)


#: `)(` is always a product; nothing else can sit between two closed groups.
#: `}(` is *not* — `\frac{d}{dx}(x^2)` is an operator meeting its operand.
_ADJACENT_GROUPS = re.compile(r"\)\s*\(")

#: …but a braced trig argument followed by a group is: `\sec{3t}(\sec{3t}+…)`.
#: The extra braces matter — sympy hands a trig function the whole following
#: product no matter how the argument is delimited, so the application itself
#: has to be closed off before the `\cdot`.
_TRIG_THEN_GROUP = re.compile(
    r"(\\(?:sin|cos|tan|sec|csc|cot|sinh|cosh|tanh|sech|csch|coth|ln|log|exp)"
    r"\{[^{}]*\})\s*\("
)

#: A lone letter immediately before an opening paren. `\sin(` cannot match:
#: the character before the paren is `n`, which the lookbehind rejects.
_IMPLICIT_CALL = re.compile(r"(?<![\\a-zA-Z])([a-zA-Z])\s*\(")


def _make_products_explicit(latex: str) -> str:
    r"""Turn `x(x-8)` into `x \cdot (x-8)` before sympy can read it as a call.

    LaTeX writes multiplication and function application identically and sympy
    guesses "call", so `x(x-8)` arrives as an undefined function. Fixing it
    after parsing is not enough: in `x(\ln x)^9` the exponent belongs to the
    group alone, and by then the tree already says otherwise.

    Only letters that appear more than once are touched. A lone `f` in
    `\int f(x) dx` really may be a function, and turning that into `f \cdot x`
    would answer a different question.
    """

    def replace(match: re.Match) -> str:
        letter = match.group(1)
        elsewhere = re.findall(rf"(?<![\\a-zA-Z]){letter}(?![a-zA-Z])", latex)
        return f"{letter} \\cdot (" if len(elsewhere) > 1 else match.group(0)

    latex = _BARE_ARGUMENT.sub(r"\\\1{\2}", latex)
    latex = _TRIG_THEN_GROUP.sub(r"{\1} \\cdot (", latex)
    return _ADJACENT_GROUPS.sub(r") \\cdot (", _IMPLICIT_CALL.sub(replace, latex))


#: `[f(x)]^2` — square brackets used as grouping, which sympy's parser rejects
#: outright. The one place they mean something else is `\sqrt[3]{x}`, so that
#: gets parked behind a sentinel while the rest are swapped for parens.
_ROOT_INDEX = re.compile(r"\\sqrt\s*\[([^\]]*)\]")


def _brackets_to_parens(latex: str) -> str:
    parked = _ROOT_INDEX.sub(lambda m: f"\\sqrt\x00{m.group(1)}\x01", latex)
    swapped = parked.replace("[", "(").replace("]", ")")
    return swapped.replace("\x00", "[").replace("\x01", "]")


def _strip_wrapping_braces(latex: str) -> str:
    r"""Drop a brace pair that wraps the whole expression: `{\frac{d}{dx}}(x)`."""
    while latex.startswith("{") and latex.endswith("}"):
        depth = 0
        for index, char in enumerate(latex):
            depth += (char == "{") - (char == "}")
            if depth == 0 and index != len(latex) - 1:
                return latex
        latex = latex[1:-1].strip()
    return latex


#: MathJax wrappers that carry styling or an id and take the content as their
#: second argument. integral-calculator hangs them off every step and bound.
_WRAPPERS = ("cssId", "class", "style", "bbox", "texttip", "toggle")

#: The site draws an absent bound as a `?` placeholder. It is not a number.
_PLACEHOLDER_BOUND = re.compile(r"(?:\^|_)\{\?\}")


def _closing(latex: str, opening: int) -> int:
    """Index of the brace matching the one at `opening`, or -1."""
    depth = 0
    for index in range(opening, len(latex)):
        if latex[index] == "{":
            depth += 1
        elif latex[index] == "}":
            depth -= 1
            if depth == 0:
                return index
    return -1


def _unwrap_wrappers(latex: str) -> str:
    """Replace `\cssId{id}{body}` with `body`, brace nesting and all.

    A regex cannot do this: the body routinely contains braces of its own,
    as in `\cssId{int-var-mathjax}{\mathrm{d}x}`.
    """
    for name in _WRAPPERS:
        token = f"\\{name}{{"
        while (start := latex.find(token)) >= 0:
            first = _closing(latex, start + len(token) - 1)
            if first < 0 or first + 1 >= len(latex) or latex[first + 1] != "{":
                break
            second = _closing(latex, first + 1)
            if second < 0:
                break
            latex = latex[:start] + latex[first + 2 : second] + latex[second + 1 :]
    return latex


#: A step lifted out of a worked derivation carries the equals sign that joined
#: it to the line above. There is nothing on the left of it to be equal to.
_LEADING_RELATION = re.compile(r"^\s*[=<>]\s*")


def normalize(latex: str) -> str:
    out = _LEADING_RELATION.sub("", _unwrap_wrappers(latex).strip())
    out = _PLACEHOLDER_BOUND.sub("", out)
    for bad, good in _UNICODE.items():
        out = out.replace(bad, good)
    out = _LOOSE_BRACES.sub(r"\1", out)
    for pattern, repl in _SUBSTITUTIONS:
        out = re.sub(pattern, repl, out)
    out = re.sub(r"\s+", " ", out).strip()
    if "\\int" in out:
        out = _GLUED_DIFFERENTIAL.sub(r" d\1", out)
    out = _expand_higher_order(_brackets_to_parens(out))
    return _strip_wrapping_braces(_make_products_explicit(out))
