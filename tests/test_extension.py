"""Checks on the extension source that the Python suite can enforce.

The extension has no test runner of its own, and the failure these catch is
invisible until someone looks at the panel: a `//` comment written one line too
early lands inside a template literal and gets painted into the UI as content.
That has happened twice.
"""

import re
import shutil
import subprocess
from pathlib import Path

import pytest

EXTENSION = Path(__file__).resolve().parents[1] / "extension"
SOURCES = sorted(EXTENSION.rglob("*.js"))

#: A backtick that is not escaped. Template literals are the only thing in this
#: codebase that spans lines and swallows whatever is inside it.
BACKTICK = re.compile(r"(?<!\\)`")


def comments_inside_template_literals(source: str) -> list[tuple[int, str]]:
    inside = False
    found = []
    for number, line in enumerate(source.splitlines(), start=1):
        if inside and line.lstrip().startswith("//"):
            found.append((number, line.strip()))
        if len(BACKTICK.findall(line)) % 2:
            inside = not inside
    return found


def test_sources_exist():
    assert SOURCES, "no extension javascript found"


@pytest.mark.parametrize("path", SOURCES, ids=lambda p: p.name)
def test_no_comment_inside_a_template_literal(path):
    stray = comments_inside_template_literals(path.read_text())
    assert not stray, "\n".join(
        f"{path.name}:{n} would render as panel content: {text}" for n, text in stray
    )


@pytest.mark.parametrize("path", SOURCES, ids=lambda p: p.name)
def test_template_literals_are_balanced(path):
    """An odd backtick count means a literal is left open at end of file."""
    assert len(BACKTICK.findall(path.read_text())) % 2 == 0


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
@pytest.mark.parametrize("path", SOURCES, ids=lambda p: p.name)
def test_parses(path):
    """A stray backtick inside a CSS comment closes the template literal early.

    Counting backticks cannot see that — the pair is balanced — so the only
    real check is handing the file to a parser.
    """
    done = subprocess.run(["node", "--check", path], capture_output=True, text=True)
    assert done.returncode == 0, done.stderr


def test_the_check_catches_the_real_shape():
    broken = """
    showPanel(`
      <div class="row"></div>
    // this would be painted into the panel
    `, "note");
    """
    assert comments_inside_template_literals(broken)

    fine = """
    // this one is safe
    showPanel(`
      <div class="row"></div>
    `, "note");
    """
    assert not comments_inside_template_literals(fine)
