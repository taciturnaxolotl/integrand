"""Acceptance corpus for the LaTeX -> infix converter.

Every expected string below has been checked by hand against the syntax
integral-calculator.com publishes on its own keypad. Parenthesisation is
deliberately heavy; only correctness is being asserted.
"""

import pytest

from integrand.convert import ConvertError, convert

GOLDEN = [
    # the motivating example
    (r"\int \frac{2x^{2}+7x-1}{x-4}dx", "((2*x^(2) + 7*x) - 1)/(x - 4)"),
    # nested fractions
    (r"\int \frac{\frac{a}{b}}{c} dx", "((a)/(b))/(c)"),
    (r"\int \dfrac{1}{x^2+1} dx", "(1)/(x^(2) + 1)"),
    (r"\int \frac{1}{\sqrt{x}} dx", "(1)/(sqrt(x))"),
    (r"\int \frac{x}{\sqrt{1-x^2}} dx", "(x)/(sqrt(1 - x^(2)))"),
    (r"\int \frac{1}{x \ln(x)} dx", "(1)/(x*ln(x))"),
    (r"\int \frac{1}{1-x^2} dx", "(1)/(1 - x^(2))"),
    # roots
    (r"\int \sqrt[3]{x^2+1} dx", "root(3, x^(2) + 1)"),
    (r"\int \sqrt{x} dx", "sqrt(x)"),
    # exponentials
    (r"\int e^{-x^2} dx", "e^(-x^(2))"),
    (r"\int e^{\frac{1}{x}} dx", "e^((1)/(x))"),
    (r"\int e^x \sin(x) dx", "e^(x)*sin(x)"),
    (r"\int \exp(x) dx", "e^(x)"),
    # the exponent binds to the function, not the argument
    (r"\int \ln^2(x) dx", "(ln(x))^(2)"),
    (r"\int \sin^{2}(x) dx", "(sin(x))^(2)"),
    (r"\int \cos^3(x) dx", "(cos(x))^(3)"),
    # inverse vs power, same LaTeX shape
    (r"\int \sin^{-1}(x) dx", "arcsin(x)"),
    (r"\int \arctan(x) dx", "arctan(x)"),
    (r"\int \sinh^{-1}(x) dx", "arsinh(x)"),
    # logs: the site takes the base first
    (r"\int \log_{10}(x) dx", "log(10, x)"),
    (r"\int \ln(x) dx", "ln(x)"),
    # absolute value, only parseable once \left/\right are gone
    (r"\int \left|x-3\right| dx", "abs(x - 3)"),
    # implicit multiplication
    (r"\int 2\pi r \,dr", "2*pi*r"),
    (r"\int x\sin(x) dx", "x*sin(x)"),
    (r"\int 5x dx", "5*x"),
    (r"\int x \cdot \ln(x) dx", "x*ln(x)"),
    # differential spellings
    (r"\int x \,dx", "x"),
    (r"\int x dx", "x"),
    (r"\int x \mathrm{d}x", "x"),
    (r"\int x \mathop{}\!\mathrm{d}x", "x"),
    # unicode minus from OCR
    (r"\int −x dx", "-x"),
    # grouping
    (r"\int \left(x^2 - 2x\right) dx", "x^(2) - (2*x)"),
    (r"\int \tan(x) dx", "tan(x)"),
    # derivatives
    (r"\frac{d}{dx}(x^2)", "x^(2)"),
    (r"\frac{\partial}{\partial y}(x y^2)", "x*y^(2)"),
    (r"\frac{d}{dx}\left(x\sin(x)\right)", "x*sin(x)"),
]

#: Shapes that only turn up once a real OCR model is in the loop. Kept out of
#: GOLDEN because render_corpus.py compiles that table with LaTeX, and these are
#: outputs rather than inputs.
OCR_SHAPES = [
    # OCR drops the space a human types before the differential
    (r"\int xdx", "x", "x"),
    (r"\int 5xdx", "5*x", "x"),
    (r"\int 2\pi rdr", "2*pi*r", "r"),
    (r"\int \sin(x)dx", "sin(x)", "x"),
    (r"\int \frac{2x^{2}+7x-1}{x-4}dx", "((2*x^(2) + 7*x) - 1)/(x - 4)", "x"),
    # and returns the real glyph where a human types the command
    ("\\frac{∂}{∂y}(xy^{2})", "x*y^(2)", "y"),
    ("∫ x^{2}dx", "x^(2)", "x"),
    ("∫ 2πrdr", "2*pi*r", "r"),
    # pix2tex wraps the operator in a redundant brace group and spaces `d x`
    (r"{\frac{d}{d x}}(x^{2})", "x^(2)", "x"),
    (r"\int{\frac{2x^{2}+7x-1}{x-4}}d x", "((2*x^(2) + 7*x) - 1)/(x - 4)", "x"),
    # and writes operator names as upright text rather than commands
    (r"\int\mathrm{arctan}(x)d x", "arctan(x)", "x"),
    (r"\int\operatorname{ln}(x)dx", "ln(x)", "x"),
    # a decorated single letter is still a variable
    (r"\int\cos^{3}\!\left(\mathcal{A}\right)d\mathcal{A}", "(cos(A))^(3)", "A"),
    # glued products are genuine products, not dropped backslashes
    (r"\int xy\,dx", "x*y", "x"),
]

UNSUPPORTED = [
    (r"\oint x dx", "unsupported_operator"),
    (r"\int\int x dy dx", "unsupported_operator"),
    (r"x^2 + 1", "unsupported_operator"),
    (r"\int \operatorname{abs}(x) dx", "convert_failed"),
    (r"\int \Gamma(x) dx", "convert_failed"),
    (r"\begin{matrix} a & b \\ c & d \end{matrix}", "convert_failed"),
]


@pytest.mark.parametrize("latex,expected", GOLDEN, ids=[c[0] for c in GOLDEN])
def test_golden(latex, expected):
    result = convert(latex)
    assert result.infix == expected
    assert result.verified, "round-trip check failed"


@pytest.mark.parametrize("latex,expected,var", OCR_SHAPES, ids=[c[0] for c in OCR_SHAPES])
def test_ocr_shapes(latex, expected, var):
    """Regressions from running the corpus through a real OCR model."""
    result = convert(latex)
    assert result.infix == expected
    assert result.var == var
    assert result.verified


@pytest.mark.parametrize("latex,code", UNSUPPORTED, ids=[c[0] for c in UNSUPPORTED])
def test_rejected(latex, code):
    with pytest.raises(ConvertError) as excinfo:
        convert(latex)
    assert excinfo.value.code == code


def test_routing():
    assert convert(r"\int x dx").url.startswith("https://www.integral-calculator.com/#expr=")
    assert convert(r"\frac{d}{dx}(x^2)").url.startswith(
        "https://www.derivative-calculator.net/#expr="
    )


def test_definite_bounds_are_deep_linked():
    """expr carries only the integrand; bounds ride along as their own params."""
    result = convert(r"\int_0^\pi \sin(x) dx")
    assert result.bounds == ("0", "pi")
    assert result.infix == "sin(x)"
    assert "expr=sin%28x%29" in result.url
    assert "lbound=0" in result.url and "ubound=pi" in result.url


def test_variable_rides_the_hash():
    assert "intvar=t" in convert(r"\int t^2 dt").url
    assert "diffvar=y" in convert(r"\frac{\partial}{\partial y}(x y^2)").url


def test_plus_survives_encoding():
    """A bare + would become a space if their parser ever hits URLSearchParams."""
    assert "%2B" in convert(r"\int x^2+1 dx").url


def test_variable_is_reported():
    assert convert(r"\int t^2 dt").var == "t"
    assert convert(r"\frac{\partial}{\partial y}(x y^2)").var == "y"
