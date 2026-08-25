const field = document.getElementById("endpoint");
const saved = document.getElementById("saved");

chrome.storage.local.get("endpoint").then(({ endpoint }) => {
  field.value = endpoint || "http://localhost:8765";
});

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ endpoint: field.value.trim() });
  saved.textContent = "saved";
  setTimeout(() => (saved.textContent = ""), 1500);
});
