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
      opacity: .72; transform: translateX(4px);
      transition: opacity .15s ease, transform .15s ease, background .15s ease;
    }
    /* Colour, not just opacity: once a selection is running the button is
       already fully opaque and flush, so those two have nothing left to say. */
    .anchor:hover, .anchor:focus-visible {
      opacity: 1; transform: translateX(0); background: #24697f;
    }
    .anchor:active { background: #1d5665; }
    /* While a selection is running it is the way out of one, so it stops
       hiding and says so. The overlay's backdrops sit above the resting
       z-index, so it has to come up or it cannot be clicked. */
    .anchor.cropping { opacity: 1; transform: translateX(0); z-index: 2147483647; }
    .anchor svg { display: block; }
  `;

  const MARK = "∫";
  const CANCEL =
    `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"` +
    ` stroke-width="2.5" stroke-linecap="round" aria-hidden="true">` +
    `<path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

  const host = document.createElement("div");
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML =
    `<style>${CSS}</style>` +
    `<button class="anchor" title="Snip a maths problem (integrand)">${MARK}</button>`;

  const button = shadow.querySelector(".anchor");

  button.addEventListener("click", () => {
    // Mid-selection the button means "stop", and that is a local matter — no
    // need to trouble the worker to undo something it never started.
    if (globalThis.integrandOverlay?.cropping()) {
      globalThis.integrandOverlay.cancel();
      return;
    }
    chrome.runtime.sendMessage({ type: "start-crop-here" });
  });

  //: The overlay drives these. It cannot reach inside a closed shadow root, and
  //: the anchor is not part of the overlay, so the two talk through the shared
  //: content-script global rather than through the page.
  globalThis.integrandAnchor = {
    setCropping(on) {
      // 2147483647 is the ceiling, so a tie with the overlay is broken by
      // document order: last one wins.
      if (on) document.documentElement.append(host);
      button.classList.toggle("cropping", on);
      button.innerHTML = on ? CANCEL : MARK;
      button.title = on ? "Cancel the selection (Esc)" : "Snip a maths problem (integrand)";
    },
    // Hidden only for the instant of the capture, or it lands in the shot.
    setHidden(on) {
      host.style.display = on ? "none" : "";
    },
  };

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
