const DEFAULT_ENDPOINT = "https://integrand.dunkirk.sh";

// Where the LaTeX comes from on each bundled site. The page reader handles
// all of them directly, which is why they ship switched on.
const SOURCE = {
  "*://integrand.dunkirk.sh/*": "MathML",
  "*://*.webassign.net/*": "watex",
  "*://*.myopenmath.com/*": "MathJax",
  "*://*.instructure.com/*": "Canvas",
  "*://*.deltamath.com/*": "",
  "*://*.gradescope.com/*": "",
  "*://*.khanacademy.org/*": "KaTeX",
  "*://en.wikipedia.org/*": "image alt text",
  "*://math.stackexchange.com/*": "MathJax",
  "*://openstax.org/*": "MathML",
};

// Two grants in here are not sites. A localhost one is only ever there because
// someone pointed the service at their own box, and `<all_urls>` is the
// screenshot permission below — neither is a place the ∫ belongs.
const isSite = (origin) =>
  origin !== "<all_urls>" && !/localhost|127\.0\.0\.1/.test(origin);
const label = (origin) => origin.replace(/^\*:\/\//, "").replace(/\/\*$/, "");
const patternFor = (host) => `*://${host}/*`;

const list = document.getElementById("sites");
const offer = document.getElementById("offer");

async function offSites() {
  const { offSites = [] } = await chrome.storage.local.get("offSites");
  return offSites;
}

async function setSite(origin, on) {
  const off = await offSites();
  const next = on ? off.filter((o) => o !== origin) : [...new Set([...off, origin])];
  await chrome.storage.local.set({ offSites: next });
  await chrome.runtime.sendMessage({ type: "sync-anchor-sites" });
  paint();
}

function siteRow(origin, on) {
  const row = document.createElement("div");
  row.className = "site";

  const host = document.createElement("span");
  host.className = "host";
  host.textContent = label(origin);
  row.append(host);

  const source = SOURCE[origin];
  if (source) {
    const note = document.createElement("span");
    note.className = "note";
    note.textContent = source;
    row.append(note);
  }

  const toggle = document.createElement("label");
  toggle.className = "switch";
  toggle.title = on ? "Showing the ∫ here" : "Not showing the ∫ here";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = on;
  input.addEventListener("change", () => setSite(origin, input.checked));
  const track = document.createElement("span");
  track.className = "track";
  toggle.append(input, track);
  row.append(toggle);

  return row;
}

async function paint() {
  const all = await chrome.permissions.getAll();
  const off = await offSites();
  const origins = (all.origins ?? []).filter(isSite).sort();

  list.replaceChildren();
  if (!origins.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No sites yet. Open one and right-click the toolbar icon.";
    list.append(empty);
    return;
  }
  for (const origin of origins) list.append(siteRow(origin, !off.includes(origin)));
}

// Chrome grants the screenshot only two ways: `activeTab`, which comes from
// starting the snip through the extension, or a standing grant of every host.
// The ∫ on the page can offer neither, so cropping from it needs this. It is a
// switch rather than a prompt at the moment of failure, because agreeing to
// read every site should not be something you do mid-drag to get on with a
// problem.
const EVERYWHERE = { origins: ["<all_urls>"] };
const capture = document.getElementById("capture");
const captureSaid = document.getElementById("capture-said");

async function paintCapture() {
  capture.checked = await chrome.permissions.contains(EVERYWHERE);
  captureSaid.textContent = capture.checked ? "reads every site" : "";
}

// No await before the request: the click is what allows it to be asked, and
// awaiting anything first spends it.
capture.addEventListener("change", async () => {
  const wanted = capture.checked;
  const settled = wanted
    ? await chrome.permissions.request(EVERYWHERE)
    : !(await chrome.permissions.remove(EVERYWHERE));
  if (settled !== wanted) capture.checked = settled;
  captureSaid.textContent = settled ? "reads every site" : "";
});

// Arriving from a crop that could not photograph the tab. The switch it was
// talking about is below the fold, so say which one it meant.
async function focusFromPanel() {
  const { focus } = await chrome.storage.session.get("focus");
  await chrome.storage.session.remove("focus");
  if (focus !== "capture") return;
  const card = capture.closest(".card");
  card.scrollIntoView({ block: "center", behavior: "smooth" });
  card.classList.add("flash");
}

// Asking for a host permission needs an extension page and a real click, and
// a content script has neither — hence the hand-off from the icon menu.
async function offerHostFromMenu() {
  const { pendingHost: host } = await chrome.storage.session.get("pendingHost");
  await chrome.storage.session.remove("pendingHost");
  if (!host) return;

  const origins = [patternFor(host)];
  const said = document.getElementById("offer-said");
  const grant = document.getElementById("grant");
  document.getElementById("offer-host").textContent = host;
  offer.hidden = false;

  if (await chrome.permissions.contains({ origins })) {
    said.textContent = "already covered";
    grant.remove();
    return;
  }

  grant.addEventListener("click", async () => {
    if (!(await chrome.permissions.request({ origins }))) {
      said.textContent = "not granted";
      return;
    }
    said.textContent = "added — reload the page";
    grant.remove();
  });
}

// Repaint from the event, not from the request resolving: the promise settles
// before Chrome commits the grant, so painting there left a stale list until
// reload. This also catches changes made in Chrome's own permissions UI.
function repaintOnPermissionChange() {
  chrome.runtime.sendMessage({ type: "sync-anchor-sites" }).catch(() => {}).finally(paint);
  paintCapture();
}
chrome.permissions.onAdded.addListener(repaintOnPermissionChange);
chrome.permissions.onRemoved.addListener(repaintOnPermissionChange);

chrome.storage.local.get("endpoint").then(({ endpoint }) => {
  document.getElementById("endpoint").value = endpoint || DEFAULT_ENDPOINT;
});

// A service somewhere else is a host the extension has no permission for, and
// the save click is the gesture that can ask for one. Asking here rather than
// at the first request keeps the failure at the moment you chose the address,
// where it is legible, instead of inside a snip that quietly returns nothing.
async function reach(value) {
  let origins;
  try {
    origins = [`${new URL(value).origin}/*`];
  } catch {
    return "not a URL";
  }
  // Straight to request, with no `contains` before it: an await spends the
  // click, and asking for something already granted resolves at once anyway.
  return (await chrome.permissions.request({ origins }))
    ? "saved"
    : "saved, but can't reach it";
}

document.getElementById("save").addEventListener("click", async () => {
  const said = document.getElementById("saved");
  const value = document.getElementById("endpoint").value.trim() || DEFAULT_ENDPOINT;
  said.textContent = await reach(value);
  if (said.textContent !== "not a URL") {
    await chrome.storage.local.set({ endpoint: value });
  }
  setTimeout(() => (said.textContent = ""), 2400);
});

paint();
paintCapture();
offerHostFromMenu();
focusFromPanel();
