"""Decide whether two expressions are the same function.

`simplify(a - b) == 0` is the right first move and the wrong only move: it
gives up on things like `diff(abs(x - 4))` that are plainly equal but not
structurally reducible. Falling back to agreement at a spread of sample points
catches those without ever calling a wrong conversion correct.
"""

from __future__ import annotations

from sympy import Rational, simplify

#: Deterministic, so a failure reproduces. Spread over both signs, off the
#: integers and off zero, since integrands tend to be singular exactly there.
SAMPLE_POINTS = [
    Rational(n, d)
    for n, d in [
        (1, 7), (3, 5), (7, 3), (11, 4), (17, 6), (23, 5), (29, 7), (31, 3),
        (-1, 7), (-3, 5), (-7, 3), (-11, 4), (-17, 6), (-23, 5), (-29, 7), (-31, 3),
        (43, 9), (53, 8), (-43, 9), (-53, 8),
    ]
]

MIN_AGREEMENTS = 6
TOLERANCE = 1e-9


def agree(left, right, var) -> bool:
    difference = left - right
    try:
        if simplify(difference) == 0:
            return True
    except Exception:
        pass

    agreements = 0
    for point in SAMPLE_POINTS:
        try:
            residual = complex(difference.subs(var, point).evalf())
            scale = abs(complex(left.subs(var, point).evalf()))
        except (TypeError, ValueError, ZeroDivisionError):
            continue
        if residual != residual or abs(residual) == float("inf"):
            continue  # singular here; the point tells us nothing
        if abs(residual) > TOLERANCE * max(1.0, scale):
            return False
        agreements += 1

    return agreements >= MIN_AGREEMENTS
