// ==UserScript==
// @name         WebAssign nice entry
// @author       Kieran Klukas
// @namespace    dunkirk.sh
// @version      4.5.0
// @description  Restores MathQuill-style typing to WebAssign's MathType boxes.
// @match        *://*.webassign.net/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
	"use strict";

	// ---- boxes that never finished rendering -----------------------------------
	//
	// Each box is hidden while it typesets, by a transient mathtype-rendering
	// class. MathJax 2.7.9 is loaded once per question — 20 times on an
	// 18-question page — and its global hub gets clobbered, so some boxes never
	// get the callback that removes the class. Measured: 3 of 19 stuck on load,
	// 10 of 19 once the page had settled.

	// Answers are also drawn too small to be correct — a closed box holds raw
	// MathML at the page's 13px, and at 13px the bar over a square root is
	// thinner than a pixel and never gets painted. Enlarging it fixes the bar
	// (measured at 13, 20, 32 and 48) but it resizes every box on the page, and
	// that appeared to make boxes blank more often. Left out until the rendering
	// is stable enough to tell the two apart.

	const fixes = document.createElement("style");
	fixes.textContent =
		".mathtype-wrapper .mathtype-rendering { visibility: visible !important; }";
	document.documentElement.append(fixes);

	// ---- answers erased on the way out -------------------------------------------
	//
	// Boxes going blank is not a rendering fault. The answer is erased, and the
	// blank box is that erasure drawn faithfully.
	//
	// One editor instance is shared by every box of a type, so closing a box
	// resets it to a sentinel meaning "not holding anything":
	//
	//     MATHTYPE_DEFAULT = '<math xmlns="http://www.w3.org/1998/Math/MathML"/>'
	//
	// syncAnswerValue writes the answer field from whatever the live editor
	// reports, and reads that sentinel as an empty answer:
	//
	//     return liveMathML && liveMathML !== MATHTYPE_DEFAULT ? liveMathML : "";
	//     ...
	//     if (mathML) answerField.value = mathML; else answerField.value = "";
	//
	// A sync landing between the reset and the box losing ownership therefore
	// wipes the stored answer. The close button syncs on both focus and
	// pointerdown, which is exactly when the reset is running.
	//
	// The distinction that makes this safe to correct: a box the student really
	// emptied reads back `<math><mspace/></math>`, which is neither falsy nor the
	// sentinel, so it is stored normally. An answer field that held something and
	// is empty right after a sync has therefore always come through the sentinel
	// path, and keeping what was there is always right.

	function guardAgainstErasure() {
		const overlay = window.mathTypeOverlay;
		if (!overlay || typeof overlay.syncAnswerValue !== "function") return;
		if (overlay.syncAnswerValue.guarded) return;

		const original = overlay.syncAnswerValue;
		//: try/finally, not a plain return. The field is written before
		//: warnInvalidMathTypeCharacters runs, and that throws if a box is missing
		//: its warning element — leaving the answer erased and the rest of the
		//: close abandoned. Restoring has to happen on the way out either way.
		const guarded = function (boxId) {
			const field = document.getElementById(boxId);
			const before = field ? field.value : "";
			let result;
			try {
				result = original.apply(this, arguments);
			} finally {
				if (field && before && !field.value) {
					field.value = before;
					console.warn(
						"[better-entry] kept an answer the editor had stopped holding:",
						boxId,
					);
					result = before;
				}
			}
			return result;
		};
		guarded.guarded = true;
		overlay.syncAnswerValue = guarded;
		console.log("[better-entry] guarding answers against the close race");
	}

	// ---- reaching the editor -------------------------------------------------------

	//: There are several editors on the page and dataset.type names which one a
	//: box is bound to. Ask the field being typed into first; the open-state class
	//: is a guess about someone else's markup, so it is only the fallback.
	let focused = null;

	function editor() {
		const box =
			focused
				?.closest?.(".mathtype-wrapper")
				?.querySelector("[id^=editable-math-]") ??
			document.querySelector(".mathtype.mtOpen");
		const found =
			box?.dataset?.type && window.mathTypeEditor?.[box.dataset.type];
		return typeof found?.action === "function" ? found : null;
	}

	//: Every model call is best-effort. A wedged editor should cost one keystroke,
	//: not put the script into a state it cannot type its way out of.
	function withModel(work) {
		const found = editor();
		if (!found) return false;
		try {
			return work(found, found.getEditorModel()) ?? true;
		} catch (error) {
			console.warn("[better-entry] editor refused:", error.message);
			return false;
		}
	}

	//: The try/finally is not decoration. A throw between begin and end never
	//: releases the transaction semaphore, and the renderer stops for good.
	function setCaret(model, position, length) {
		model.beginEventTransaction();
		try {
			model.setCaret(position, length);
		} finally {
			model.endEventTransaction();
		}
	}

	// ---- counting caret positions --------------------------------------------------

	//: A trailing term runs back to the first binary operator — the same stretch
	//: MathQuill lifted into a numerator when you pressed `/`.
	const BREAKS = new Set([
		"+",
		"-",
		"−",
		"=",
		"<",
		">",
		"±",
		"×",
		"·",
		",",
		"/",
		"≤",
		"≥",
		"≠",
	]);

	//: Long enough for any real term, short enough that a confused editor cannot
	//: turn one keystroke into an unbounded loop.
	const MAX_TERM = 40;

	//: The text of a selection, or null if the selection has run past the term:
	//: into an operator, or off the front of the formula.
	function settled(selection) {
		const doc = new DOMParser().parseFromString(selection || "", "text/xml");
		if (doc.querySelector("parsererror")) return null;
		for (const node of doc.documentElement.childNodes) {
			if (node.nodeName === "mspace") return null;
			if (node.nodeName === "mo" && BREAKS.has(node.textContent.trim()))
				return null;
		}
		return doc.documentElement.textContent;
	}

	//: How much sits behind the caret, found by asking rather than by arithmetic.
	//:
	//: Version 4.2 counted caret positions from the MathML, and the counting was
	//: wrong: mfrac gives both slots one position more than their contents while
	//: msup gives its base exactly as many, and an mfenced holding several
	//: children is a comma-separated argument list rather than one group. A model
	//: that has to special-case every node type is a model that will be wrong
	//: about the next one.
	//:
	//: So grow the selection a position at a time and read back what MathType
	//: says is selected. It stops on its own at an operator, and a selection that
	//: gains no text has escaped into the structure around it — `12` inside a
	//: square root becomes the whole `√12` rather than anything longer.
	//: One transaction around the whole search, not one per probe. Each
	//: begin/end pair is a repaint, and a term of any length was costing a
	//: repaint per position — a single keystroke could redraw the formula dozens
	//: of times, which looked exactly like the editor rendering it wrong.
	function termLength(model, caret) {
		let best = 0;
		let seen = "";
		model.beginEventTransaction();
		try {
			for (
				let length = 1;
				length <= MAX_TERM && caret - length >= 0;
				length++
			) {
				let text;
				try {
					model.setCaret(caret - length, length);
					text = settled(model.getSelectionMathML());
				} catch {
					break;
				}
				if (text === null || text.length <= seen.length) break;
				seen = text;
				best = length;
			}
		} finally {
			model.endEventTransaction();
		}
		return best;
	}

	// ---- what the keys build -------------------------------------------------------

	//: Typed character -> MathType's own action name.
	const ACTIONS = {
		"^": "superscript",
		_: "subscript",
		"(": "parenthesis",
		"[": "squareBracket",
		"{": "curlyBracket",
		"|": "verticalBar",
	};

	//: An action leaves the model's caret in the right slot, but real keystrokes
	//: do not follow it until it is written back. Without this, typing after
	//: `\sqrt` lands beside the root instead of under it — and the next `/` then
	//: wraps the root itself, which is what "it messes stuff up" looked like.
	const insert = (name) =>
		withModel((found, model) => {
			found.action(name);
			setCaret(model, model.getCaret(), 0);
		});

	//: The one key MathType has no ready answer for. Everything else is a single
	//: action call; this has to select first, because an unselected `fraction`
	//: inserts an empty one beside the term instead of around it.
	function fraction() {
		return withModel((found, model) => {
			const caret = model.getCaret();
			const span = termLength(model, caret);
			const start = caret - span;
			// termLength leaves a selection behind; put it back if it found nothing.
			setCaret(model, start, span);
			found.action("fraction");
			// Nothing to lift means an empty fraction, and the numerator is where you
			// would expect to be typing.
			setCaret(model, span > 0 ? start + span + 2 : start + 1, 0);
		});
	}

	const typeText = (text) =>
		withModel((found, model) => model.insertText(text));

	//: \name commands, the way MathQuill took them.
	const COMMANDS = {
		frac: { fraction: true },
		sqrt: { action: "squareRoot" },
		nroot: { action: "nRoot" },
		abs: { action: "verticalBar" },
		infty: "∞",
		inf: "∞",
		pi: "π",
		theta: "θ",
		alpha: "α",
		beta: "β",
		gamma: "γ",
		delta: "δ",
		epsilon: "ε",
		lambda: "λ",
		mu: "μ",
		rho: "ρ",
		sigma: "σ",
		tau: "τ",
		phi: "φ",
		omega: "ω",
		pm: "±",
		times: "×",
		cdot: "·",
		le: "≤",
		ge: "≥",
		ne: "≠",
		approx: "≈",
		deg: "°",
	};

	function runCommand(name) {
		const command = COMMANDS[name];
		if (!command) return false;
		if (typeof command === "string") return typeText(command);
		return command.fraction ? fraction() : insert(command.action);
	}

	//: Function names that should gain their own parentheses. WebAssign ships the
	//: first eight and concedes in a comment that the hyperbolics cannot work,
	//: because sin fires before you can type the h.
	const FUNCTIONS = [
		"arcsin",
		"arccos",
		"arctan",
		"sinh",
		"cosh",
		"tanh",
		"sech",
		"csch",
		"coth",
		"sin",
		"cos",
		"tan",
		"sec",
		"csc",
		"cot",
		"log",
		"ln",
	];

	//: The fix is not ordering, it is waiting. A name that is the start of a
	//: longer one holds back to see whether the rest arrives; one with no longer
	//: form fires at once, so log and ln stay instant and sinh works.
	const AMBIGUOUS = new Set(
		FUNCTIONS.filter((name) =>
			FUNCTIONS.some((other) => other !== name && other.startsWith(name)),
		),
	);
	const SETTLE_MS = 140;

	// ---- the command menu ----------------------------------------------------------

	//: The command list is the discoverable part. A lone backslash with nothing
	//: after it shows everything there is, which is how you find out that a
	//: not-equals command exists without being told.
	const COMMAND_NAMES = Object.keys(COMMANDS).sort();
	const MENU_ROWS = 7;

	function preview(name) {
		const command = COMMANDS[name];
		if (typeof command === "string") return command;
		return (
			{ squareRoot: "√", nRoot: "ⁿ√", verticalBar: "| |" }[command.action] ||
			"a⁄b"
		);
	}

	//: The letters you type are swallowed rather than inserted, so they have to
	//: show up somewhere. Lighting them up inside each candidate says what you
	//: typed and what it matched at the same time, which a line repeating the
	//: query back at you does not.
	function highlighted(name, query) {
		const text = "\\" + name;
		const fragment = document.createDocumentFragment();
		const at = query ? name.indexOf(query) + 1 : -1;
		if (at < 1) {
			fragment.append(text);
			return fragment;
		}
		const dim = (content) => {
			const span = document.createElement("span");
			span.textContent = content;
			span.style.opacity = ".5";
			return span;
		};
		const lit = document.createElement("span");
		lit.textContent = text.slice(at, at + query.length);
		lit.style.fontWeight = "700";
		fragment.append(
			dim(text.slice(0, at)),
			lit,
			dim(text.slice(at + query.length)),
		);
		return fragment;
	}

	//: Prefix matches first, then anywhere. Typing `si` should offer `sigma`
	//: before it offers anything that merely contains those letters.
	function matching(query) {
		if (!query) return COMMAND_NAMES;
		const starts = COMMAND_NAMES.filter((name) => name.startsWith(query));
		const rest = COMMAND_NAMES.filter(
			(name) => !name.startsWith(query) && name.includes(query),
		);
		return [...starts, ...rest];
	}

	let menu;
	function menuElement() {
		if (menu) return menu;
		menu = document.createElement("div");
		menu.style.cssText =
			"position:fixed;z-index:2147483647;padding:4px;border-radius:7px;" +
			"background:#1f2224;color:#f3eee4;font:12px ui-monospace,Menlo,monospace;" +
			"box-shadow:0 4px 14px rgba(0,0,0,.35);pointer-events:none;" +
			"max-height:" +
			(MENU_ROWS * 20 + 8) +
			"px;overflow:hidden;min-width:132px";
		document.body.append(menu);
		return menu;
	}

	function showCommand(field, query, choice, options) {
		const node = menuElement();
		node.textContent = "";

		// The typed letters are swallowed rather than inserted, so they have to be
		// legible. The rows do that by lighting up the part they matched; this is
		// the one case where there are no rows to do it.
		if (!options.length) {
			const heading = document.createElement("div");
			heading.textContent = "\\" + query;
			heading.style.cssText = "padding:2px 6px 4px";
			const none = document.createElement("div");
			none.textContent = "no such command";
			none.style.cssText = "padding:2px 6px;opacity:.45";
			node.append(heading, none);
		}

		// Keep the selection on screen without scrolling the list under the cursor.
		const first = Math.max(
			0,
			Math.min(choice - MENU_ROWS + 1, options.length - MENU_ROWS),
		);
		for (const name of options.slice(first, first + MENU_ROWS)) {
			const row = document.createElement("div");
			const chosen = options[choice] === name;
			row.style.cssText =
				"display:flex;justify-content:space-between;gap:14px;padding:2px 6px;border-radius:4px;" +
				(chosen ? "background:#f3eee4;color:#1f2224" : "");
			const left = document.createElement("span");
			left.append(highlighted(name, query));
			const right = document.createElement("span");
			right.textContent = preview(name);
			right.style.opacity = chosen ? ".7" : ".5";
			row.append(left, right);
			node.append(row);
		}

		const box = (
			field.closest(".mathtype-wrapper") ?? field
		).getBoundingClientRect();
		node.style.left = Math.round(box.left) + "px";
		node.style.top = Math.round(box.bottom + 4) + "px";
		node.hidden = false;
	}

	const hideCommand = () => menu && (menu.hidden = true);

	// ---- typing --------------------------------------------------------------------

	const state = new WeakMap();
	const ask = (field) =>
		state.get(field) ?? { term: "", command: null, choice: 0, timer: 0 };

	function settleFunction(field) {
		const { term } = ask(field);
		if (!FUNCTIONS.some((name) => term.endsWith(name))) return;
		state.set(field, { ...ask(field), term: "" });
		insert("parenthesis");
	}

	function onKeyDown(event) {
		const field = event.currentTarget;
		const here = ask(field);
		focused = field;

		if (event.metaKey || event.ctrlKey || event.altKey) return;
		// With no editor to drive, every key is left exactly as the page sent it.
		if (!editor()) return;

		// --- backslash command mode -------------------------------------------------
		if (here.command !== null) {
			event.preventDefault();
			event.stopPropagation();
			const options = matching(here.command);

			if (event.key === "Escape") {
				state.set(field, { ...here, command: null, choice: 0 });
				return hideCommand();
			}

			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				if (!options.length) return;
				const step = event.key === "ArrowDown" ? 1 : -1;
				const choice = (here.choice + step + options.length) % options.length;
				state.set(field, { ...here, choice });
				return showCommand(field, here.command, choice, options);
			}

			if (event.key === "Backspace") {
				// Backspacing past the backslash leaves command mode rather than
				// stranding you in a menu with nothing left to filter.
				if (!here.command) {
					state.set(field, { ...here, command: null, choice: 0 });
					return hideCommand();
				}
				const command = here.command.slice(0, -1);
				state.set(field, { ...here, command, choice: 0 });
				return showCommand(field, command, 0, matching(command));
			}

			if (/^[a-z]$/i.test(event.key)) {
				const command = here.command + event.key.toLowerCase();
				state.set(field, { ...here, command, choice: 0 });
				return showCommand(field, command, 0, matching(command));
			}

			//: Enter, Tab and space take the highlighted row. Anything else commits
			//: what was actually typed and then goes in as itself, so a command
			//: finished with `+` is not silently turned into whatever was highlighted.
			const accepting =
				event.key === "Enter" || event.key === "Tab" || event.key === " ";
			const chosen = accepting ? options[here.choice] : here.command;
			const ran = chosen ? runCommand(chosen) : false;
			state.set(field, { ...here, command: null, choice: 0, term: "" });
			hideCommand();
			// An unknown command types itself out, so nothing is lost.
			if (!ran) typeText("\\" + here.command);
			if (!accepting && event.key.length === 1) typeText(event.key);
			return;
		}

		if (event.key === "\\") {
			event.preventDefault();
			event.stopPropagation();
			state.set(field, { ...here, command: "", choice: 0, term: "" });
			return showCommand(field, "", 0, COMMAND_NAMES);
		}

		// --- structure ----------------------------------------------------------------
		if (event.key === "/" || ACTIONS[event.key]) {
			const built = event.key === "/" ? fraction() : insert(ACTIONS[event.key]);
			state.set(field, { ...here, term: "" });
			// If the editor would not build it, the plain character is better than
			// nothing at all.
			if (built) {
				event.preventDefault();
				event.stopPropagation();
			}
			return;
		}

		// --- function names ----------------------------------------------------------
		if (!/^[a-z]$/i.test(event.key)) {
			state.set(field, { ...here, term: "" });
			return;
		}

		const term = (here.term + event.key.toLowerCase()).slice(-8);
		clearTimeout(here.timer);
		const timer = FUNCTIONS.some(
			(name) => AMBIGUOUS.has(name) && term.endsWith(name),
		)
			? setTimeout(() => settleFunction(field), SETTLE_MS)
			: 0;
		state.set(field, { ...here, term, timer });
		if (!timer) settleFunction(field);
	}

	function adopt(field) {
		if (field.dataset.betterEntry === "on") return;
		field.dataset.betterEntry = "on";
		field.addEventListener("keydown", onKeyDown, true);
		field.addEventListener("blur", hideCommand);
	}

	const fields = () =>
		document.querySelectorAll(
			".wrs_focusElement, .wrs_focusElementContainer input",
		);

	//: Editors are built lazily, one per box, and the overlay editor is built
	//: again each time it opens — so watch rather than sweep once.
	new MutationObserver(() => {
		fields().forEach(adopt);
		guardAgainstErasure();
	}).observe(document.documentElement, { childList: true, subtree: true });
	fields().forEach(adopt);
	guardAgainstErasure();

	// Their handler races ours to insert a second set of parentheses.
	if (Array.isArray(window.mathTypeEditor?.replacements)) {
		window.mathTypeEditor.replacements.length = 0;
	}

	console.log(
		"[better-entry] 4.5 — native fractions, scripts, fences, command menu, unsticking, answer guard",
	);
})();
