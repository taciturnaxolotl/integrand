// ==UserScript==
// @name         WebAssign — bring the entry box back
// @namespace    dunkirk.sh
// @version      2.1.0
// @description  Unsticks answer boxes that never finish rendering, and restores the bracket pairing, Greek commands and hyperbolic autoformat lost when WebAssign moved off MathQuill.
// @match        *://*.webassign.net/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
//
// WebAssign used to run its own MathQuill fork — still on their GitHub, last
// touched December 2015 — and swapped it for MathType (WIRIS; the wrs_ prefixes
// give it away). The replacement kept almost none of the typing.
//
// What MathType does with a keyboard, measured on a live assignment:
//
//     1/2   ->  <mn>1</mn><mo>/</mo><mn>2</mn>     a literal slash
//     x^2   ->  <mi>x</mi><mo>^</mo><mn>2</mn>     a literal caret
//
// No fraction, no superscript. Every template needs a trip to the toolbar, and
// no script can put that back — see below.
//
// What a userscript can reach, also measured:
//
//     toolbar button .click()          works on an empty box
//     execCommand("insertText", …)     works, unicode included
//     execCommand("delete")            does nothing
//     synthetic KeyboardEvents         do nothing
//
// So text can go in, but nothing already typed can be selected or removed —
// which is why `1/` cannot lift the 1 into a numerator the way MathQuill did.
//
// And a harder limit found later: driving the editor from script with content
// already in the box is not safe. Pressing a structural button that way was
// measured emptying the box, and repeated poking left one displaying its own
// MathML source as text — the same class of bug this script exists to fix.
// So this stays on the two operations WebAssign itself performs in production:
// pressing a delimiter button, and inserting text.
//
// Everything below goes through MathType's own toolbar and its own input path,
// so MathType still produces the MathML that gets submitted. Nothing here
// writes answer data, so grading cannot be affected by a formatting difference.

(() => {
  "use strict";

  // ---- boxes that never finished rendering -----------------------------------
  //
  // Each box is hidden while it typesets, by a transient mathtype-rendering
  // class. MathJax 2.7.9 is loaded once per question — 20 times on an
  // 18-question page — and its global hub gets clobbered, so some boxes never
  // get the callback that removes the class. Measured: 3 of 19 stuck on load,
  // 10 of 19 once the page had settled.

  const unstick = document.createElement("style");
  unstick.textContent =
    ".mathtype-wrapper .mathtype-rendering { visibility: visible !important; }";
  document.documentElement.append(unstick);

  // ---- what the toolbar can build --------------------------------------------

  //: Typed character -> toolbar button. Labels are the buttons' own aria-labels.
  //:
  //: Delimiters only, on purpose. `/`, `^` and `_` were here in v2 and are
  //: gone: a structural template inserted from script, with content already in
  //: the box, was measured wiping the box to `<math/>` — worse than the literal
  //: character it replaced. Pairing survives because it is the same operation
  //: WebAssign's own autoformat performs in production, on the same button.
  const TEMPLATES = {
    "|": "Vertical bars",
    "[": "Square brackets",
    "{": "Curly brackets",
    "(": "Parentheses",
  };

  //: \name commands, the way MathQuill took them. A template presses a button;
  //: a symbol is inserted as text, which MathType accepts including non-ASCII.
  //: Symbols only. `\frac` and `\sqrt` would press a structural button, which
  //: is the operation that was seen destroying content; inserting a character
  //: does not touch the tree.
  const COMMANDS = {
    abs: { button: "Vertical bars" },
    infty: { text: "∞" },
    inf: { text: "∞" },
    pi: { text: "π" },
    theta: { text: "θ" },
    alpha: { text: "α" },
    beta: { text: "β" },
    gamma: { text: "γ" },
    delta: { text: "δ" },
    epsilon: { text: "ε" },
    lambda: { text: "λ" },
    mu: { text: "μ" },
    rho: { text: "ρ" },
    sigma: { text: "σ" },
    tau: { text: "τ" },
    phi: { text: "φ" },
    omega: { text: "ω" },
    pm: { text: "±" },
    times: { text: "×" },
    cdot: { text: "·" },
    le: { text: "≤" },
    ge: { text: "≥" },
    ne: { text: "≠" },
    approx: { text: "≈" },
    deg: { text: "°" },
  };

  //: Function names that should gain their own parentheses. WebAssign ships the
  //: first eight and concedes in a comment that the hyperbolics cannot work,
  //: because sin fires before you can type the h.
  const FUNCTIONS = [
    "arcsin", "arccos", "arctan",
    "sinh", "cosh", "tanh", "sech", "csch", "coth",
    "sin", "cos", "tan", "sec", "csc", "cot", "log", "ln",
  ];

  //: The fix is not ordering, it is waiting. A name that is the start of a
  //: longer one holds back to see whether the rest arrives; one with no longer
  //: form fires at once, so log and ln stay instant and sinh works.
  const AMBIGUOUS = new Set(
    FUNCTIONS.filter((name) => FUNCTIONS.some((other) => other !== name && other.startsWith(name)))
  );
  const SETTLE_MS = 140;

  function press(root, label) {
    const scope = root?.closest(".mathtype-wrapper") ?? document;
    const button =
      scope.querySelector(`button[aria-label^="${label}"], button[title^="${label}"]`) ||
      document.querySelector(`button[aria-label^="${label}"], button[title^="${label}"]`);
    // The toolbar answers clicks even while hidden — this is how WebAssign's
    // own autoformat works, so it is the path most likely to keep working.
    button?.click();
    return Boolean(button);
  }

  const type = (text) => document.execCommand("insertText", false, text);

  // ---- the pending command readout ---------------------------------------------
  //
  // Command letters are swallowed rather than inserted, so without this you
  // would be typing into nothing.

  let readout;
  function showCommand(field, text) {
    if (!readout) {
      readout = document.createElement("div");
      readout.style.cssText =
        "position:fixed;z-index:2147483647;padding:2px 7px;border-radius:5px;" +
        "background:#1f2224;color:#f3eee4;font:12px ui-monospace,Menlo,monospace;" +
        "pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.3)";
      document.body.append(readout);
    }
    const box = (field.closest(".mathtype-wrapper") ?? field).getBoundingClientRect();
    readout.textContent = text;
    readout.style.left = `${Math.round(box.left)}px`;
    readout.style.top = `${Math.round(box.bottom + 4)}px`;
    readout.hidden = false;
  }
  const hideCommand = () => readout && (readout.hidden = true);

  // ---- typing -------------------------------------------------------------------

  const state = new WeakMap();
  const ask = (field) => state.get(field) ?? { term: "", command: null, timer: 0 };

  function settleFunction(field, root) {
    const { term } = ask(field);
    if (!FUNCTIONS.some((name) => term.endsWith(name))) return;
    state.set(field, { ...ask(field), term: "" });
    press(root, "Parentheses");
  }

  function runCommand(field, root, name) {
    const command = COMMANDS[name];
    if (!command) return false;
    if (command.button) return press(root, command.button);
    type(command.text);
    return true;
  }

  function onKeyDown(event) {
    const field = event.currentTarget;
    const root = field.closest("[id^=editable-math-], .mathtype-overlay-editor, .mathtype-wrapper");
    const here = ask(field);

    if (event.metaKey || event.ctrlKey || event.altKey) return;

    // --- backslash command mode -------------------------------------------------
    if (here.command !== null) {
      if (event.key === "Escape") {
        state.set(field, { ...here, command: null });
        hideCommand();
        event.preventDefault();
        return;
      }
      if (/^[a-z]$/i.test(event.key)) {
        const command = here.command + event.key.toLowerCase();
        state.set(field, { ...here, command });
        showCommand(field, "\\" + command);
        event.preventDefault();
        return;
      }

      // anything else commits it
      const ran = runCommand(field, root, here.command);
      state.set(field, { ...here, command: null, term: "" });
      hideCommand();
      event.preventDefault();
      // an unknown command types out as it was written, so nothing is lost
      if (!ran) type("\\" + here.command);
      if (event.key === " " || event.key === "Enter") return;
      if (event.key.length === 1) type(event.key);
      return;
    }

    if (event.key === "\\") {
      state.set(field, { ...here, command: "", term: "" });
      showCommand(field, "\\");
      event.preventDefault();
      return;
    }

    // --- templates ---------------------------------------------------------------
    const template = TEMPLATES[event.key];
    if (template && press(root, template)) {
      // The template goes in instead of the bare character, so the closing half
      // comes with it. A fraction or superscript arrives empty: MathType cannot
      // lift the term already typed into it, and nothing a userscript can reach
      // will delete that term to do it by hand.
      event.preventDefault();
      event.stopPropagation();
      state.set(field, { ...here, term: "" });
      return;
    }

    // --- function names ----------------------------------------------------------
    if (!/^[a-z]$/i.test(event.key)) {
      state.set(field, { ...here, term: "" });
      return;
    }

    const term = (here.term + event.key.toLowerCase()).slice(-8);
    clearTimeout(here.timer);
    const timer = FUNCTIONS.some((name) => AMBIGUOUS.has(name) && term.endsWith(name))
      ? setTimeout(() => settleFunction(field, root), SETTLE_MS)
      : 0;
    state.set(field, { ...here, term, timer });
    if (!timer) settleFunction(field, root);
  }

  function adopt(field) {
    if (field.dataset.betterEntry === "on") return;
    field.dataset.betterEntry = "on";
    field.addEventListener("keydown", onKeyDown, true);
    field.addEventListener("blur", hideCommand);
  }

  const fields = () =>
    document.querySelectorAll(".wrs_focusElement, .wrs_focusElementContainer input");

  //: Editors are built lazily, one per box, and the overlay editor is built
  //: again each time it opens — so watch rather than sweep once.
  new MutationObserver(() => fields().forEach(adopt)).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  fields().forEach(adopt);

  // Their handler races ours to insert a second set of parentheses.
  if (Array.isArray(window.mathTypeEditor?.replacements)) {
    window.mathTypeEditor.replacements.length = 0;
  }

  console.log("[better-entry] 2.1 — pairing, \\commands, hyperbolics, unsticking");
})();
