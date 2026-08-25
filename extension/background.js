// Service worker: capture, talk to the service, drive the calculator tab.
// No canvas here — MV3 workers have none. The crop happens in the content
// script, which has a full DOM.

const DEFAULT_ENDPOINT = "http://localhost:8765";

async function endpoint() {
  const { endpoint } = await chrome.storage.local.get("endpoint");
  return (endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
}

//: Three ways in, all landing here: the toolbar button, the keyboard shortcut
//: (which fires the same onClicked), and the right-click menu. Each is a user
//: gesture, which is what grants activeTab on the page.
async function startCrop(tab) {
  if (!tab?.id || !tab.url?.startsWith("http")) return; // activeTab grants nothing on chrome://
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content/page-math.js", "content/overlay.js"],
  });
  // The script starts a crop on load; this covers the already-injected case.
  chrome.tabs.sendMessage(tab.id, { type: "start-crop" }).catch(() => {});
}

chrome.action.onClicked.addListener(startCrop);

const SNIP_MENU = "integrand-snip";
const KEEP_MENU = "integrand-keep";
const ANCHOR_SCRIPT = "integrand-anchor";

//: Snipping belongs on the page, where you are pointing at a problem.
//: Adding a site is settings, so it hangs off the toolbar icon instead —
//: right-clicking the icon is where you look for what an extension can do,
//: and it keeps the page menu to the one thing you actually want there.
function installMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: SNIP_MENU, title: "Snip this maths problem", contexts: ["page", "selection", "image"] });
    chrome.contextMenus.create({ id: KEEP_MENU, title: "Show the ∫ on this site…", contexts: ["action"] });
  });
}

//: The host travels in session storage rather than the URL so that
//: openOptionsPage can be used — it already focuses an existing options tab
//: instead of piling up new ones, and querying tabs by URL would mean asking
//: for the "tabs" permission just to find our own page.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === SNIP_MENU) startCrop(tab);
  if (info.menuItemId === KEEP_MENU) {
    const host = tab?.url?.startsWith("http") ? new URL(tab.url).host : "";
    chrome.storage.session.set({ pendingHost: host }).then(() => chrome.runtime.openOptionsPage());
  }
});

//: The anchor only runs where its origin has been granted, so the registration
//: is derived from the granted permissions rather than kept alongside them —
//: revoking a site in Chrome's own UI takes the button with it.
async function syncAnchorSites() {
  const granted = await chrome.permissions.getAll();
  const matches = (granted.origins ?? []).filter((o) => !/localhost|127\.0\.0\.1/.test(o));

  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [ANCHOR_SCRIPT] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [ANCHOR_SCRIPT] });
  if (!matches.length) return;

  await chrome.scripting.registerContentScripts([{
    id: ANCHOR_SCRIPT,
    matches,
    js: ["content/page-math.js", "content/anchor.js"],
    runAt: "document_idle",
  }]);
}

function boot() {
  installMenus();
  syncAnchorSites().catch(() => {});
}

chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);
chrome.permissions.onAdded.addListener(() => syncAnchorSites().catch(() => {}));
chrome.permissions.onRemoved.addListener(() => syncAnchorSites().catch(() => {}));

async function post(path, payload) {
  try {
    const response = await fetch(`${await endpoint()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await response.json();
  } catch (cause) {
    return { error: "network", detail: String(cause) };
  }
}

// Both calculators read their hash once, at document parse time — there is no
// hashchange listener and no reload poll. Rewriting only the fragment of a
// loaded tab is a same-document navigation and would do nothing, so a nonce
// goes in the query string to force a real load. It has to be a clock rather
// than a counter: the worker is killed between snips and a counter would
// restart at 1 and stop busting anything.
//
// Built with the URL API rather than string surgery because Symbolab's link
// carries a query and no fragment, and the calculators carry the reverse.
async function openResult(url) {
  const target = new URL(url);
  target.searchParams.set("_", Date.now());
  const key = target.host;

  const { tabs = {} } = await chrome.storage.session.get("tabs");
  if (tabs[key]) {
    try {
      await chrome.tabs.update(tabs[key], { url: target.href, active: true });
      return;
    } catch {
      // the user closed it; fall through and make a new one
    }
  }
  const tab = await chrome.tabs.create({ url: target.href });
  await chrome.storage.session.set({ tabs: { ...tabs, [key]: tab.id } });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type === "capture") {
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" }, (dataUrl) => {
      respond(chrome.runtime.lastError
        ? { error: chrome.runtime.lastError.message }
        : { dataUrl });
    });
    return true;
  }

  if (message.type === "snip") {
    post("/v1/snip", { image: message.image }).then(respond);
    return true;
  }

  if (message.type === "convert") {
    post("/v1/convert", { latex: message.latex }).then(respond);
    return true;
  }

  if (message.type === "open") {
    openResult(message.url).then(() => respond({ ok: true }));
    return true;
  }

  if (message.type === "start-crop-here") {
    startCrop(sender.tab).then(() => respond({ ok: true }));
    return true;
  }

  if (message.type === "sync-anchor-sites") {
    syncAnchorSites().then(() => respond({ ok: true }));
    return true;
  }
});
