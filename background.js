let enabled = true;
let mediaTabs = {};
let activeTabId = null;
let ready;
let stateWrites = Promise.resolve();

importScripts('constants.js');
const ACTIONS = TAB_AUDIO_SENTINEL.actions;
const STORAGE_KEYS = TAB_AUDIO_SENTINEL.storageKeys;

function persistMediaTabs() {
  stateWrites = stateWrites
    .catch(() => {})
    .then(() => chrome.storage.session.set({ [STORAGE_KEYS.MEDIA_TABS]: mediaTabs }));
  return stateWrites;
}

async function initializeState() {
  const [settings, session] = await Promise.all([
    chrome.storage.local.get(STORAGE_KEYS.ENABLED),
    chrome.storage.session.get(STORAGE_KEYS.MEDIA_TABS),
  ]);
  enabled = settings[STORAGE_KEYS.ENABLED] ?? true;
  mediaTabs = session[STORAGE_KEYS.MEDIA_TABS] ?? {};
  const playing = Object.values(mediaTabs).filter((tab) => tab.isPlaying);
  if (playing.length) {
    activeTabId = playing.reduce((latest, tab) =>
      (tab.lastPlayedAt || 0) > (latest.lastPlayedAt || 0) ? tab : latest,
    ).tabId;
  }
}

ready = initializeState().then(refreshOpenTabs);

function tabIsPlaying(tab) {
  return Boolean(tab && (tab.isAudible || Object.values(tab.frames || {}).some((frame) => frame.isPlaying)));
}

function ensureTabRecord(tabId, tab = {}) {
  const key = String(tabId);
  if (!mediaTabs[key]) {
    mediaTabs[key] = {
      tabId,
      title: tab.title || 'Untitled media tab',
      url: tab.url || '',
      favIconUrl: tab.favIconUrl || '',
      isAudible: Boolean(tab.audible),
      isPlaying: Boolean(tab.audible),
      lastPlayedAt: 0,
      frames: {},
      pausedBySentinel: false,
    };
  } else {
    Object.assign(mediaTabs[key], {
      title: tab.title || mediaTabs[key].title,
      url: tab.url || mediaTabs[key].url,
      favIconUrl: tab.favIconUrl || mediaTabs[key].favIconUrl,
    });
  }
  return mediaTabs[key];
}

async function pauseTab(tabId, bySentinel = false) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: ACTIONS.PAUSE });
  } catch (error) {
    // The tab may not have an accessible content script. Its audibility is
    // still tracked, but Chrome does not expose a general pause command.
  }
  const tab = mediaTabs[String(tabId)];
  if (tab) {
    tab.isAudible = false;
    tab.isPlaying = false;
    tab.pausedBySentinel = bySentinel;
    Object.values(tab.frames).forEach((frame) => { frame.isPlaying = false; });
  }
}

async function activateTab(tabId) {
  if (!enabled) return;
  const previousId = activeTabId;
  activeTabId = tabId;
  if (previousId !== null && previousId !== tabId) {
    await pauseTab(previousId, true);
  }
  for (const tab of Object.values(mediaTabs)) {
    if (tab.tabId !== tabId && tabIsPlaying(tab)) await pauseTab(tab.tabId, true);
  }
}

function isInjectableUrl(url = '') {
  return /^(https?|file):\/\//i.test(url);
}

async function syncOpenTab(tabInfo) {
  if (!tabInfo?.id || !isInjectableUrl(tabInfo.url)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabInfo.id, allFrames: true },
      files: ['constants.js', 'content.js'],
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabInfo.id, allFrames: true },
      func: () => {
        const elements = Array.from(document.querySelectorAll('audio, video'));
        return {
          hasMedia: elements.length > 0,
          isPlaying: elements.some((element) => !element.paused && !element.ended && !element.muted && element.volume > 0),
          title: document.title,
          url: location.href,
        };
      },
    });
    const tab = ensureTabRecord(tabInfo.id, tabInfo);
    tab.isAudible = Boolean(tabInfo.audible);
    for (const result of results) {
      if (!result || result.frameId === undefined || !result.result) continue;
      const key = String(result.frameId);
      const prior = tab.frames[key] || {};
      const current = result.result;
      tab.frames[key] = {
        hasMedia: Boolean(current.hasMedia),
        isPlaying: Boolean(current.isPlaying),
        title: current.title || '',
        url: current.url || '',
        lastPlayedAt: current.isPlaying ? (prior.lastPlayedAt || Date.now()) : (prior.lastPlayedAt || 0),
      };
    }
    refreshAggregate(tab);
    if (tab.isPlaying && !tab.lastPlayedAt) tab.lastPlayedAt = Date.now();
    if (!tab.isPlaying && !Object.values(tab.frames).some((frame) => frame.hasMedia)) {
      delete mediaTabs[String(tabInfo.id)];
    }
  } catch (error) {
    // Chrome-managed and restricted pages cannot be inspected or injected.
  }
}

async function refreshOpenTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) await syncOpenTab(tab);
  const candidates = Object.values(mediaTabs).filter(tabIsPlaying);
  if (enabled && candidates.length > 1) {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const winner = candidates.find((tab) => tab.tabId === active?.id)
      || candidates.reduce((latest, tab) => (tab.lastPlayedAt || 0) > (latest.lastPlayedAt || 0) ? tab : latest);
    activeTabId = winner.tabId;
    for (const tab of candidates) {
      if (tab.tabId !== winner.tabId) await pauseTab(tab.tabId, true);
    }
  } else if (candidates.length) {
    activeTabId = candidates[0].tabId;
  }
  await persistMediaTabs();
}

function refreshAggregate(tab) {
  const wasPlaying = tab.isPlaying;
  tab.isPlaying = tabIsPlaying(tab);
  if (tab.isPlaying && !wasPlaying) tab.lastPlayedAt = Date.now();
  if (!tab.isPlaying && activeTabId === tab.tabId) activeTabId = null;
}

async function handleMessage(message, sender) {
  await ready;
  if (message.action === ACTIONS.GET_STATUS) {
    return { enabled, mediaTabs: Object.values(mediaTabs) };
  }
  if (message.action === ACTIONS.SET_ENABLED) {
    enabled = Boolean(message.enabled);
    await chrome.storage.local.set({ [STORAGE_KEYS.ENABLED]: enabled });
    if (enabled) {
      await refreshOpenTabs();
      const candidates = Object.values(mediaTabs).filter(tabIsPlaying)
        .sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (active && candidates.some((tab) => tab.tabId === active.id)) {
        candidates.sort((a, b) => Number(b.tabId === active.id) - Number(a.tabId === active.id));
      }
      activeTabId = candidates[0]?.tabId ?? null;
      for (const tab of candidates.slice(1)) await pauseTab(tab.tabId, true);
    }
    await persistMediaTabs();
    return { success: true, enabled };
  }
  if (message.action === ACTIONS.MEDIA_UPDATE && sender.tab) {
    const tab = ensureTabRecord(sender.tab.id, sender.tab);
    const frameId = String(sender.frameId ?? 0);
    const prior = tab.frames[frameId] || {};
    tab.frames[frameId] = {
      hasMedia: Boolean(message.hasMedia),
      isPlaying: Boolean(message.isPlaying),
      title: message.title || prior.title || '',
      url: message.url || prior.url || '',
      lastPlayedAt: message.isPlaying && !prior.isPlaying ? Date.now() : (prior.lastPlayedAt || 0),
    };
    refreshAggregate(tab);
    if (tab.isPlaying) {
      tab.lastPlayedAt = Math.max(tab.lastPlayedAt || 0, tab.frames[frameId].lastPlayedAt || 0);
      if (enabled) await activateTab(tab.tabId);
    }
    if (!tab.isPlaying && !tab.isAudible && !Object.values(tab.frames).some((frame) => frame.hasMedia)) {
      delete mediaTabs[String(tab.tabId)];
    }
    await persistMediaTabs();
    return { success: true };
  }
  if (message.action === ACTIONS.TOGGLE_TAB && Number.isInteger(message.tabId)) {
    const tab = mediaTabs[String(message.tabId)];
    try {
      await chrome.tabs.sendMessage(message.tabId, {
        action: tabIsPlaying(tab) ? ACTIONS.PAUSE : ACTIONS.RESUME,
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: 'This tab cannot be controlled. Reload it and try again.' };
    }
  }
  if (message.action === ACTIONS.FOCUS_TAB && Number.isInteger(message.tabId)) {
    await chrome.tabs.update(message.tabId, { active: true });
    const tab = await chrome.tabs.get(message.tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    return { success: true };
  }
  return { success: false, error: 'Unknown action.' };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ success: false, error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void ready.then(async () => {
    delete mediaTabs[String(tabId)];
    if (activeTabId === tabId) activeTabId = null;
    await persistMediaTabs();
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tabInfo) => {
  void ready.then(async () => {
    let tab = mediaTabs[String(tabId)];
    if (changeInfo.status === 'loading') {
      delete mediaTabs[String(tabId)];
      if (activeTabId === tabId) activeTabId = null;
      await persistMediaTabs();
      return;
    }
    if (!tab && changeInfo.audible) tab = ensureTabRecord(tabId, tabInfo);
    if (!tab) {
      if (changeInfo.status === 'complete') await syncOpenTab(tabInfo);
      await persistMediaTabs();
      return;
    }
    if (changeInfo.audible !== undefined) {
      tab.isAudible = changeInfo.audible;
      refreshAggregate(tab);
      if (tab.isPlaying && enabled) await activateTab(tabId);
      await persistMediaTabs();
    }
    if (changeInfo.title || changeInfo.favIconUrl || changeInfo.url) {
      Object.assign(tab, {
        title: tabInfo.title || tab.title,
        url: tabInfo.url || tab.url,
        favIconUrl: tabInfo.favIconUrl || tab.favIconUrl,
      });
      await persistMediaTabs();
    }
    if (changeInfo.status === 'complete') {
      await syncOpenTab(tabInfo);
      if (enabled && mediaTabs[String(tabId)]?.isPlaying) await activateTab(tabId);
      await persistMediaTabs();
    }
  });
});

chrome.runtime.onInstalled.addListener(() => {
  void ready.then(refreshOpenTabs);
});

chrome.runtime.onStartup.addListener(() => {
  void ready.then(refreshOpenTabs);
});
