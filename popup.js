// Request active streams from background or query tabs directly via Chrome API
chrome.tabs.query({}, (tabs) => {
  const container = document.getElementById("stream-list");
  container.innerHTML = "";

  // Filter tabs that have active audio indicators using Chrome's built-in audio API
  const audioTabs = tabs.filter((tab) => tab.audible);

  if (audioTabs.length === 0) {
    container.innerHTML = '<div class="card">No active audio playing.</div>';
    return;
  }

  audioTabs.forEach((tab) => {
    const div = document.createElement("div");
    div.className = "card";
    div.innerHTML = `<div class="title">${tab.title}</div><div style="color: #94a3b8; font-size: 10px;">Tab ID: ${tab.id}</div>`;
    container.appendChild(div);
  });
});
