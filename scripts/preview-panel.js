// Preview the result panel in every state, without installing the extension.
//
// The CSS, the markup and `render()` are pulled straight out of overlay.js by
// pattern rather than copied, so the preview cannot drift from what ships.
// The theme is a data-theme attribute driven by page-background detection, so
// the preview just sets it directly and renders the real CSS unmodified.
//
//     node scripts/preview-panel.js && python3 -m http.server -d .preview 8799
//     open http://localhost:8799/panel-light.html?state=unverified
//
// States: ok, unverified, failed, working.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, ".preview");
const src = fs.readFileSync(path.join(ROOT, "extension/content/overlay.js"), "utf8");

function grab(name) {
  const match = src.match(new RegExp("const " + name + " = `([\\s\\S]*?)`;"));
  if (!match) throw new Error(`could not find ${name} in overlay.js`);
  return match[1];
}

function block(signature, end = "\n  }") {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error(`could not find ${signature} in overlay.js`);
  return src.slice(start, src.indexOf(end, start) + end.length);
}

const RESULTS = {
  ok: {
    latex: "\\int \\frac{2x^{2}+7x-1}{x-4}dx",
    infix: "((2*x^(2) + 7*x) - 1)/(x - 4)",
    kind: "integral", var: "x", verified: true,
    url: "https://www.integral-calculator.com/#expr=x&intvar=x",
  },
  unverified: {
    latex: "\\int \\frac{2x^{2}+7x-1}{x-4}dx",
    infix: "((2*x^(2) + 7*x) - 1)/(x - 4)",
    kind: "integral", var: "x", verified: false,
    url: "https://www.integral-calculator.com/#expr=x&intvar=x",
  },
  failed: {
    error: "convert_failed",
    latex: "\\oint \\vert \\mathrm{In}(x) d x",
    detail: "bare function name would parse as a product: 'In'",
  },
};

function build(theme) {
  const css = grab("CSS").replace(":host { all: initial; }", "");

  return `<!doctype html><meta charset="utf-8">
<title>integrand panel — ${theme}</title>
<style>
  body { margin: 0; min-height: 100vh; padding: 24px; font: 14px Georgia, serif;
         background: ${theme === "dark" ? "#0f1214" : "#ffffff"};
         color: ${theme === "dark" ? "#c9c3b7" : "#333333"}; }
  #host { position: fixed; inset: 0; pointer-events: none; }
  .panel { pointer-events: auto; }
${css}
</style>
<p>integrand panel — ${theme}. Add <code>?state=ok|unverified|failed|working</code>.</p>
<div id="host">${grab("HTML")}</div>
<script>
const shadow = document;
const panel = shadow.querySelector(".panel");
const body = shadow.querySelector(".body");
const status = shadow.querySelector(".status");
const chrome = { runtime: { sendMessage: async () => ({}) } };
${block("  function escape(text) {")}
${block("  const SYMBOLAB =", ";")}
${block("  function render(result) {")}
${block("  function showPanel(html, note")}
function hidePanel() { panel.classList.remove("on"); }
function pageIsDark() { return ${theme === "dark"}; }
function open_(url) { console.log("would open", url); }
const RESULTS = ${JSON.stringify(RESULTS)};
const state = new URLSearchParams(location.search).get("state") || "ok";
if (state === "working") {
  showPanel('<div class="waiting"><span class="spinner"></span>Reading…</div>', "working");
} else {
  render(RESULTS[state]);
}
<\/script>`;
}

fs.mkdirSync(OUT, { recursive: true });
for (const theme of ["light", "dark"]) {
  fs.writeFileSync(path.join(OUT, `panel-${theme}.html`), build(theme));
}
console.log(`wrote ${path.relative(ROOT, OUT)}/panel-{light,dark}.html`);
