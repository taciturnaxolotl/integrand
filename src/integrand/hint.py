"""Name the technique a problem wants, without solving it.

sympy's `integral_steps` returns a tree of rules describing how it would work
an integral by hand — `PartsRule(u=x, dv=sin(x))`, `URule(u_func=sin(t)+4)`.
That is the wrong shape for prose steps, which is why the steps themselves come
from someone else's site, but it is the right shape for a hint: the answer is
grounded in a decision the CAS actually made, so it cannot be plausible and
wrong the way a generated sentence can.

A hint comes in two parts. "Try a substitution" is a nudge; "u = ln(x)" is the
problem already done. The second is only handed over when it is asked for.

It is not fast — on real homework the worst case measured six seconds — so this
runs after a result is on screen, never in front of it.
"""

from __future__ import annotations

from dataclasses import dataclass

from sympy import Derivative, Integral

from .printer import to_infix

#: Rules that describe bookkeeping rather than a technique. Look past them.
_PASS_THROUGH = ("ConstantTimesRule", "ConstantRule", "DontKnowRule")

#: Deep enough for any real integrand; a guard against a cyclic tree.
_MAX_DEPTH = 8

#: Past this a rewritten form is the answer rather than a nudge toward it.
_MAX_DETAIL = 60


@dataclass
class Hint:
    #: The nudge: "a substitution", "parts", "partial fractions".
    technique: str
    #: The giveaway, revealed only on request: "u = ln(x)".
    detail: str | None = None

    def as_dict(self) -> dict:
        return {"technique": self.technique, "detail": self.detail}


def _show(expr) -> str:
    try:
        return to_infix(expr)
    except Exception:
        return str(expr)


def _describe(rule, depth: int = 0) -> Hint | None:
    if rule is None or depth > _MAX_DEPTH:
        return None
    name = type(rule).__name__

    # Several ways to do it; the first is the one sympy would take.
    if name == "AlternativeRule":
        for option in getattr(rule, "alternatives", []):
            if found := _describe(option, depth + 1):
                return found
        return None

    if name == "URule":
        return Hint("a substitution", f"u = {_show(rule.u_func)}")

    if name == "PartsRule":
        return Hint("integration by parts", f"u = {_show(rule.u)}, dv = {_show(rule.dv)}")

    if name == "PartialFractionsRule":
        return Hint("partial fractions")

    if name == "TrigSubstitutionRule":
        return Hint(
            "a trig substitution", f"{_show(rule.variable)} = {_show(rule.substitution)}"
        )

    if name == "CompleteSquareRule":
        return Hint("completing the square")

    # A rewrite on its own is not a technique. If it leads somewhere, name where
    # it leads and keep the rewritten form for the detail; if it leads to a
    # standard form, the rewrite *is* the work.
    if name == "RewriteRule":
        rewritten = _show(getattr(rule, "rewritten", ""))
        onward = _describe(getattr(rule, "substep", None), depth + 1)
        if onward and onward.technique != _PLAIN:
            return onward
        if rewritten and len(rewritten) <= _MAX_DETAIL:
            return Hint("rewriting it first", rewritten)
        return Hint("rewriting it first")

    if name == "AddRule":
        for step in getattr(rule, "substeps", []):
            found = _describe(step, depth + 1)
            if found and found.technique != _PLAIN:
                return found
        return Hint("splitting it into separate integrals")

    if name in _PASS_THROUGH:
        return _describe(getattr(rule, "substep", None), depth + 1)

    if name.endswith("Rule"):
        return Hint(_PLAIN)
    return None


_PLAIN = "a standard form, no technique needed"


def for_integral(integrand, variable) -> Hint | None:
    from sympy.integrals.manualintegrate import integral_steps

    try:
        return _describe(integral_steps(integrand, variable))
    except Exception:
        return None


def for_derivative(expr, variable) -> Hint | None:
    """Read the rule off the shape. There is no `manualdiff` to ask."""
    from sympy import cos, cosh, exp, log, sin, sinh, tan, tanh

    if expr.is_Add:
        return Hint("differentiating each term separately")
    if expr.is_Mul:
        _, denominator = expr.as_numer_denom()
        if denominator.has(variable):
            return Hint("the quotient rule")
        if len([factor for factor in expr.args if factor.has(variable)]) > 1:
            return Hint("the product rule")
    if expr.is_Pow and expr.base.has(variable) and expr.base != variable:
        return Hint("the chain rule")
    for call in expr.atoms(sin, cos, tan, exp, log, sinh, cosh, tanh):
        inner = call.args[0]
        if inner != variable and inner.has(variable):
            return Hint("the chain rule")
    return None


def describe(expr) -> Hint | None:
    """The technique for a parsed integral or derivative, or None.

    Unwraps the same shapes routing does — `F(x) = \int …`, a constant in
    front — by reaching for the one operator in there.
    """
    operators = expr.atoms(Integral, Derivative)
    if len(operators) == 1:
        expr = operators.pop()
    if isinstance(expr, Integral) and len(expr.limits) == 1:
        return for_integral(expr.function, expr.limits[0][0])
    if isinstance(expr, Derivative) and expr.variables:
        return for_derivative(expr.expr, expr.variables[0])
    return None
