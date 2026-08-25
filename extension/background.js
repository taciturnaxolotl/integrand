// Service worker: capture, talk to the service, drive the calculator tab.
// No canvas here — MV3 workers have none. The crop happens in the content
// script, which has a full DOM.

const DEFAULT_ENDPOINT = "http://localhost:8765";

async function endpoint() {
  const { endpoint } = await chrome.storage.local.get("endpoint");
  return (endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url?.startsWith("http")) return; // activeTab grants nothing on chrome://
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content/page-math.js", "content/overlay.js"],
  });
  // The script starts a crop on load; this covers the already-injected case.
  chrome.tabs.sendMessage(tab.id, { type: "start-crop" }).catch(() => {});
});

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
});
