let activeTabId = null;
let activeMediaInfo = {};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : null;

  if (message.action === "MEDIA_PLAYING" && tabId) {
    // If a different tab starts playing, pause the previous one
    if (activeTabId !== null && activeTabId !== tabId) {
      chrome.tabs
        .sendMessage(activeTabId, { action: "FORCE_PAUSE" })
        .catch(() => {
          // Tab might be closed or navigated away
        });
    }

    activeTabId = tabId;
    activeMediaInfo[tabId] = {
      title: message.title,
      url: message.url,
      tabId: tabId,
      isPlaying: true,
    };
  }
});

// Clean up state if a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeTabId === tabId) {
    activeTabId = null;
  }
  delete activeMediaInfo[tabId];
});
