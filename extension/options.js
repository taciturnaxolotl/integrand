const field = document.getElementById("endpoint");
const saved = document.getElementById("saved");
const sites = document.getElementById("sites");
const offer = document.getElementById("offer");
const grant = document.getElementById("grant");
const granted = document.getElementById("granted");

const DEFAULT_ENDPOINT = "http://localhost:8765";

//: The manifest's own localhost grants show up here too; they are the service,
//: not a site the button belongs on.
const isSite = (origin) => !/localhost|127\.0\.0\.1/.test(origin);
const pattern = (host) => `*://${host}/*`;
const hostOf = (origin) => origin.replace(/^\*:\/\//, "").replace(/\/\*$/, "");

chrome.storage.local.get("endpoint").then(({ endpoint }) => {
  field.value = endpoint || DEFAULT_ENDPOINT;
});

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ endpoint: field.value.trim() || DEFAULT_ENDPOINT });
  saved.textContent = "saved";
  setTimeout(() => (saved.textContent = ""), 1500);
});

async function paintSites() {
  const all = await chrome.permissions.getAll();
  const origins = (all.origins ?? []).filter(isSite).sort();

  sites.replaceChildren();
  if (!origins.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "None yet — add one from the right-click menu on any page.";
    sites.append(empty);
    return;
  }

  for (const origin of origins) {
    const row = document.createElement("li");
    const name = document.createElement("code");
    name.textContent = hostOf(origin);
    const remove = document.createElement("button");
    remove.className = "quiet";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      await chrome.permissions.remove({ origins: [origin] });
      await chrome.runtime.sendMessage({ type: "sync-anchor-sites" });
      paintSites();
    });
    row.append(name, remove);
    sites.append(row);
  }
}

//: Asking for a host permission needs an extension page and a real click.
//: A content script has neither, which is why the right-click menu sends the
//: host here rather than requesting it where the user was standing.
async function offerCurrentHost() {
  const host = new URLSearchParams(location.search).get("host");
  if (!host) return;

  const origins = [pattern(host)];
  if (await chrome.permissions.contains({ origins })) {
    granted.textContent = `already on for ${host}`;
    offer.hidden = false;
    grant.hidden = true;
    return;
  }

  grant.textContent = `Show the button on ${host}`;
  offer.hidden = false;
  grant.addEventListener("click", async () => {
    const allowed = await chrome.permissions.request({ origins });
    if (!allowed) {
      granted.textContent = "not granted";
      return;
    }
    await chrome.runtime.sendMessage({ type: "sync-anchor-sites" });
    granted.textContent = "on — reload the page to see it";
    grant.hidden = true;
    paintSites();
  });
}

paintSites();
offerCurrentHost();
