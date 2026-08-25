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

_UNICODE = {
    "\u2212": "-",  # minus sign
    "\u2013": "-",  # en dash
    "\u2014": "-",  # em dash
    "\u00b7": "*",  # middle dot
    "\u00d7": "*",  # multiplication sign
    "\u221e": r"\infty",
    "\u03c0": r"\pi",
}


def normalize(latex: str) -> str:
    out = latex.strip()
    for bad, good in _UNICODE.items():
        out = out.replace(bad, good)
    for pattern, repl in _SUBSTITUTIONS:
        out = re.sub(pattern, repl, out)
    return re.sub(r"\s+", " ", out).strip()
