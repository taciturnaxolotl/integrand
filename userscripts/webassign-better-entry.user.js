// ==UserScript==
// @name         WebAssign — bring the entry box back
// @namespace    dunkirk.sh
// @version      1.0.0
// @description  Unsticks answer boxes that never finish rendering, and puts back
//               the bracket pairing that was lost when WebAssign moved from its
//               own MathQuill fork to MathType.
// @match        *://*.webassign.net/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
//
// Two problems, two fixes.
//
// 1. WebAssign hides each answer box while it typesets, with a transient
//    `mathtype-rendering` class. MathJax 2.7.9 is loaded once per question — 20
//    times on an 18-question page — and its global hub gets clobbered, so some
//    boxes never get the callback that removes the class and stay
//    visibility:hidden forever. Measured: 3 of 19 stuck on load, 10 of 19 once
//    the page settled.
//
// 2. The old editor paired brackets and absolute-value bars as you typed. The
//    replacement, `pads/mathtype/autoformat.js`, only inserts parentheses after
//    eight function names, by finding MathType's own toolbar button and
//    clicking it. Their comment concedes sinh/cosh/tanh cannot work, because
//    `sin` fires before you can type the `h`.
//
// Everything here drives MathType through that same toolbar, so MathType still
// produces the MathML that gets submitted. Nothing touches the answer itself.

(() => {
  "use strict";

  // ---- 1. boxes that never finished rendering --------------------------------

  const unstick = document.createElement("style");
  unstick.textContent =
    ".mathtype-wrapper .mathtype-rendering { visibility: visible !important; }";
  document.documentElement.append(unstick);

  // ---- 2. pairing --------------------------------------------------------------

  //: Typed character -> the MathType toolbar button that inserts the pair.
  //: Labels come from the toolbar's own aria-labels.
  const PAIRS = {
    "|": "Vertical bars",
    "[": "Square brackets",
    "{": "Curly brackets",
    "(": "Parentheses",
  };

  //: Function names that should gain their own parentheses. WebAssign ships the
  //: first eight; the hyperbolics are the ones their ordering bug excluded.
  const FUNCTIONS = [
    "arcsin", "arccos", "arctan",
    "sinh", "cosh", "tanh", "sech", "csch", "coth",
    "sin", "cos", "tan", "sec", "csc", "cot", "log", "ln",
  ];

  //: A name that is the start of a longer one has to wait to see whether the
  //: rest arrives — this is the whole reason `sin` breaks `sinh`. Names with no
  //: longer form fire immediately, so the common case stays instant.
  const AMBIGUOUS = new Set(
    FUNCTIONS.filter((name) => FUNCTIONS.some((other) => other !== name && other.startsWith(name)))
  );
  const SETTLE_MS = 140;

  const editorOf = (node) => node.closest?.("[id^=editable-math-], .mathtype-overlay-editor");

  function toolbarButton(root, label) {
    const scope = root?.closest(".mathtype-wrapper") ?? document;
    return (
      scope.querySelector(`button[aria-label="${label}"], button[title="${label}"]`) ||
      document.querySelector(`button[aria-label="${label}"], button[title="${label}"]`)
    );
  }

  // The toolbar responds to clicks even while hidden — this is how WebAssign's
  // own autoformat works, so it is the mechanism most likely to keep working.
  function press(root, label) {
    const button = toolbarButton(root, label);
    if (button) button.click();
    return Boolean(button);
  }

  const buffers = new WeakMap();
  const timers = new WeakMap();

  function considerFunction(field, root) {
    const buffer = buffers.get(field) ?? "";
    const match = FUNCTIONS.find((name) => buffer.endsWith(name));
    if (!match) return;
    buffers.set(field, "");
    press(root, "Parentheses");
  }

  function onKeyDown(event) {
    const field = event.currentTarget;
    const root = editorOf(field) ?? field.closest(".mathtype-wrapper");

    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const pair = PAIRS[event.key];
    if (pair) {
      // Let the pair template in instead of the bare character, so the closing
      // half comes with it and the cursor lands between them.
      if (press(root, pair)) {
        event.preventDefault();
        event.stopPropagation();
        buffers.set(field, "");
      }
      return;
    }

    if (!/^[a-z]$/i.test(event.key)) {
      buffers.set(field, "");
      return;
    }

    const buffer = (buffers.get(field) ?? "") + event.key.toLowerCase();
    buffers.set(field, buffer.slice(-8));

    clearTimeout(timers.get(field));
    const couldGrow = FUNCTIONS.some(
      (name) => AMBIGUOUS.has(name) && buffer.endsWith(name)
    );
    if (couldGrow) {
      timers.set(field, setTimeout(() => considerFunction(field, root), SETTLE_MS));
    } else {
      considerFunction(field, root);
    }
  }

  function adopt(field) {
    if (field.dataset.betterEntry === "on") return;
    field.dataset.betterEntry = "on";
    field.addEventListener("keydown", onKeyDown, true);
  }

  //: Editors are built lazily, one per box, and the overlay editor is built
  //: again on open — so watch rather than sweep once.
  const watch = new MutationObserver(() => {
    document
      .querySelectorAll(".wrs_focusElement, .wrs_focusElementContainer input")
      .forEach(adopt);
  });
  watch.observe(document.documentElement, { childList: true, subtree: true });

  document
    .querySelectorAll(".wrs_focusElement, .wrs_focusElementContainer input")
    .forEach(adopt);

  // WebAssign's own list is a mutable global; leaving the hyperbolics out of it
  // stops their handler racing ours to insert a second set of parentheses.
  if (Array.isArray(window.mathTypeEditor?.replacements)) {
    window.mathTypeEditor.replacements.length = 0;
  }

  console.log("[better-entry] pairing and unsticking active");
})();
