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

### Pairing that stopped existing

WebAssign used to run its own MathQuill fork — still on their GitHub, last
touched December 2015 — which paired brackets and absolute-value bars natively.
They have since moved to MathType (WIRIS; the `wrs_` prefixes give it away) and
reimplemented a sliver of the old behaviour in `pads/mathtype/autoformat.js`.
Its entire feature set:

```js
window.mathTypeEditor.replacements = ["sin","cos","tan","sec","csc","cot","log","ln"];
```

Parentheses after eight function names, and nothing else — no bracket pairing,
no absolute value. It works by finding MathType's own toolbar button and
clicking it. Their own comment concedes `sinh`/`cosh`/`tanh` cannot work,
because `sin` fires before you can type the `h`.

### What the script does

Everything goes through MathType's toolbar, the same mechanism WebAssign's own
autoformat uses. **MathType still generates the MathML that gets submitted**, so
nothing here produces answer data and grading cannot be affected by a formatting
difference.

- Unsticks the boxes.
- Pairs `|`, `[`, `{` and `(` — the template goes in instead of the bare
  character, cursor between the halves.
- Fixes the hyperbolics. The bug is not ordering, it is timing: a name that is
  the prefix of a longer one waits 140ms to see whether the rest arrives, and a
  name with no longer form fires immediately. `log` and `ln` stay instant,
  `sinh` works.

### What is deliberately not done

Replacing MathType with a better editor is feasible — the contract is only
`textarea#latex-source-<id>` for the working LaTeX and `input[name=<id>]` for
the submitted value, and the submitted value is presentation MathML:

```xml
<math xmlns="http://www.w3.org/1998/Math/MathML"><mspace/><mn>6</mn><mi>ln</mi><mfenced>…
```

But their MathML uses `<mfenced>`, which is deprecated and which a modern editor
will not emit. If the grader is at all literal about the dialect, correct
answers would be marked wrong with no visible reason. Anyone attempting it
should confirm a full range of answers grade identically on **PRACTICE ANOTHER**
questions first.
