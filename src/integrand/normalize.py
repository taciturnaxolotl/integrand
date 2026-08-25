r"""Lossless cleanup of LaTeX that sympy's parser chokes on.

Order matters. `\left|x-3\right|` only parses once the delimiters are gone,
and `\mathop{}\!\mathrm{d}` has to be recognised before `\!` is stripped.
"""

import re

_SUBSTITUTIONS: list[tuple[str, str]] = [
    (r"\\mathop\{\}\s*\\!?\s*\\mathrm\{d\}", "d"),
    (r"\\mathrm\{d\}", "d"),
    (r"\\operatorname\{([^{}]*)\}", r"\1"),
    (r"\\(?:dfrac|tfrac)\b", r"\\frac"),
    (r"\\left\.|\\right\.", ""),
    (r"\\left|\\right", ""),
    (r"\\displaystyle\b|\\limits\b|\\nolimits\b", ""),
    (r"\\(?:quad|qquad)\b", " "),
    (r"\\[,;:!]", ""),
    (r"\\ ", " "),
    (r"\\(?:cdot|times|ast)\b", "*"),
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


def normalize(latex: str) -> str:
    out = latex.strip()
    for bad, good in _UNICODE.items():
        out = out.replace(bad, good)
    for pattern, repl in _SUBSTITUTIONS:
        out = re.sub(pattern, repl, out)
    out = re.sub(r"\s+", " ", out).strip()
    if "\\int" in out:
        out = _GLUED_DIFFERENTIAL.sub(r" d\1", out)
    return out
