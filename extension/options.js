const DEFAULT_ENDPOINT = "http://localhost:8765";

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

// The manifest's own localhost grants land in permissions.getAll() too; they
// are the service, not a site the button belongs on.
const isSite = (origin) => !/localhost|127\.0\.0\.1/.test(origin);
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
    empty.textContent = "No sites. Open one and right-click the toolbar icon to add it.";
    list.append(empty);
    return;
  }
  for (const origin of origins) list.append(siteRow(origin, !off.includes(origin)));
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
    said.textContent = "added — reload the page to see it";
    grant.remove();
  });
}

// Repaint from the event, not from the request resolving: the promise settles
// before Chrome commits the grant, so painting there left a stale list until
// reload. This also catches changes made in Chrome's own permissions UI.
function repaintOnPermissionChange() {
  chrome.runtime.sendMessage({ type: "sync-anchor-sites" }).catch(() => {}).finally(paint);
}
chrome.permissions.onAdded.addListener(repaintOnPermissionChange);
chrome.permissions.onRemoved.addListener(repaintOnPermissionChange);

chrome.storage.local.get("endpoint").then(({ endpoint }) => {
  document.getElementById("endpoint").value = endpoint || DEFAULT_ENDPOINT;
});

document.getElementById("save").addEventListener("click", async () => {
  const said = document.getElementById("saved");
  const value = document.getElementById("endpoint").value.trim();
  await chrome.storage.local.set({ endpoint: value || DEFAULT_ENDPOINT });
  said.textContent = "saved";
  setTimeout(() => (said.textContent = ""), 1600);
});

paint();
offerHostFromMenu();
