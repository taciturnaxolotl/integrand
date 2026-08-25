const DEFAULT_ENDPOINT = "http://localhost:8765";

//: Suggestions only — nothing here is granted until it is clicked. Chosen
//: because the page reader can already read them exactly: WebAssign's watex,
//: and KaTeX or MathJax everywhere else.
const SUGGESTED = [
  { origin: "*://*.webassign.net/*", note: "watex, read exactly" },
  { origin: "*://*.myopenmath.com/*", note: "MathJax" },
  { origin: "*://*.instructure.com/*", note: "Canvas" },
  { origin: "*://*.deltamath.com/*", note: "" },
  { origin: "*://*.gradescope.com/*", note: "" },
  { origin: "*://*.khanacademy.org/*", note: "KaTeX" },
  { origin: "*://en.wikipedia.org/*", note: "LaTeX in image alt text" },
  { origin: "*://math.stackexchange.com/*", note: "MathJax" },
  { origin: "*://openstax.org/*", note: "MathML" },
];

//: The manifest's own localhost grants land in permissions.getAll() too; they
//: are the service, not a site the button belongs on.
const isSite = (origin) => !/localhost|127\.0\.0\.1/.test(origin);
const label = (origin) => origin.replace(/^\*:\/\//, "").replace(/\/\*$/, "");
const patternFor = (host) => `*://${host}/*`;

const enabledCard = document.getElementById("enabled");
const suggestedCard = document.getElementById("suggested");
const offer = document.getElementById("offer");

function row(origin, note, action) {
  const line = document.createElement("div");
  line.className = "site";

  const host = document.createElement("span");
  host.className = "host";
  host.textContent = label(origin);

  line.append(host);
  if (note) {
    const hint = document.createElement("span");
    hint.className = "note";
    hint.textContent = note;
    line.append(hint);
  }
  line.append(action);
  return line;
}

function actionButton(text, quiet, onClick) {
  const button = document.createElement("button");
  button.textContent = text;
  if (quiet) button.className = "quiet";
  button.addEventListener("click", onClick);
  return button;
}

async function resync() {
  await chrome.runtime.sendMessage({ type: "sync-anchor-sites" });
  paint();
}

async function paint() {
  const all = await chrome.permissions.getAll();
  const granted = (all.origins ?? []).filter(isSite).sort();

  enabledCard.replaceChildren();
  if (!granted.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No sites yet. Add one below, or right-click the toolbar icon on any page.";
    enabledCard.append(empty);
  } else {
    for (const origin of granted) {
      enabledCard.append(
        row(origin, "", actionButton("Remove", true, async () => {
          await chrome.permissions.remove({ origins: [origin] });
          resync();
        }))
      );
    }
  }

  const remaining = SUGGESTED.filter((s) => !granted.includes(s.origin));
  suggestedCard.replaceChildren();
  if (!remaining.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "All of them are on.";
    suggestedCard.append(empty);
    return;
  }
  for (const { origin, note } of remaining) {
    suggestedCard.append(
      row(origin, note, actionButton("Add", true, async () => {
        if (await chrome.permissions.request({ origins: [origin] })) resync();
      }))
    );
  }
}

//: Asking for a host permission needs an extension page and a real click. A
//: content script has neither, which is why the icon menu sends the host here
//: rather than requesting it where you were standing.
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
    said.textContent = "already on";
    grant.remove();
    return;
  }

  grant.addEventListener("click", async () => {
    if (!(await chrome.permissions.request({ origins }))) {
      said.textContent = "not granted";
      return;
    }
    said.textContent = "on — reload the page";
    grant.remove();
    resync();
  });
}

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
