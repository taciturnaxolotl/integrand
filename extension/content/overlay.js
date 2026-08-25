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
    .panel.on { display: block; }

    .head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 7px; }
    .mark { font-size: 13px; color: var(--muted); letter-spacing: .03em; }
    .mark b { color: var(--ink); font-weight: 600; }
    .status { margin-left: auto; font-size: 11px; letter-spacing: .05em;
              color: var(--muted); }
    .status.bad { color: var(--bad); }
    .close { align-self: center; border: 0; background: none; color: var(--muted);
             font: 15px/1 ui-serif, Georgia, serif; padding: 0 1px; cursor: pointer; }
    .close:hover { color: var(--ink); }

    /* The rendered expression is the thing you actually compare against the
       page, so it gets the room and the raw LaTeX hides behind the pencil. */
    .render { margin: 0 0 7px; padding: 9px 8px; text-align: center; font-size: 17px;
              color: var(--ink); background: var(--sunk); border: 1px solid var(--line);
              border-radius: 4px; overflow-x: auto; }
    .render math { color: inherit; }
    .edit { margin-bottom: 2px; }
    .hidden { display: none; }

    textarea { display: block; width: 100%; box-sizing: border-box; height: 40px;
               resize: vertical; font: 11.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
               padding: 6px 7px; border: 1px solid var(--line); border-radius: 4px;
               background: var(--sunk); color: var(--ink); }
    textarea:focus { outline: 1px solid var(--accent); outline-offset: -1px; }

    .infix { margin-top: 5px; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
             color: var(--muted); overflow: hidden; text-overflow: ellipsis;
             white-space: nowrap; }
    .note { margin-top: 6px; font-size: 11.5px; color: var(--bad); }

    .row { display: flex; gap: 6px; align-items: center; margin-top: 9px; }
    button { font: inherit; font-size: 11.5px; line-height: 1; padding: 6px 10px;
             border-radius: 4px; border: 1px solid var(--accent);
             background: var(--accent); color: var(--accent-ink); cursor: pointer; }
    button.ghost { background: transparent; color: var(--accent); }
    button.icon { margin-left: auto; padding: 5px 8px; font-size: 13px; line-height: 1; }
    button:disabled { opacity: .45; cursor: not-allowed; }

    .spinner { width: 11px; height: 11px; border: 2px solid var(--line);
               border-top-color: var(--accent); border-radius: 50%;
               animation: spin .7s linear infinite; display: inline-block;
               vertical-align: -1px; margin-right: 6px; }
    .waiting { color: var(--muted); font-size: 11.5px; }
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
        <button class="close" title="Close (Esc)">&times;</button>
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
    crop.classList.toggle("hidden", !dragging);
    Object.assign(crop.style, {
      left: `${x1}px`, top: `${y1}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px`,
    });
  }

  function start() {
    hidePanel();
    box = { x1: 0, y1: 0, x2: 0, y2: 0 };
    dragging = false;
    layer.classList.add("on");
    paint();
  }

  function stop() {
    layer.classList.remove("on");
    dragging = false;
  }

  layer.addEventListener("mousedown", (event) => {
    event.preventDefault();
    dragging = true;
    box = { x1: event.clientX, y1: event.clientY, x2: event.clientX, y2: event.clientY };
    paint();
  });

  layer.addEventListener("mousemove", (event) => {
    if (!dragging) return;
    box.x2 = event.clientX;
    box.y2 = event.clientY;
    paint();
  });

  layer.addEventListener("mouseup", async (event) => {
    if (!dragging) return;
    dragging = false;
    const { x1, y1, x2, y2 } = bounds();
    const rect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    stop();
    if (rect.w < 10 || rect.h < 10) return; // a stray click, not a drag
    await submit(rect);
  });

  addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (layer.classList.contains("on")) stop();
    else hidePanel();
  });

  async function submit(rect) {
    showPanel(`<div class="waiting"><span class="spinner"></span>Reading…</div>`, "working");

    // Ask the page first: where it knows its own maths the answer is exact,
    // and OCR is left with what is genuinely just pixels.
    const known = globalThis.integrandPageMath?.latexUnder({
      left: rect.x, top: rect.y, right: rect.x + rect.w, bottom: rect.y + rect.h,
    });
    if (known) {
      const converted = await chrome.runtime.sendMessage({ type: "convert", latex: known.latex });
      return render(converted, known.how);
    }

    // The overlay must be off-screen *and painted* before the capture, or it
    // lands in the screenshot. Two frames is the reliable way to know that.
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));

    const { dataUrl, error } = await chrome.runtime.sendMessage({ type: "capture" });
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
  function render(result, source) {
    if (!result || result.error === "network") {
      return showPanel(`<div class="note">No answer from the service. Is it running?</div>`, "offline");
    }

    const latex = result.latex ?? "";
    const failed = Boolean(result.error);
    const unverified = !failed && !result.verified;
    const blocked = failed || unverified;
    const where = result.kind === "derivative" ? "Derivative" : "Integral";

    // Silent when it worked: the rendered expression and the live buttons
    // already say so, and a permanent "verified" would only make the warnings
    // easier to miss. Naming the typesetter is the exception — it says the
    // LaTeX was read rather than guessed, and which reader got it.
    showPanel(`
      <div class="render hidden"></div>
      <div class="edit${blocked ? "" : " hidden"}">
        <textarea class="latex" spellcheck="false">${escape(latex)}</textarea>
      </div>
      ${blocked ? "" : `<div class="infix" title="${escape(result.infix)}">${escape(result.infix)}</div>`}
      ${failed ? `<div class="note">${escape(result.detail || result.error)}</div>` : ""}
      ${unverified ? `<div class="note">Round-trip check failed — this may not be the expression above.</div>` : ""}
      <div class="row">
        <button class="go" ${blocked ? "disabled" : ""}>${where} calc</button>
        <button class="ghost sym">Symbolab</button>
        <button class="ghost icon pencil" title="Edit the LaTeX">&#9998;</button>
      </div>
    `, failed ? "not converted" : unverified ? "unverified" : (source ?? ""),
       blocked ? "bad" : "");

    const rendered = body.querySelector(".render");
    if (result.mathml && mountMath(rendered, result.mathml)) rendered.classList.remove("hidden");

    body.querySelector(".go")?.addEventListener("click", () => open_(result.url));

    body.querySelector(".sym").addEventListener("click", () => {
      open_(`${SYMBOLAB}${encodeURIComponent(body.querySelector(".latex").value)}`);
    });

    // One button, two jobs: reveal the source, then re-read it once edited.
    const pencil = body.querySelector(".pencil");
    const editor = body.querySelector(".edit");
    const setMode = (editing) => {
      editor.classList.toggle("hidden", !editing);
      pencil.innerHTML = editing ? "&#8635;" : "&#9998;";
      pencil.title = editing ? "Re-read the edited LaTeX" : "Edit the LaTeX";
    };
    setMode(blocked);

    pencil.addEventListener("click", async () => {
      if (editor.classList.contains("hidden")) {
        setMode(true);
        body.querySelector(".latex").focus();
        return;
      }
      const edited = body.querySelector(".latex").value;
      showPanel(`<div class="waiting"><span class="spinner"></span>Converting…</div>`, "working");
      render(await chrome.runtime.sendMessage({ type: "convert", latex: edited }));
    });
  }

  // The panel stays put after opening a calculator. Only Escape, the close
  // button, or the next capture take it down.
  function open_(url) {
    chrome.runtime.sendMessage({ type: "open", url });
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

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "start-crop") start();
  });

  start();
})();
