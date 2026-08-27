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

### Answers erased on the way out

Blank boxes are not, mostly, a rendering fault. **The stored answer is erased,
and the blank box is that erasure drawn faithfully.**

One editor instance is shared by every box of a type. Closing a box resets it to
a sentinel meaning "not holding anything" (`overlay.js:1037`):

```js
MATHTYPE_DEFAULT = '<math xmlns="http://www.w3.org/1998/Math/MathML"/>'
setMathTypeValue(editorType, window.mathTypeEditor.MATHTYPE_DEFAULT, resolve);
```

`syncAnswerValue` writes the answer field from whatever the live editor reports,
and reads that sentinel as an empty answer:

```js
return liveMathML && liveMathML !== MATHTYPE_DEFAULT ? liveMathML : "";
...
if (mathML) answerField.value = mathML; else answerField.value = "";
```

So a sync landing between the reset and the box losing ownership wipes the
answer. The close button syncs on **both `focus` and `pointerdown`**, which is
exactly when the reset is running — the two are racing over one shared editor.

There is a second, worse turn. The field is written *before*
`warnInvalidMathTypeCharacters` runs, and that throws when a box lacks its
warning element. Measured on a live page:

```
without guard:  ERASED (and threw: Cannot set properties of null …)
with guard:     PRESERVED
```

The throw leaves the answer erased *and* abandons the rest of the close.

**Why correcting it is safe.** A box the student really emptied reads back
`<math><mspace/></math>` — neither falsy nor the sentinel — so it is stored
normally. An answer field that held something and is empty immediately after a
sync has therefore always come through the sentinel path, and keeping what was
there is always right. The script wraps `window.mathTypeOverlay.syncAnswerValue`
in a `try`/`finally` that restores the previous value in that one case, so it
holds even when the sync throws.

### Answers drawn too small to see, and why that is not fixed here

A closed box is not the editor's rendering. It holds the raw MathML, drawn
natively by the browser, and it inherits the page's 13px. At that size the bar
over a square root is thinner than a pixel and is never painted — the surd
appears and the bar does not, which reads as a browser rendering bug.

The same markup at four sizes says otherwise:

```
13px   surd drawn, bar invisible
20px   bar faint but present
32px   flawless
48px   flawless
```

So nothing is wrong with the markup, the font, or MathML support. It is only too
small, and `.mathtype .mtAnswer math { font-size: 1.45em }` restores the bar.

**It is not shipped.** That rule resizes every answer on the page, and with it in
place boxes appeared to blank more often. A missing hairline is a cosmetic
complaint; a blank answer is not, so the trade is the wrong way round. It is
worth revisiting once the rendering is stable enough to attribute a blank box to
one cause with confidence.

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
  what is actually selected. It stops on its own at an operator, and **text is
  the test for everything else**: a probe that gains some has taken more of the
  term, one that gains none has escaped into the structure around it. Growing
  past `12` inside a square root returns the whole `√12`, same text, and the
  root is not part of the term. Measured:

  ```
  len 1  <mn>2</mn>                        len 2  <mn>12</mn>
  len 3  <msqrt><mn>12</mn></msqrt>        ← same text, escaped: keep 2
  ```

  A probe that gains nothing is skipped rather than final, which is what lets
  `x^2/` work. Measured on a live box, caret sitting after the `2`:

  ```
  len 1  <mn>2</mn>
  len 2  <msup><mrow/><mn>2</mn></msup>     ← same text, and where it used to stop
  len 3  <msup><mi>x</mi><mn>2</mn></msup>  ← gains the base: take it
  ```

  The first position past the exponent is the empty base — a boundary, not an
  answer — and stopping there is what built the fraction *inside* the exponent.
  One position further is the whole power, so it **lifts into the numerator**.
  An operator still stops the search outright; that is a different answer from
  a range the editor would not give, and the two are kept apart.

- **Where the denominator is, also by asking.** `S + L + 2` held only for a flat
  run of characters. A numerator holding a structure takes one position more
  than the selection it was made from — measured, `x^2` selects as 3 and sits in
  the numerator as 4 — so the arithmetic put the caret back in the numerator and
  the next digit landed beside the power.

  The empty slot is the signal. Growing a selection from the top of the
  numerator reaches the whole fraction eventually, and the fraction's own
  denominator is still empty at that moment, so the last selection with nothing
  empty in it is the numerator:

  ```
  len 4  <msup><mi>x</mi><mn>2</mn></msup>              ← still the numerator
  len 5  <mfrac><msup>…</msup><mrow/></mfrac>           ← empty slot: stop at 4
  ```

Given a selection starting at S of length L, the new numerator begins at `S+1`
and the denominator at `S+L+2`. With nothing selected the fraction is empty and
the caret belongs in the numerator instead.

The result is that MathType keeps ownership of the formula *and* the caret. The
script only says what to build and where to look, so the caret is finally in the
same place as your typing — and the in-memory tree, the keystroke interception
and the write queue that version 3 needed are all gone.

### What the script does

- Unsticks the boxes, and stops the close race erasing answers.
- **`/` builds a real fraction**, lifting the term you just typed into the
  numerator and leaving you in the denominator.
- **`^` and `_`** script the preceding term.
- **Pairs** `(`, `[`, `{`, `|`, with the caret inside.
- **Deleting by term and by line.** <kbd>⌥⌫</kbd> takes the stretch `/` would
  have lifted — `2sin(x)` in one press, and a `+` stops it — and <kbd>⌘⌫</kbd>
  takes everything to the left of the caret, leaving anything after it. Away
  from a Mac, <kbd>ctrl+⌫</kbd> and <kbd>ctrl+shift+⌫</kbd>; no platform
  sniffing, since neither combination means anything on the other. MathType
  binds none of them, so all four used to delete a single character. A press
  with nothing to take is left to the editor rather than swallowed, and plain
  <kbd>⌫</kbd> is untouched.
- **`\` commands** with a completion menu: a lone backslash lists everything,
  letters filter it (prefix matches first, so `si` offers `sigma` before
  anything that merely contains those letters), arrows move, Enter/Tab/Space
  accept, Backspace unwinds, Escape cancels. Any other key commits what you
  literally typed, so `\pi+` is not silently turned into the highlighted row.
  Covers `\frac`, `\sqrt`, `\nroot`, `\abs` and the Greek alphabet.
- **Fixes the hyperbolics.** The bug is not ordering, it is timing: a name that
  is the prefix of a longer one waits 140ms to see whether the rest arrives, so
  `sinh` works.

- **And waits for the editor, not the clock.** Every name has a second wait
  under it, added in 4.6. MathType applies typed characters on its own
  schedule and has not applied the one that completed the name by the time the
  key is handled — measured on a live box, the model still read `<math/>` for
  *both* letters of `ln` at the moment the parentheses went in:

  ```
  keydown l   model: <math/>
  keydown n   model: <math/>
  settle      model: <math/>       ← parentheses opened here
  result      <mi>l</mi><mfenced><mi>n</mi></mfenced>      l(n)
  ```

  So the `n` was typed inside parentheses that had opened where it was going to
  land. WebAssign's own version avoided this by running on `keyup`; this one
  polls the model until the name is really there, then opens the parentheses.
  If the typist has run past the name by then, it leaves the formula alone.
  Missing parentheses cost a keystroke; late ones wrap the wrong thing.

### Verified on a live box

Typing into an empty, unsubmitted answer box:

```
5+12  /  9      <mfrac><mn>12</mn><mn>9</mn></mfrac>   rendered stacked
then 7          the 9 becomes 97 — the caret really is in the denominator
2(x+1           <mfenced><mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow></mfenced>
x^2             <msup><mi>x</mi><mn>2</mn></msup>
sinh3t          sinh(3t) — the parenthesis arrives on its own
```

Re-measured in 4.6, driving the shipped handler with real keystrokes:

```
ln     <mi>ln</mi><mfenced><mrow/></mfenced>        was: l(n)
lnx    <mi>ln</mi><mfenced><mi>x</mi></mfenced>     ln(x)
sin    <mi>sin</mi><mfenced><mrow/></mfenced>
sinh   <mi>sinh</mi><mfenced><mrow/></mfenced>      still waits for the h
2log   <mn>2</mn><mi>log</mi><mfenced><mrow/></mfenced>
```

And the deletions, real keystrokes into the live editor:

```
2sin      ⌥⌫    empty            the whole term
5+12      ctrl+⌫  <mn>5</mn><mo>+</mo>    the operator stops it
5+12      ⌘⌫    empty
12+34     ⌘⌫ with the caret after the +   <mn>34</mn>   the tail stays
123       ⌫     <mn>12</mn>      MathType's own, untouched
```

And a fraction built inside each kind of structure, which is what the
position-counting version got wrong:

```
inside √12      <msqrt><mfrac><mn>12</mn><mn>3</mn></mfrac></msqrt>
inside √(5+12)  <msqrt><mn>5</mn><mo>+</mo><mfrac><mn>12</mn>…
inside (5+12)   <mfenced><mrow><mn>5</mn><mo>+</mo><mfrac>…
inside x^12     <msup><mi>x</mi><mfrac><mn>12</mn><mn>3</mn></mfrac></msup>
```

Since 4.6 the last of those is deliberately no longer the case: a `/` typed
straight after `x^2` takes the whole power as the numerator, because that is
what it looks like it should do. A fraction *inside* an exponent is built with
`\frac`. Re-measured on the same live editor, driving the shipped functions:

```
x^2/9     <mfrac><msup><mi>x</mi><mn>2</mn></msup><mn>9</mn></mfrac>
x^12/97   <mfrac><msup><mi>x</mi><mn>12</mn></msup><mn>97</mn></mfrac>
x_2/9     <mfrac><msub><mi>x</mi><mn>2</mn></msub><mn>9</mn></mfrac>
1/2/3     <mfrac><mfrac><mn>1</mn><mn>2</mn></mfrac><mn>3</mn></mfrac>
5+12/97   <mn>5</mn><mo>+</mo><mfrac><mn>12</mn><mn>97</mn></mfrac>
inside √12  <msqrt><mfrac><mn>12</mn><mn>9</mn></mfrac></msqrt>   unchanged
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
