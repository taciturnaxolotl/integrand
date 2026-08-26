# userscripts

Fixes for the sites integrand reads from. Install with Violentmonkey or
Tampermonkey.

## webassign-better-entry.user.js

WebAssign's answer entry has two problems. Both were diagnosed on a live
assignment; the notes are here because the causes are not guessable from the
symptoms.

### Answer boxes that vanish

Each box is hidden while it typesets, by a transient class:

```css
.mathtype-wrapper .mathtype-rendering { visibility: hidden; }
```

Compare a broken box with a working one — same element, same everything:

```
stuck:   class="mathtype mtClosed mathtype-rendering"
working: class="mathtype mtClosed "          ← note the leftover space
```

So boxes get **stuck wearing the flag**. They are not removed: they are full
size, 120×36, and permanently invisible, which is why the symptom is a gap
where a box should be rather than a missing question.

The cause is further up. **MathJax 2.7.9 is loaded once per question** — 20
times on an 18-question page — along with 19 copies each of `mathtype.js`,
`autoformat.js` and `overlay.js`. 154 script tags for 60 distinct files. MathJax
2.x keeps a global hub and queue; re-initialising it repeatedly drops callbacks
registered against earlier instances, so some boxes never get the callback that
removes the class.

It is a race, and it worsens as the page settles: **3 of 19 stuck on load, 10 of
19 once it had.**

### Typing that stopped existing

WebAssign used to run its own MathQuill fork — still on their GitHub, last
touched December 2015 — which paired brackets and built templates as you typed.
They have since moved to MathType (WIRIS; the `wrs_` prefixes give it away) and
reimplemented a sliver of the old behaviour in `pads/mathtype/autoformat.js`.
Its entire feature set:

```js
window.mathTypeEditor.replacements = ["sin","cos","tan","sec","csc","cot","log","ln"];
```

Parentheses after eight function names, and nothing else. Their own comment
concedes `sinh`/`cosh`/`tanh` cannot work, because `sin` fires before you can
type the `h`.

Measured on a live assignment, typing straight into a box:

```
1/2   ->  <mn>1</mn><mo>/</mo><mn>2</mn>     a literal slash, no <mfrac>
x^2   ->  <mi>x</mi><mo>^</mo><mn>2</mn>     a literal caret, no <msup>
```

Every template needs a trip to the toolbar. That is the whole reason it stopped
feeling like a nice place to type.

### Three layers, and the one that belongs here

**Version 2** clicked toolbar buttons and called `execCommand`:

| | |
|---|---|
| toolbar button `.click()` | works |
| `execCommand("insertText", …)` | works, unicode included |
| `execCommand("delete")` | does nothing |
| synthetic `KeyboardEvent`s | do nothing |

Nothing already typed could be selected or removed, so `1/` could not lift the
`1` into a numerator. Worse, pressing a structural button from script with
content already in the box was measured **emptying it to `<math/>`**.

**Version 3** found the API WebAssign's own save path uses:

```js
const mathML = window.mathTypeEditor[editorType].getMathML();
window.mathTypeEditor[editorType].setMathMLWithCallback(value, resolve);
```

That works, and it is enough to build any structure by hand. But **a write
resets the caret to the end of the expression** — after building `12/□` the next
character landed beside the fraction, not inside it. The workaround was to
intercept every keystroke and place it in the tree directly, which typed
correctly while leaving the visible caret somewhere else entirely. Correct, and
too clever.

**Version 4** uses the editor properly. Underneath both of the above:

```js
editor.action(name)                      // insert a structure at the caret
editor.getEditorModel().setCaret(p, n)   // place the caret, or select n
model.insertText(text)                   // type, unicode included
```

Action names, found by trying them on a live box — the ones that do not exist
fail silently, so they are listed rather than guessed at:

```
fraction  superscript  subscript  squareRoot  nRoot
parenthesis  squareBracket  curlyBracket  verticalBar
```

`superscript` and `subscript` already take the preceding term as their base and
leave the caret in the script, which is exactly what MathQuill's `^` did. `left`
and `caretLeft` do not exist, so caret movement goes through `setCaret`.

`fraction` inserts an empty one rather than wrapping, **unless something is
selected**. So `/` selects the term you just typed and then asks for a fraction.
Two measured rules make that work:

- **`setCaret` takes a position and a length.** A bare `setCaret(3)` throws
  `Cannot read properties of null` and leaves typing dead; `setCaret(3, 2)`
  selects cleanly. It must be wrapped in
  `beginEventTransaction`/`endEventTransaction` **with a try/finally** — a throw
  that skips the release deadlocks the renderer semaphore and freezes the page.
  That is not hypothetical; it froze this one.
- **How far back the term runs is found by asking, not by counting.** The first
  attempt counted caret positions from the MathML and got it wrong: `mfrac`
  gives both slots one position more than their contents while `msup` gives its
  base exactly as many, and an `mfenced` holding several children is a
  comma-separated argument list rather than one group. A model needing a
  special case per node type will be wrong about the next node type.

  So the selection grows one position at a time and `getSelectionMathML()` says
  what is actually selected. It stops on its own at an operator, and **a
  selection that gains no text has escaped into the structure around it** —
  growing past `12` inside a square root returns the whole `√12`, same text,
  which is the signal to stop. Measured:

  ```
  len 1  <mn>2</mn>                        len 2  <mn>12</mn>
  len 3  <msqrt><mn>12</mn></msqrt>        ← same text, escaped: stop at 2
  ```

Given a selection starting at S of length L, the new numerator begins at `S+1`
and the denominator at `S+L+2`. With nothing selected the fraction is empty and
the caret belongs in the numerator instead.

The result is that MathType keeps ownership of the formula *and* the caret. The
script only says what to build and where to look, so the caret is finally in the
same place as your typing — and the in-memory tree, the keystroke interception
and the write queue that version 3 needed are all gone.

### What the script does

- Unsticks the boxes.
- **`/` builds a real fraction**, lifting the term you just typed into the
  numerator and leaving you in the denominator.
- **`^` and `_`** script the preceding term.
- **Pairs** `(`, `[`, `{`, `|`, with the caret inside.
- **`\` commands** with a completion menu: a lone backslash lists everything,
  letters filter it (prefix matches first, so `si` offers `sigma` before
  anything that merely contains those letters), arrows move, Enter/Tab/Space
  accept, Backspace unwinds, Escape cancels. Any other key commits what you
  literally typed, so `\pi+` is not silently turned into the highlighted row.
  Covers `\frac`, `\sqrt`, `\nroot`, `\abs` and the Greek alphabet.
- **Fixes the hyperbolics.** The bug is not ordering, it is timing: a name that
  is the prefix of a longer one waits 140ms to see whether the rest arrives, and
  a name with no longer form fires immediately. `log` and `ln` stay instant,
  `sinh` works.

### Verified on a live box

Typing into an empty, unsubmitted answer box:

```
5+12  /  9      <mfrac><mn>12</mn><mn>9</mn></mfrac>   rendered stacked
then 7          the 9 becomes 97 — the caret really is in the denominator
2(x+1           <mfenced><mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow></mfenced>
x^2             <msup><mi>x</mi><mn>2</mn></msup>
sinh3t          sinh(3t) — the parenthesis arrives on its own
```

And a fraction built inside each kind of structure, which is what the
position-counting version got wrong:

```
inside √12      <msqrt><mfrac><mn>12</mn><mn>3</mn></mfrac></msqrt>
inside √(5+12)  <msqrt><mn>5</mn><mo>+</mo><mfrac><mn>12</mn>…
inside (5+12)   <mfenced><mrow><mn>5</mn><mo>+</mo><mfrac>…
inside x^12     <msup><mi>x</mi><mfrac><mn>12</mn><mn>3</mn></mfrac></msup>
```

**MathType still generates the MathML that gets submitted**, so nothing here
authors answer data and grading cannot be affected by a formatting difference.

### What is deliberately not done

Replacing MathType with a different editor. The contract is only
`textarea#latex-source-<id>` for the working LaTeX and `input[name=<id>]` for
the submitted value, so it is feasible — but their MathML uses `<mfenced>`,
which is deprecated and which a modern editor will not emit. If the grader is at
all literal about the dialect, correct answers would be marked wrong with no
visible reason. Building on their own editor's API avoids that question
entirely: the dialect stays theirs.
