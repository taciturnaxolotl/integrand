// A small button on the right edge of pages you have opted into.
//
// It appears only once the page reader finds maths, so turning on a site does
// not mean a button on every page of it: homework pages get one, login pages
// do not.

(() => {
  const HOST_ID = "integrand-anchor-host";
  if (document.getElementById(HOST_ID)) return;

  // Pages fill maths in late: MathJax typesets after load, WebAssign draws
  // questions from script. Look a few times before giving up.
  const ATTEMPTS = [400, 1200, 3000, 6000];

  const CSS = `
    :host { all: initial; }
    .anchor {
      position: fixed; right: 0; top: 42%; z-index: 2147483644;
      width: 30px; height: 34px; padding: 0; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      border: 1px solid rgba(0,0,0,.12); border-right: 0;
      border-radius: 6px 0 0 6px; background: #2f7d95; color: #fff;
      font: 17px/1 ui-serif, Georgia, "Times New Roman", serif;
      box-shadow: 0 2px 8px rgba(0,0,0,.2);
      opacity: .45; transform: translateX(5px);
      transition: opacity .15s ease, transform .15s ease;
    }
    .anchor:hover, .anchor:focus-visible { opacity: 1; transform: translateX(0); }
    .anchor.busy { opacity: 0; pointer-events: none; }
  `;

  const host = document.createElement("div");
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML =
    `<style>${CSS}</style>` +
    `<button class="anchor" title="Snip a maths problem (integrand)">∫</button>`;

  const button = shadow.querySelector(".anchor");

  button.addEventListener("click", () => {
    // Out of the way before the capture — the overlay hides itself, but this
    // button is not part of it.
    button.classList.add("busy");
    chrome.runtime.sendMessage({ type: "start-crop-here" });
    setTimeout(() => button.classList.remove("busy"), 2500);
  });

  function pageHasMaths() {
    try {
      return (globalThis.integrandPageMath?.sources() ?? []).length > 0;
    } catch {
      return false;
    }
  }

  function show() {
    if (!document.body || document.getElementById(HOST_ID)) return true;
    document.documentElement.append(host);
    return true;
  }

  function look(index = 0) {
    if (pageHasMaths()) {
      show();
      return;
    }
    if (index < ATTEMPTS.length) setTimeout(() => look(index + 1), ATTEMPTS[index]);
  }

  look();
})();
