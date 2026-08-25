// Read the maths the page already knows, so OCR is only a fallback.
//
// Four sources, in order of how much work they take:
//
//   1. KaTeX / MathJax v3 / MathML — the LaTeX is right there in an
//      <annotation encoding="application/x-tex">.
//   2. MathJax v2 — same, in a <script type="math/tex"> beside the rendering.
//   3. Wikipedia — the LaTeX is the alt text of the fallback <img>.
//   4. WebAssign — no LaTeX anywhere, but its "watex" markup is structural
//      rather than decorative, so it can be walked back into LaTeX.
//
// Candidates are scored by how much of their own box the crop covers, so a
// sloppy drag still lands on the right expression and a crop that only clips
// the corner of one lands on nothing.

globalThis.integrandPageMath = (() => {
  const MIN_COVERAGE = 0.5;

  // Bare `sin` parses as s·i·n. watex draws function names as plain text, so
  // the backslashes go back on. Longest first, or `sin` eats `arcsin`.
  const FUNCTIONS = [
    "arcsinh", "arccosh", "arctanh", "arcsin", "arccos", "arctan",
    "arccot", "arcsec", "arccsc", "arsinh", "arcosh", "artanh",
    "sinh", "cosh", "tanh", "sech", "csch", "coth",
    "sin", "cos", "tan", "sec", "csc", "cot", "log", "ln", "exp",
  ];
  const BARE_FUNCTION = new RegExp(`(?<![\\\\a-zA-Z])(${FUNCTIONS.join("|")})(?![a-zA-Z])`, "g");

  function classes(element) {
    return (element.className || "").toString().split(/\s+/).filter(Boolean);
  }

  // Shallowest match wins, and the search does not leave the subtree, so a
  // nested fraction inside a numerator cannot be mistaken for the numerator.
  function part(root, wanted) {
    const queue = [...root.children];
    while (queue.length) {
      const node = queue.shift();
      if (classes(node).includes(wanted)) return node;
      queue.push(...node.children);
    }
    return null;
  }

  function children(node) {
    return [...node.childNodes].map(walk).join("");
  }

  function walk(node) {
    // NFKD folds the Mathematical Alphanumeric block back to plain letters —
    // WebAssign writes variables as 𝜃 and 𝑥, not θ and x.
    if (node.nodeType === Node.TEXT_NODE) return node.textContent.normalize("NFKD");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    const has = (name) => classes(node).includes(name);

    // Delimiters are drawn as images inside a table of their own, holding no
    // text. Dropping them silently turns `x^{2/3}(8 + x^{1/3})` into
    // `x^{2/3}·8 + x^{1/3}`, which converts and verifies and is a different
    // question, so they have to be caught at the wrapper rather than the image.
    if (has("watexparenleft")) return "(";
    if (has("watexparenright")) return ")";

    if (node.tagName === "IMG") {
      return has("watexintimage") ? "\\int " : "";
    }

    if (node.tagName === "SUP") return `^{${children(node)}}`;
    if (node.tagName === "SUB") return `_{${children(node)}}`;

    if (has("watexfraction")) {
      const over = part(node, "watexnumerator");
      const under = part(node, "watexdenominator");
      return `\\frac{${over ? children(over) : ""}}{${under ? children(under) : ""}}`;
    }

    if (has("watexsqrt")) {
      const radicand = part(node, "watexsqrtradicandcontent") || part(node, "watexsqrtradicand");
      const index = part(node, "watexsqrtrootcontent") || part(node, "watexsqrtroot");
      const degree = index ? children(index).trim() : "";
      const body = radicand ? children(radicand) : "";
      return degree ? `\\sqrt[${degree}]{${body}}` : `\\sqrt{${body}}`;
    }

    if (has("watexintcomplex") || has("watexintlimitcomplex")) {
      const upper = part(node, "watexintabove");
      const lower = part(node, "watexintbelow");
      const body = part(node, "watexintcontent");
      const top = upper ? children(upper).trim() : "";
      const bottom = lower ? children(lower).trim() : "";
      const bounds = top || bottom ? `_{${bottom}}^{${top}}` : "";
      return `\\int${bounds} ${body ? children(body) : ""}`;
    }

    return children(node);
  }

  function watexToLatex(root) {
    const raw = children(root).replace(/\s+/g, " ").trim();
    return raw.replace(BARE_FUNCTION, "\\$1");
  }

  function sources() {
    const found = [];
    const add = (node, latex, how) => {
      const box = node.getBoundingClientRect();
      // Wikipedia paints its MathML hidden behind an <img>; only drawn
      // candidates can be matched against a crop.
      if (box.width > 1 && box.height > 1 && latex.trim()) {
        found.push({ box, latex: latex.trim(), how });
      }
    };

    for (const annotation of document.querySelectorAll('annotation[encoding="application/x-tex"]')) {
      const host = annotation.closest(".katex") || annotation.closest("math")?.parentElement;
      if (host) add(host, annotation.textContent, "mathml");
    }
    for (const script of document.querySelectorAll('script[type^="math/tex"]')) {
      if (script.previousElementSibling) {
        add(script.previousElementSibling, script.textContent, "mathjax2");
      }
    }
    for (const image of document.querySelectorAll("img[alt]")) {
      if (/\\[a-zA-Z]/.test(image.alt)) add(image, image.alt, "img-alt");
    }
    for (const line of document.querySelectorAll(".watexline")) {
      add(line, watexToLatex(line), "watex");
    }
    return found;
  }

  function overlap(crop, box) {
    const wide = Math.min(crop.right, box.right) - Math.max(crop.left, box.left);
    const tall = Math.min(crop.bottom, box.bottom) - Math.max(crop.top, box.top);
    return wide > 0 && tall > 0 ? wide * tall : 0;
  }

  /** The page's own LaTeX for whatever the crop covers, or null. */
  function latexUnder(crop) {
    let best = null;
    let coverage = 0;
    for (const source of sources()) {
      const fraction = overlap(crop, source.box) / (source.box.width * source.box.height);
      if (fraction > coverage) {
        coverage = fraction;
        best = source;
      }
    }
    return coverage > MIN_COVERAGE ? { ...best, coverage } : null;
  }

  return { latexUnder, watexToLatex, sources };
})();
