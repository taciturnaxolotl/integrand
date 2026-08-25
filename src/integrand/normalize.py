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

_SUBSTITUTIONS: list[tuple[str, str]] = [
    (r"\\mathop\{\}\s*\\!?\s*\\mathrm\{d\}", "d"),
    (r"\\mathrm\{d\}", "d"),
    (rf"\\(?:mathrm|operatorname|mathop|mathnormal)\{{({_OPERATORS})\}}", r"\\\1"),
    # a single letter in a decorative font is still just a variable
    (r"\\(?:mathcal|mathbb|mathfrak|mathsf|mathbf|boldsymbol)\{([A-Za-z])\}", r"\1"),
    (r"\\(?:dfrac|tfrac)\b", r"\\frac"),
    (r"\\left\.|\\right\.", ""),
    (r"\\left|\\right", ""),
    (r"\\displaystyle\b|\\limits\b|\\nolimits\b", ""),
    (r"\\(?:quad|qquad)\b", " "),
    (r"\\[,;:!]", ""),
    (r"\\ ", " "),
    (r"\\(?:cdot|times|ast)\b", "*"),
    # `\frac{d}{d x}` — models space the differential the way they space
    # everything else, and sympy needs `dx` welded to see a derivative. Only
    # `d` welds: `\partial y` must keep its space or the command runs on.
    (r"\{d\s+([a-zA-Z])\}", r"{d\1}"),
    # and they wrap the operator in a redundant brace group
    (r"\{(\\frac\{(?:d|\\partial)\}\{[^{}]*\})\}", r"\1"),
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


def _strip_wrapping_braces(latex: str) -> str:
    """Drop a brace pair that wraps the whole expression: `{\frac{d}{dx}}(x)`."""
    while latex.startswith("{") and latex.endswith("}"):
        depth = 0
        for index, char in enumerate(latex):
            depth += (char == "{") - (char == "}")
            if depth == 0 and index != len(latex) - 1:
                return latex
        latex = latex[1:-1].strip()
    return latex


def normalize(latex: str) -> str:
    out = latex.strip()
    for bad, good in _UNICODE.items():
        out = out.replace(bad, good)
    for pattern, repl in _SUBSTITUTIONS:
        out = re.sub(pattern, repl, out)
    out = re.sub(r"\s+", " ", out).strip()
    if "\\int" in out:
        out = _GLUED_DIFFERENTIAL.sub(r" d\1", out)
    return _strip_wrapping_braces(out)
