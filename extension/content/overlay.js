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
    .backdrop { position: fixed; background: rgba(12, 18, 24, 0.45); z-index: 2147483646; }
    .backdrop.top, .backdrop.bottom { height: 0; }
    .backdrop.left { top: 0; bottom: 0; left: 0; width: 0; }
    .backdrop.right { top: 0; bottom: 0; right: 0; left: 0; }
    .crop { position: fixed; z-index: 2147483647; border: 1px solid #6fd3f2;
            box-shadow: 0 0 0 1px rgba(0,0,0,.4); cursor: crosshair; }
    .crop.hidden { display: none; }
    .layer { position: fixed; inset: 0; z-index: 2147483645; cursor: crosshair; display: none; }
    .layer.on { display: block; }

    .panel { position: fixed; right: 20px; bottom: 20px; width: 400px; max-width: calc(100vw - 40px);
             z-index: 2147483647; display: none; background: #fbf7ef; color: #1b1d1e;
             border: 1px solid #cfc4ae; border-radius: 6px; box-shadow: 0 8px 28px rgba(0,0,0,.28);
             font: 13px/1.5 ui-serif, Georgia, "Times New Roman", serif; padding: 14px 16px; }
    .panel.on { display: block; }
    .panel h2 { margin: 0 0 10px; font-size: 13px; letter-spacing: .08em;
                text-transform: uppercase; color: #7a6a53; font-weight: 600; }
    .panel label { display: block; margin: 10px 0 4px; font-size: 11px;
                   letter-spacing: .06em; text-transform: uppercase; color: #7a6a53; }
    .panel textarea { width: 100%; box-sizing: border-box; min-height: 48px; resize: vertical;
                      font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
                      padding: 7px 8px; border: 1px solid #cfc4ae; border-radius: 4px;
                      background: #fffdf8; color: #1b1d1e; }
    .panel .infix { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
                    background: #f0e9dc; border-radius: 4px; padding: 7px 8px;
                    word-break: break-all; }
    .row { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
    button { font: inherit; font-size: 12px; padding: 6px 13px; border-radius: 4px;
             border: 1px solid #1d4e63; background: #2f7d95; color: #fff; cursor: pointer; }
    button.ghost { background: transparent; color: #1d4e63; }
    button[disabled] { opacity: .45; cursor: not-allowed; }
    .flag { margin-left: auto; font-size: 11px; letter-spacing: .05em; text-transform: uppercase; }
    .flag.bad { color: #a3341f; }
    .flag.good { color: #3f6b34; }
    .note { margin-top: 10px; font-size: 12px; color: #a3341f; }
    .spinner { width: 13px; height: 13px; border: 2px solid #cfc4ae; border-top-color: #2f7d95;
               border-radius: 50%; animation: spin .7s linear infinite; display: inline-block; }
    @keyframes spin { to { transform: rotate(360deg); } }
  `;

  const HTML = `
    <div class="layer">
      <div class="backdrop top"></div><div class="backdrop bottom"></div>
      <div class="backdrop left"></div><div class="backdrop right"></div>
      <div class="crop hidden"></div>
    </div>
    <div class="panel">
      <h2>integrand</h2>
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
  const edges = {
    top: shadow.querySelector(".backdrop.top"),
    bottom: shadow.querySelector(".backdrop.bottom"),
    left: shadow.querySelector(".backdrop.left"),
    right: shadow.querySelector(".backdrop.right"),
  };

  let box = { x1: 0, y1: 0, x2: 0, y2: 0 };
  let dragging = false;

  // Four backdrop panels rather than an SVG mask: fewer moving parts, and the
  // hole is always exactly the crop rect.
  function paint() {
    const { x1, y1, x2, y2 } = box;
    Object.assign(edges.top.style, {
      left: `${x1}px`, width: `${x2 - x1}px`, top: "0px", height: `${y1}px`,
    });
    Object.assign(edges.bottom.style, {
      left: `${x1}px`, width: `${x2 - x1}px`, top: `${y2}px`, bottom: "0px",
    });
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
    const rect = {
      x: Math.min(box.x1, event.clientX),
      y: Math.min(box.y1, event.clientY),
      w: Math.abs(event.clientX - box.x1),
      h: Math.abs(event.clientY - box.y1),
    };
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
    showPanel(`<div class="row"><span class="spinner"></span>&nbsp; Reading…</div>`);

    // The overlay must be off-screen *and painted* before the capture, or it
    // lands in the screenshot. Two frames is the reliable way to know that.
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));

    const { dataUrl, error } = await chrome.runtime.sendMessage({ type: "capture" });
    if (error) return showPanel(`<div class="note">Could not capture the tab: ${escape(error)}</div>`);

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

  // The LaTeX is shown on success, not only on failure. Roughly one snip in
  // four is misread in a way that still converts and still verifies — a
  // misread variable is a valid expression, just not the one on screen — so
  // the only real check is a human glancing at it.
  function render(result) {
    if (!result || result.error === "network") {
      return showPanel(`<div class="note">No answer from the service. Is it running?</div>`);
    }

    const latex = result.latex ?? "";
    const failed = Boolean(result.error);
    const unverified = !failed && !result.verified;

    showPanel(`
      <label>What it read</label>
      <textarea class="latex" spellcheck="false">${escape(latex)}</textarea>
      ${failed ? "" : `<label>Sent as</label><div class="infix">${escape(result.infix)}</div>`}
      ${failed ? `<div class="note">${escape(result.error)}: ${escape(result.detail ?? "")}</div>` : ""}
      ${unverified ? `<div class="note">The round-trip check failed, so this may not be the expression above. Fix it and try again.</div>` : ""}
      <div class="row">
        <button class="go" ${failed || unverified ? "disabled" : ""}>Open calculator</button>
        <button class="ghost again">Re-read edit</button>
        <span class="flag ${failed || unverified ? "bad" : "good"}">
          ${failed ? "not converted" : unverified ? "unverified" : `${result.kind} · d${result.var} · verified`}
        </span>
      </div>
    `);

    body.querySelector(".go")?.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "open", url: result.url });
      hidePanel();
    });

    body.querySelector(".again").addEventListener("click", async () => {
      const edited = body.querySelector(".latex").value;
      showPanel(`<div class="row"><span class="spinner"></span>&nbsp; Converting…</div>`);
      render(await chrome.runtime.sendMessage({ type: "convert", latex: edited }));
    });
  }

  function showPanel(html) {
    body.innerHTML = html;
    panel.classList.add("on");
  }

  function hidePanel() {
    panel.classList.remove("on");
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "start-crop") start();
  });

  start();
})();
