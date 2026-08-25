"""Print a sympy expression in the infix syntax integral-calculator.com accepts.

The function names below are lifted from the site's own keypad (`data-input`
attributes on integral-calculator.com), not guessed. Anything outside that set
raises rather than emitting a name their parser would silently misread.

Readability is not a goal here; correctness is. When in doubt, parenthesise.
"""

from sympy import Add, E, Mul, Pow, Rational, S, fraction
from sympy.printing.str import StrPrinter

_COMPOUND = (Add, Mul)

#: sympy function name -> the site's spelling.
FUNCTIONS = {
    "sin": "sin", "cos": "cos", "tan": "tan",
    "sec": "sec", "csc": "csc", "cot": "cot",
    "asin": "arcsin", "acos": "arccos", "atan": "arctan",
    "asec": "arcsec", "acsc": "arccsc", "acot": "arccot",
    "sinh": "sinh", "cosh": "cosh", "tanh": "tanh",
    "sech": "sech", "csch": "csch", "coth": "coth",
    # inverse hyperbolics drop the "c": arsinh, not arcsinh
    "asinh": "arsinh", "acosh": "arcosh", "atanh": "artanh",
    "asech": "arsech", "acsch": "arcsch", "acoth": "arcoth",
    "erf": "erf", "erfc": "erfc", "erfi": "erfi",
    "gamma": "gamma_function", "beta": "beta_function",
    "polygamma": "psi_function", "LambertW": "lambert_w",
    "Si": "expintegral_si", "Ci": "expintegral_ci",
    "Ei": "expintegral_ei", "li": "expintegral_li",
    "Shi": "expintegral_shi", "Chi": "expintegral_chi",
    "fresnels": "fresnel_s", "fresnelc": "fresnel_c",
}


class UnsupportedFunction(Exception):
    """Raised for a function the site has no spelling for."""


class InfixPrinter(StrPrinter):
    def _wrap(self, expr) -> str:
        printed = self._print(expr)
        return f"({printed})" if isinstance(expr, _COMPOUND) else printed

    def _print_Mul(self, expr):
        num, den = fraction(expr)
        if den is not S.One:
            return f"({self._print(num)})/({self._print(den)})"

        args = list(Mul.make_args(expr))
        sign = ""
        if args and args[0] is S.NegativeOne:
            sign, args = "-", args[1:]
            if not args:
                return "-1"
        return sign + "*".join(self._wrap(a) for a in args)

    def _print_Pow(self, expr):
        base, exp = expr.as_base_exp()

        if exp.is_Rational and exp.is_negative:
            return f"(1)/({self._print(Pow(base, -exp))})"
        if exp == Rational(1, 2):
            return f"sqrt({self._print(base)})"
        if isinstance(exp, Rational) and exp.p == 1:
            return f"root({exp.q}, {self._print(base)})"

        printed_base = "e" if base is E else self._print(base)
        if not base.is_Symbol and not base.is_Number:
            printed_base = "e" if base is E else f"({self._print(base)})"
        return f"{printed_base}^({self._print(exp)})"

    def _print_Rational(self, expr):
        return str(expr.p) if expr.q == 1 else f"({expr.p})/({expr.q})"

    def _print_Half(self, expr):
        return "(1)/(2)"

    def _print_exp(self, expr):
        return f"e^({self._print(expr.args[0])})"

    def _print_log(self, expr):
        arg = self._print(expr.args[0])
        if len(expr.args) == 1 or expr.args[1] is E:
            return f"ln({arg})"
        return f"log({self._print(expr.args[1])}, {arg})"

    def _print_Abs(self, expr):
        return f"abs({self._print(expr.args[0])})"

    def _print_Exp1(self, expr):
        return "e"

    def _print_Pi(self, expr):
        return "pi"

    def _print_ImaginaryUnit(self, expr):
        return "i"

    def _print_Infinity(self, expr):
        return "infinity"

    def _print_NegativeInfinity(self, expr):
        return "-infinity"

    def _print_Function(self, expr):
        name = expr.func.__name__
        if name not in FUNCTIONS:
            raise UnsupportedFunction(name)
        args = ", ".join(self._print(a) for a in expr.args)
        return f"{FUNCTIONS[name]}({args})"


def to_infix(expr) -> str:
    return InfixPrinter().doprint(expr)
