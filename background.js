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
    const response = await controlTabMedia(tabId, 'pause');
    if (!response.controlled) {
      const tab = mediaTabs[String(tabId)];
      if (tab) tab.controlError = 'Sound detected, but this player cannot be paused by the extension.';
      return false;
    }
  } catch (error) {
    const tab = mediaTabs[String(tabId)];
    if (tab) tab.controlError = 'This tab cannot be controlled. Reload it and try again.';
    return false;
  }
  const tab = mediaTabs[String(tabId)];
  if (tab) {
    tab.pausedBySentinel = bySentinel;
    Object.values(tab.frames).forEach((frame) => { frame.isPlaying = false; });
    refreshAggregate(tab);
  }
}

async function controlTabMedia(tabId, command) {
  const frames = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: async (action) => {
      const elements = Array.from(document.querySelectorAll('audio, video'));
      if (action === 'pause') {
        elements.forEach((element) => element.pause());
        return { controlled: elements.length > 0, success: true };
      }
      const results = await Promise.allSettled(elements.map((element) => element.play()));
      return {
        controlled: elements.length > 0,
        success: elements.length > 0 && results.every((result) => result.status === 'fulfilled'),
        error: results.some((result) => result.status === 'rejected')
          ? 'Playback needs a user gesture on the page.' : undefined,
      };
    },
    args: [command],
  });
  const answers = frames.map((frame) => frame.result).filter(Boolean);
  return {
    controlled: answers.some((answer) => answer.controlled),
    success: answers.some((answer) => answer.controlled && answer.success),
    error: answers.find((answer) => answer.error)?.error,
  };
}

async function activateTab(tabId) {
  if (!enabled) return;
  const previousId = activeTabId;
  activeTabId = tabId;
  if (previousId !== null && previousId !== tabId) {
    await pauseTab(previousId, true);
  }
  for (const tab of Object.values(mediaTabs)) {
    if (tab.tabId !== tabId && tab.tabId !== previousId && tabIsPlaying(tab)) await pauseTab(tab.tabId, true);
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
    const priorFrames = tab.frames;
    tab.frames = {};
    for (const result of results) {
      if (!result || result.frameId === undefined || !result.result) continue;
      const key = String(result.frameId);
      const prior = priorFrames[key] || {};
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
      tab.pausedBySentinel = false;
      tab.controlError = '';
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
      const result = await controlTabMedia(message.tabId, tabIsPlaying(tab) ? 'pause' : 'resume');
      if (!result.controlled || !result.success) {
        return { success: false, error: result.error || tab?.controlError || 'This player cannot be controlled from the page.' };
      }
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
      if (!tab.isPlaying && !Object.values(tab.frames).some((frame) => frame.hasMedia)) {
        delete mediaTabs[String(tabId)];
      }
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
