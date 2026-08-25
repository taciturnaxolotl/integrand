// Drag-select overlay, crop, and result panel.
//
// The crop is done here rather than in an offscreen document: MV3 *workers*
// have no canvas, but content scripts have the whole DOM. That deletes the
// offscreen permission and its document lifecycle.
//
// Everything lives in a closed shadow root, so page CSS cannot bleed in and
// page scripts cannot reach the nodes.

(() => {
  const HOST_ID = "integrand-overlay-host";
  if (document.getElementById(HOST_ID)) return; // injected on every click

  // Reading the page's own maths takes about as long as a round trip to
  // localhost, so the spinner would appear and vanish inside a frame or two.
  // Holding the wait to a floor makes the change of state legible. It does not
  // invent progress — the work is done, we are just not flickering at people.
  const MINIMUM_WAIT = 350;

  function atLeast(work, ms = MINIMUM_WAIT) {
    const rested = new Promise((done) => setTimeout(done, ms));
    return Promise.all([work, rested]).then(([value]) => value);
  }

  const CSS = `
    :host { all: initial; }

    /* The panel sits on the page, not in the browser chrome, so its theme
       follows the page rather than the OS. data-theme is set from the measured
       background; light is the default so a page we cannot read still works. */
    .panel {
      --paper: #fbf7ef; --ink: #1f2224; --muted: #7d6f52; --line: #ddd3c0;
      --accent: #276a80; --accent-ink: #fff; --sunk: #f2ebde;
      --bad: #9c3019;
    }
    .panel[data-theme="dark"] {
      --paper: #191c1e; --ink: #f3eee4; --muted: #aba18e; --line: #414850;
      --accent: #6cc0da; --accent-ink: #0c1518; --sunk: #0f1315;
      --bad: #f2907a;
    }

    .backdrop { position: fixed; background: rgba(12, 18, 24, 0.45); z-index: 2147483646; }
    .backdrop.left { top: 0; bottom: 0; left: 0; width: 0; }
    .backdrop.right { top: 0; bottom: 0; right: 0; left: 0; }
    .crop { position: fixed; z-index: 2147483647; border: 1px solid #6fd3f2;
            box-shadow: 0 0 0 1px rgba(0,0,0,.4); cursor: crosshair; }
    .crop.hidden { display: none; }
    .layer { position: fixed; inset: 0; z-index: 2147483645; cursor: crosshair; display: none; }
    .layer.on { display: block; }

    .panel { position: fixed; right: 16px; bottom: 16px; width: 316px;
             max-width: calc(100vw - 32px); z-index: 2147483647; display: none;
             box-sizing: border-box; background: var(--paper); color: var(--ink);
             border: 1px solid var(--line); border-radius: 7px;
             box-shadow: 0 6px 22px rgba(0,0,0,.22);
             font: 12px/1.45 ui-serif, Georgia, "Times New Roman", serif;
             padding: 9px 11px 10px; }
    .panel.on { display: block; animation: rise .16s ease-out; }
    @keyframes rise { from { opacity: 0; transform: translateY(4px); } }

    .head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 7px; }
    .mark { font-size: 13px; color: var(--muted); letter-spacing: .03em; }
    .mark b { color: var(--ink); font-weight: 600; }
    .status { margin-left: auto; font-size: 11px; letter-spacing: .05em;
              color: var(--muted); }
    .status.bad { color: var(--bad); }
    /* The mark carries its own frame, so hovering changes colour rather than
       adding a second shape behind it. */
    .close { align-self: center; display: inline-flex; align-items: center;
             justify-content: center; width: 20px; height: 20px; padding: 0;
             border: 0; border-radius: 5px; background: none; color: var(--muted);
             cursor: pointer; transition: color .12s ease, background .12s ease; }
    /* The same inset tone the render box uses, so the pill belongs to the
       palette rather than being a grey wash laid over it. */
    .close:hover { color: var(--ink); background: var(--sunk); }
    .close:active { background: var(--line); }
    .close:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }

    /* Every state is held to the same box, so swapping the spinner for a
       result does not make the panel jump. "safe" centring so a wide
       expression scrolls from its left edge rather than being clipped. */
    .body { min-height: 102px; }
    .render { margin: 0 0 7px; padding: 9px 8px; font-size: 17px; min-height: 48px;
              display: flex; align-items: center; justify-content: safe center;
              color: var(--ink); background: var(--sunk); border: 1px solid var(--line);
              border-radius: 4px; overflow-x: auto; }
    .render math { color: inherit; }
    .latex { font: 11.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
             color: var(--muted); word-break: break-all; }
    .hidden { display: none; }

    .note { margin-top: 6px; font-size: 11.5px; color: var(--bad); }

    .row { display: flex; gap: 6px; align-items: center; margin-top: 9px; }
    /* Scoped to the action row. The close button sits in the header and styles
       itself. Left unscoped, a hover rule on plain "button" outscores one on
       ".close" and paints the close with the primary fill.

       Hover moves toward the ink either way — darker on paper, brighter in the
       dark — so one rule covers both schemes. */
    .row button { font: inherit; font-size: 11.5px; line-height: 1; padding: 6px 10px;
                  border-radius: 4px; border: 1px solid var(--accent);
                  background: var(--accent); color: var(--accent-ink); cursor: pointer;
                  transition: background .12s ease, border-color .12s ease, color .12s ease; }
    .row button:hover:not(:disabled) {
      background: color-mix(in oklch, var(--accent) 84%, var(--ink));
      border-color: color-mix(in oklch, var(--accent) 84%, var(--ink));
    }
    .row button:active:not(:disabled) {
      background: color-mix(in oklch, var(--accent) 72%, var(--ink));
    }
    .row button.ghost { background: transparent; color: var(--accent); }
    .row button.ghost:hover:not(:disabled) {
      background: color-mix(in oklch, var(--accent) 13%, transparent);
      border-color: var(--accent); color: var(--accent);
    }
    .row button.ghost:active:not(:disabled) {
      background: color-mix(in oklch, var(--accent) 22%, transparent);
    }
    .row button:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
    .row button.icon { margin-left: auto; padding: 5px 8px; line-height: 1;
                       display: inline-flex; align-items: center; justify-content: center; }
    .row button:disabled { opacity: .45; cursor: not-allowed; }

    .spinner { width: 11px; height: 11px; border: 2px solid var(--line);
               border-top-color: var(--accent); border-radius: 50%;
               animation: spin .7s linear infinite; display: inline-block;
               vertical-align: -1px; margin-right: 6px; }
    .waiting { min-height: 102px; display: flex; align-items: center;
               justify-content: center; color: var(--muted); font-size: 11.5px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  `;

  const HTML = `
    <div class="layer">
      <div class="backdrop top"></div><div class="backdrop bottom"></div>
      <div class="backdrop left"></div><div class="backdrop right"></div>
      <div class="crop hidden"></div>
    </div>
    <div class="panel">
      <div class="head">
        <span class="mark">∫&nbsp;<b>integrand</b></span>
        <span class="status"></span>
        <button class="close" title="Close (Esc)" aria-label="Close">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
               stroke="currentColor" stroke-width="2.5" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
          </svg>
        </button>
      </div>
      <div class="body"></div>
    </div>
  `;

  const host = document.createElement("div");
  host.id = HOST_ID;
  document.documentElement.append(host);
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `<style>${CSS}</style>${HTML}`;

  const layer = shadow.querySelector(".layer");
  const crop = shadow.querySelector(".crop");
  const panel = shadow.querySelector(".panel");
  const body = shadow.querySelector(".body");
  const status = shadow.querySelector(".status");
  const edges = {
    top: shadow.querySelector(".backdrop.top"),
    bottom: shadow.querySelector(".backdrop.bottom"),
    left: shadow.querySelector(".backdrop.left"),
    right: shadow.querySelector(".backdrop.right"),
  };

  let box = { x1: 0, y1: 0, x2: 0, y2: 0 };
  let dragging = false;

  // Expressions the page reader can name, with where they sit. Knowing this is
  // what lets a crop become a click: hovering one lights it up and taking it
  // needs no drag at all. Cached for the life of one crop, and refreshed on
  // scroll because the boxes are viewport-relative.
  let known = [];
  let hovered = null;
  let origin = null;

  function refreshKnown() {
    try {
      known = globalThis.integrandPageMath?.sources() ?? [];
    } catch {
      known = [];
    }
  }

  function knownAt(x, y) {
    let best = null;
    for (const source of known) {
      const { box: b } = source;
      if (x < b.left || x > b.right || y < b.top || y > b.bottom) continue;
      // the smallest box wins, so a term inside a line beats the whole line
      if (!best || b.width * b.height < best.box.width * best.box.height) best = source;
    }
    return best;
  }

  // The drag runs in any direction, so the live rect is the ordered box.
  // Without this a leftward drag computes a negative width, the CSS parser
  // throws the declaration away, and the overlay freezes mid-drag.
  function bounds() {
    return {
      x1: Math.min(box.x1, box.x2), x2: Math.max(box.x1, box.x2),
      y1: Math.min(box.y1, box.y2), y2: Math.max(box.y1, box.y2),
    };
  }

  // Four backdrop panels rather than an SVG mask: fewer moving parts, and the
  // hole is always exactly the crop rect. Every edge that positioning depends
  // on is written on every paint — leaving `height` to the stylesheet while
  // setting `top` and `bottom` here over-constrains the box, and CSS resolves
  // that by keeping the height and dropping the bottom.
  function paint() {
    const { x1, y1, x2, y2 } = bounds();
    const column = { left: `${x1}px`, width: `${x2 - x1}px` };
    Object.assign(edges.top.style, { ...column, top: "0px", height: `${y1}px` });
    Object.assign(edges.bottom.style, { ...column, top: `${y2}px`, height: "auto", bottom: "0px" });
    edges.left.style.width = `${x1}px`;
    edges.right.style.left = `${x2}px`;
    crop.classList.toggle("hidden", !dragging && !hovered);
    Object.assign(crop.style, {
      left: `${x1}px`, top: `${y1}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px`,
    });
  }

  function start() {
    hidePanel();
    box = { x1: 0, y1: 0, x2: 0, y2: 0 };
    dragging = false;
    hovered = null;
    refreshKnown();
    layer.classList.add("on");
    globalThis.integrandAnchor?.setCropping(true);
    paint();
  }

  function stop() {
    layer.classList.remove("on");
    dragging = false;
    hovered = null;
    origin = null;
    layer.style.cursor = "crosshair";
    globalThis.integrandAnchor?.setCropping(false);
  }

  addEventListener("scroll", () => layer.classList.contains("on") && refreshKnown(), true);

  layer.addEventListener("mousedown", (event) => {
    event.preventDefault();
    dragging = true;
    origin = { x: event.clientX, y: event.clientY };
    // Hold the highlight until the pointer actually moves, so pressing on a
    // known expression does not blink it away before the click lands.
    if (!hovered) {
      box = { x1: origin.x, y1: origin.y, x2: origin.x, y2: origin.y };
      paint();
    }
  });

  layer.addEventListener("mousemove", (event) => {
    if (dragging) {
      box = { x1: origin.x, y1: origin.y, x2: event.clientX, y2: event.clientY };
      paint();
      return;
    }

    const under = knownAt(event.clientX, event.clientY);
    if (under === hovered) return;
    hovered = under;
    layer.style.cursor = under ? "pointer" : "crosshair";
    box = under
      ? { x1: under.box.left, y1: under.box.top, x2: under.box.right, y2: under.box.bottom }
      : { x1: 0, y1: 0, x2: 0, y2: 0 };
    paint();
  });

  layer.addEventListener("mouseup", async (event) => {
    if (!dragging) return;
    dragging = false;
    const moved =
      !origin ||
      Math.abs(event.clientX - origin.x) > 4 ||
      Math.abs(event.clientY - origin.y) > 4;
    const taken = hovered;
    const { x1, y1, x2, y2 } = bounds();
    const rect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    stop();

    // A click on something the reader already knows needs no rectangle.
    if (!moved && taken) return submitKnown(taken.latex);
    if (rect.w < 10 || rect.h < 10) return; // a stray click, not a drag
    await submit(rect);
  });

  addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (layer.classList.contains("on")) stop();
    else hidePanel();
  });

  async function submitKnown(latex) {
    showPanel(`<div class="waiting"><span class="spinner"></span>Reading…</div>`, "working");
    render(await atLeast(chrome.runtime.sendMessage({ type: "convert", latex })));
  }

  async function submit(rect) {
    showPanel(`<div class="waiting"><span class="spinner"></span>Reading…</div>`, "working");

    // Ask the page first: where it knows its own maths the answer is exact,
    // and OCR is left with what is genuinely just pixels.
    const covered = globalThis.integrandPageMath?.latexUnder({
      left: rect.x, top: rect.y, right: rect.x + rect.w, bottom: rect.y + rect.h,
    });
    if (covered) return submitKnown(covered.latex);

    // The overlay must be off-screen *and painted* before the capture, or it
    // lands in the screenshot. Two frames is the reliable way to know that.
    // The anchor is not part of the overlay, so it has to be told separately.
    globalThis.integrandAnchor?.setHidden(true);
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));

    const { dataUrl, error } = await chrome.runtime.sendMessage({ type: "capture" });
    globalThis.integrandAnchor?.setHidden(false);
    if (error) {
      return showPanel(`<div class="note">Could not capture the tab: ${escape(error)}</div>`, "failed", "bad");
    }

    const image = await crop_(dataUrl, rect);
    const response = await chrome.runtime.sendMessage({ type: "snip", image });
    render(response);
  }

  // captureVisibleTab returns physical pixels; the overlay measures CSS
  // pixels. On a Retina display those differ by 2x and skipping the scale
  // silently crops a quarter of the selection.
  function crop_(dataUrl, rect) {
    return new Promise((resolve) => {
      const shot = new Image();
      shot.onload = () => {
        const ratio = devicePixelRatio || 1;
        const canvas = document.createElement("canvas");
        canvas.width = rect.w * ratio;
        canvas.height = rect.h * ratio;
        canvas
          .getContext("2d")
          .drawImage(shot, rect.x * ratio, rect.y * ratio, canvas.width, canvas.height,
                    0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/png"));
      };
      shot.src = dataUrl;
    });
  }

  function escape(text) {
    return String(text).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // Symbolab takes the LaTeX straight in its path, so this still works when
  // our own conversion refused the expression.
  const SYMBOLAB = "https://www.symbolab.com/solver/step-by-step/";

  const icon = (paths) =>
    `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
          aria-hidden="true">${paths}</svg>`;
  const COPY_ICON = icon(
    `<rect x="8" y="8" width="14" height="14" rx="2"/>` +
    `<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>`
  );
  const DONE_ICON = icon(`<path d="M20 6 9 17l-5-5"/>`);

  // Everything sympy's presentation printer emits, and nothing else. The
  // MathML is ours but derived from OCR output, so it goes through an
  // allowlist rather than straight into innerHTML.
  const MATHML_TAGS = new Set([
    "math", "mrow", "mi", "mn", "mo", "ms", "mtext", "mspace", "mstyle", "mpadded",
    "msup", "msub", "msubsup", "munder", "mover", "munderover",
    "mfrac", "msqrt", "mroot", "mfenced", "mtable", "mtr", "mtd",
  ]);
  const MATHML_ATTRS = new Set(["display", "mathvariant", "width", "linethickness", "stretchy", "separators"]);

  function mountMath(target, xml) {
    let parsed;
    try {
      parsed = new DOMParser().parseFromString(xml, "application/xhtml+xml");
    } catch {
      return false;
    }
    if (parsed.querySelector("parsererror")) return false;

    const root = parsed.documentElement;
    for (const node of [root, ...root.querySelectorAll("*")]) {
      if (!MATHML_TAGS.has(node.localName)) return false;
      for (const attr of [...node.attributes]) {
        if (!MATHML_ATTRS.has(attr.name)) node.removeAttribute(attr.name);
      }
    }
    target.replaceChildren(document.importNode(root, true));
    return true;
  }

  // The LaTeX is shown on success, not only on failure. Roughly one snip in
  // four is misread in a way that still converts and still verifies — a
  // misread variable is a valid expression, just not the one on screen — so
  // the only real check is a human glancing at it.
  function render(result) {
    if (!result || result.error === "network") {
      return showPanel(`<div class="note">No answer from the service. Is it running?</div>`, "offline");
    }

    const latex = result.latex ?? "";
    const failed = Boolean(result.error);
    const unverified = !failed && !result.verified;
    const blocked = failed || unverified;
    const where = result.kind === "derivative" ? "Derivative" : "Integral";

    // Silent when it worked: the rendered expression and the live buttons
    // already say so, and a badge that is almost always lit only makes the
    // warnings easier to miss.
    showPanel(`
      <div class="render hidden"></div>
      ${failed ? `<div class="latex">${escape(latex)}</div>` : ""}
      ${failed ? `<div class="note">${escape(result.detail || result.error)}</div>` : ""}
      ${unverified ? `<div class="note">Reading this back did not give the same expression, so the link may solve something else. The copied form is still what would be sent.</div>` : ""}
      <div class="row">
        <button class="go" ${blocked ? "disabled" : ""}>${where} calc</button>
        <button class="ghost sym">Symbolab</button>
        <button class="ghost icon copy" ${failed ? "disabled" : ""}
                title="Copy the expression">${COPY_ICON}</button>
      </div>
    `, failed ? "not converted" : unverified ? "unverified" : "", blocked ? "bad" : "");

    const rendered = body.querySelector(".render");
    if (result.mathml && mountMath(rendered, result.mathml)) rendered.classList.remove("hidden");

    body.querySelector(".go")?.addEventListener("click", () => open_(result.url));

    body.querySelector(".sym").addEventListener("click", () => {
      open_(`${SYMBOLAB}${encodeURIComponent(latex)}`);
    });

    // What the site is actually sent. Showing it permanently was noise; it is
    // still the thing worth having on the clipboard.
    body.querySelector(".copy")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      await copyText(result.infix);
      button.innerHTML = DONE_ICON;
      setTimeout(() => (button.innerHTML = COPY_ICON), 1400);
    });

  }

  // The panel stays put after opening a calculator. Only Escape, the close
  // button, or the next capture take it down.
  function open_(url) {
    chrome.runtime.sendMessage({ type: "open", url });
  }

  // The clipboard API needs a focused document; a page that steals focus back
  // would leave the copy silently doing nothing, so fall back to a selection.
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      const carrier = document.createElement("textarea");
      carrier.value = text;
      carrier.style.cssText = "position:fixed;top:-9999px;opacity:0";
      document.body.append(carrier);
      carrier.select();
      document.execCommand("copy");
      carrier.remove();
    }
  }

  function parseColor(value) {
    const match = String(value).match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const [r, g, b, a = 1] = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  }

  function luminance({ r, g, b }) {
    const channel = (value) => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }

  // Match the page, not the OS: a cream card is glaring on a dark page even
  // in light mode. Probe behind the panel's own corner, then fall back
  // outward, since most pages leave <body> transparent and paint on <html>.
  //
  // 0.2 is the relative luminance of a mid grey.
  function pageIsDark() {
    const corner = document.elementsFromPoint(innerWidth - 40, innerHeight - 40);
    for (const element of [...corner, document.body, document.documentElement]) {
      if (!element || element === host) continue;
      const color = parseColor(getComputedStyle(element).backgroundColor);
      if (color && color.a > 0.5) return luminance(color) < 0.2;
    }
    return matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function showPanel(html, note = "", tone = "") {
    panel.dataset.theme = pageIsDark() ? "dark" : "light";
    body.innerHTML = html;
    status.textContent = note;
    status.className = `status ${tone}`;
    panel.classList.add("on");
  }

  function hidePanel() {
    panel.classList.remove("on");
  }

  shadow.querySelector(".close").addEventListener("click", hidePanel);

  //: Shared with the anchor, which offers the way out of a selection it did
  //: not start and cannot see.
  globalThis.integrandOverlay = {
    cropping: () => layer.classList.contains("on"),
    cancel: stop,
  };

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "start-crop") start();
  });

  start();
})();
