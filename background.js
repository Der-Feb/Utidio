let enabled = true;
let mediaTabs = {};
let activeTabId = null;
let ready;
let stateWrites = Promise.resolve();
let dailyListeningMs = {};
let listeningSince = null;
let activePriority = 0;
let activeIntentAt = 0;

importScripts('constants.js');
const ACTIONS = TAB_AUDIO_SENTINEL.actions;
const STORAGE_KEYS = TAB_AUDIO_SENTINEL.storageKeys;
const LISTENING_ALARM = TAB_AUDIO_SENTINEL.listeningAlarm;

function persistMediaTabs() {
  stateWrites = stateWrites
    .catch(() => {})
    .then(() => chrome.storage.session.set({ [STORAGE_KEYS.MEDIA_TABS]: mediaTabs }));
  return stateWrites;
}

async function initializeState() {
  const [settings, session] = await Promise.all([
    chrome.storage.local.get([STORAGE_KEYS.ENABLED, STORAGE_KEYS.DAILY_LISTENING]),
    chrome.storage.session.get([STORAGE_KEYS.MEDIA_TABS, 'listeningSince', 'winner']),
  ]);
  enabled = settings[STORAGE_KEYS.ENABLED] ?? true;
  dailyListeningMs = settings[STORAGE_KEYS.DAILY_LISTENING] ?? {};
  mediaTabs = session[STORAGE_KEYS.MEDIA_TABS] ?? {};
  listeningSince = session.listeningSince ?? null;
  if (session.winner?.tabId !== undefined) {
    activeTabId = session.winner.tabId;
    activePriority = session.winner.priority || 0;
    activeIntentAt = session.winner.intentAt || 0;
  }
  if (listeningSince !== null) chrome.alarms.create(LISTENING_ALARM, { periodInMinutes: 1 });
  const playing = Object.values(mediaTabs).filter(tabIsAudible);
  if (playing.length) {
    activeTabId = playing.reduce((latest, tab) =>
      (tab.lastPlayedAt || 0) > (latest.lastPlayedAt || 0) ? tab : latest,
    ).tabId;
  }
}

ready = initializeState().then(refreshOpenTabs);

function tabIsPlaying(tab) {
  if (!tab) return false;
  const frameIsPlaying = Object.values(tab.frames || {}).some((frame) => frame.isPlaying);
  return Boolean(tab.isAudible || frameIsPlaying);
}

// Page media can be in its playing state without producing sound (for example,
// a silent video). Only Chrome's tab-level audible signal may arbitrate tabs or
// contribute to listening time.
function tabIsAudible(tab) {
  if (!tab) return false;
  const suppressAudible = (tab.pauseRequestedUntil && Date.now() <= tab.pauseRequestedUntil)
    || (tab.muteRequestedUntil && Date.now() <= tab.muteRequestedUntil);
  const mediaIsPlaying = Object.values(tab.frames || {}).some((frame) => frame.isPlaying);
  if (suppressAudible && !mediaIsPlaying) return false;
  return Boolean(tab.isAudible);
}

function anyTabIsPlaying() {
  return Object.values(mediaTabs).some(tabIsAudible);
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addListeningInterval(totals, start, end) {
  let cursor = start;
  while (cursor < end) {
    const date = new Date(cursor);
    const nextDay = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
    const segmentEnd = Math.min(end, nextDay);
    const key = localDateKey(cursor);
    totals[key] = (totals[key] || 0) + segmentEnd - cursor;
    cursor = segmentEnd;
  }
}

async function syncListeningClock(timestamp = Date.now()) {
  const playing = anyTabIsPlaying();
  if (playing && listeningSince === null) {
    listeningSince = timestamp;
    await chrome.storage.session.set({ listeningSince });
    chrome.alarms.create(LISTENING_ALARM, { periodInMinutes: 1 });
  } else if (!playing && listeningSince !== null) {
    addListeningInterval(dailyListeningMs, listeningSince, timestamp);
    listeningSince = null;
    await Promise.all([
      chrome.storage.session.set({ listeningSince: null }),
      chrome.storage.local.set({ [STORAGE_KEYS.DAILY_LISTENING]: dailyListeningMs }),
    ]);
    chrome.alarms.clear(LISTENING_ALARM);
  }
}

async function checkpointListeningClock(timestamp = Date.now()) {
  if (!anyTabIsPlaying() || listeningSince === null) {
    await syncListeningClock(timestamp);
    return;
  }
  addListeningInterval(dailyListeningMs, listeningSince, timestamp);
  listeningSince = timestamp;
  await Promise.all([
    chrome.storage.session.set({ listeningSince }),
    chrome.storage.local.set({ [STORAGE_KEYS.DAILY_LISTENING]: dailyListeningMs }),
  ]);
}

function getListeningTotals(now = Date.now()) {
  const totals = { ...dailyListeningMs };
  if (listeningSince !== null) addListeningInterval(totals, listeningSince, now);
  return totals;
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
      isPlaybackRunning: false,
      hasMutedMedia: false,
      mutedByUtidio: 0,
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
  const tab = mediaTabs[String(tabId)];
  if (tab && bySentinel) {
    // Chrome's audible flag can lag a pause; don't let that stale signal
    // reactivate this tab while the browser catches up.
    tab.pauseRequestedUntil = Date.now() + 3000;
    tab.pausedBySentinel = true;
  }
  try {
    const response = await controlTabMedia(tabId, 'pause');
    if (!response.controlled) {
      if (tab) {
        delete tab.pauseRequestedUntil;
        tab.pausedBySentinel = false;
        tab.controlError = 'Sound detected, but this player cannot be paused by the extension.';
      }
      return false;
    }
  } catch (error) {
    if (tab) {
      delete tab.pauseRequestedUntil;
      tab.pausedBySentinel = false;
      tab.controlError = 'This tab cannot be controlled. Reload it and try again.';
    }
    return false;
  }
  if (tab) {
    tab.pausedBySentinel = bySentinel;
    Object.values(tab.frames).forEach((frame) => { frame.isPlaying = false; });
    refreshAggregate(tab);
    await syncListeningClock();
  }
}

async function controlTabMedia(tabId, command) {
  const frames = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: async (action) => {
      const elements = Array.from(document.querySelectorAll('audio, video'));
      globalThis.__utidioMutedMediaElements ||= new WeakSet();
      const mutedByUtidio = globalThis.__utidioMutedMediaElements;
      if (action === 'pause') {
        elements.forEach((element) => element.pause());
        return { controlled: elements.length > 0, success: true };
      }
      if (action === 'mute') {
        const targets = elements.filter((element) => !element.paused && !element.ended
          && !element.muted && element.volume > 0);
        targets.forEach((element) => {
          mutedByUtidio.add(element);
          element.muted = true;
        });
        return {
          controlled: targets.length > 0,
          success: targets.length > 0,
          error: targets.length ? undefined : 'No unmuted playing media was found in this tab.',
        };
      }
      if (action === 'unmute') {
        const targets = elements.filter((element) => element.muted);
        targets.forEach((element) => {
          mutedByUtidio.delete(element);
          element.muted = false;
        });
        return {
          controlled: targets.length > 0,
          success: targets.length > 0,
          error: targets.length ? undefined : 'No muted media was found in this tab.',
        };
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

async function activateTab(tabId, priorityOverride, intentAtOverride) {
  if (!enabled) return false;
  const tab = mediaTabs[String(tabId)];
  const priority = priorityOverride ?? (tab?.explicitPlayUntil > Date.now()
    ? 4
    : (tab?.playIntentPriority || 1));
  const intentAt = intentAtOverride ?? tab?.playIntentAt ?? Date.now();
  const winner = mediaTabs[String(activeTabId)];
  const winnerStillPlaying = tabIsAudible(winner);
  const isCurrentWinner = activeTabId === tabId;
  const takesPriority = isCurrentWinner || activeTabId === null || !winnerStillPlaying
    || priority > activePriority || (priority === activePriority && intentAt >= activeIntentAt);

  if (!takesPriority) {
    if (tabIsAudible(tab)) await pauseTab(tabId, true);
    return false;
  }

  if (!isCurrentWinner || priority > activePriority
    || (priority === activePriority && intentAt > activeIntentAt)) {
    activeTabId = tabId;
    activePriority = priority;
    activeIntentAt = intentAt;
    await chrome.storage.session.set({ winner: { tabId, priority, intentAt } });
  }
  for (const otherTab of Object.values(mediaTabs)) {
    if (otherTab.tabId !== tabId && tabIsAudible(otherTab)) await pauseTab(otherTab.tabId, true);
  }
  return true;
}

async function getTabPlayIntent(tabId) {
  const tab = mediaTabs[String(tabId)];
  if (tab?.explicitPlayUntil > Date.now()) {
    return { priority: 4, intentAt: tab.playIntentAt || Date.now() };
  }
  if (tab?.playIntentAt && Date.now() - tab.playIntentAt < 15 * 60 * 1000) {
    return { priority: tab.playIntentPriority || 1, intentAt: tab.playIntentAt };
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return { priority: active?.id === tabId ? 3 : 1, intentAt: Date.now() };
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
          isPlaybackRunning: elements.some((element) => !element.paused && !element.ended),
          hasMutedMedia: elements.some((element) => element.muted),
          mutedByUtidio: elements.filter((element) => element.muted
            && globalThis.__utidioMutedMediaElements?.has(element)).length,
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
        isPlaybackRunning: Boolean(current.isPlaybackRunning),
        hasMutedMedia: Boolean(current.hasMutedMedia),
        mutedByUtidio: Number(current.mutedByUtidio) || 0,
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
  const candidates = Object.values(mediaTabs).filter(tabIsAudible);
  if (enabled && candidates.length) {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const winner = candidates.find((tab) => tab.tabId === active?.id)
      || candidates.reduce((latest, tab) => (tab.lastPlayedAt || 0) > (latest.lastPlayedAt || 0) ? tab : latest);
    activeTabId = winner.tabId;
    activePriority = winner.tabId === active?.id ? 3 : (winner.playIntentPriority || 1);
    activeIntentAt = winner.playIntentAt || winner.lastPlayedAt || Date.now();
    for (const tab of candidates) {
      if (tab.tabId !== winner.tabId) await pauseTab(tab.tabId, true);
    }
    await chrome.storage.session.set({ winner: { tabId: activeTabId, priority: activePriority, intentAt: activeIntentAt } });
  }
  await syncListeningClock();
  await persistMediaTabs();
}

function refreshAggregate(tab) {
  const wasPlaying = tab.isPlaying;
  const frames = Object.values(tab.frames || {});
  tab.isPlaybackRunning = frames.some((frame) => frame.isPlaybackRunning);
  tab.hasMutedMedia = frames.some((frame) => frame.hasMutedMedia);
  tab.mutedByUtidio = frames.reduce((count, frame) => count + (frame.mutedByUtidio || 0), 0);
  tab.isPlaying = tabIsPlaying(tab);
  if (tab.isPlaying && !wasPlaying) tab.lastPlayedAt = Date.now();
  if (!tab.isPlaying && activeTabId === tab.tabId) {
    activeTabId = null;
    activePriority = 0;
    activeIntentAt = 0;
    void chrome.storage.session.set({ winner: null });
  }
}

async function handleMessage(message, sender) {
  await ready;
  if (message.action === ACTIONS.GET_STATUS) {
    return {
      enabled,
      mediaTabs: Object.values(mediaTabs),
      listeningByDay: getListeningTotals(),
    };
  }
  if (message.action === ACTIONS.SET_ENABLED) {
    enabled = Boolean(message.enabled);
    await chrome.storage.local.set({ [STORAGE_KEYS.ENABLED]: enabled });
    if (enabled) {
      await refreshOpenTabs();
      const candidates = Object.values(mediaTabs).filter(tabIsAudible)
        .sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (active && candidates.some((tab) => tab.tabId === active.id)) {
        candidates.sort((a, b) => Number(b.tabId === active.id) - Number(a.tabId === active.id));
      }
      activeTabId = candidates[0]?.tabId ?? null;
      activePriority = candidates.length ? (candidates[0].tabId === active?.id ? 3 : (candidates[0].playIntentPriority || 1)) : 0;
      activeIntentAt = candidates[0]?.playIntentAt || candidates[0]?.lastPlayedAt || 0;
      await chrome.storage.session.set({ winner: activeTabId === null ? null : { tabId: activeTabId, priority: activePriority, intentAt: activeIntentAt } });
      for (const tab of candidates.slice(1)) await pauseTab(tab.tabId, true);
    }
    await persistMediaTabs();
    return { success: true, enabled };
  }
  if (message.action === ACTIONS.PLAY_INTENT && sender.tab) {
    const tab = ensureTabRecord(sender.tab.id, sender.tab);
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab.playIntentAt = Date.now();
    tab.playIntentPriority = tab.explicitPlayUntil > Date.now()
      ? 4
      : (active?.id === sender.tab.id ? 3 : 2);
    tab.hasUserActivation = Boolean(message.hasUserActivation);
    if (enabled && tabIsAudible(tab)) {
      await activateTab(tab.tabId, tab.playIntentPriority, tab.playIntentAt);
    }
    await persistMediaTabs();
    return { success: true };
  }
  if (message.action === ACTIONS.MEDIA_UPDATE && sender.tab) {
    const tab = ensureTabRecord(sender.tab.id, sender.tab);
    const frameId = String(sender.frameId ?? 0);
    const prior = tab.frames[frameId] || {};
    tab.frames[frameId] = {
      hasMedia: Boolean(message.hasMedia),
      isPlaying: Boolean(message.isPlaying),
      isPlaybackRunning: Boolean(message.isPlaybackRunning),
      hasMutedMedia: Boolean(message.hasMutedMedia),
      mutedByUtidio: Number(message.mutedByUtidio) || 0,
      title: message.title || prior.title || '',
      url: message.url || prior.url || '',
      lastPlayedAt: message.isPlaying && !prior.isPlaying ? Date.now() : (prior.lastPlayedAt || 0),
    };
    refreshAggregate(tab);
    await syncListeningClock();
    const reportedPlaying = Boolean(message.isPlaying);
    if (reportedPlaying) {
      delete tab.pauseRequestedUntil;
      tab.pausedBySentinel = false;
      tab.controlError = '';
      tab.lastPlayedAt = Math.max(tab.lastPlayedAt || 0, tab.frames[frameId].lastPlayedAt || 0);
      if (enabled && tabIsAudible(tab)) {
        const intent = await getTabPlayIntent(tab.tabId);
        await activateTab(tab.tabId, intent.priority, intent.intentAt);
      }
    } else if (tab.pauseRequestedUntil && Date.now() > tab.pauseRequestedUntil) {
      delete tab.pauseRequestedUntil;
      tab.pausedBySentinel = false;
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
      const shouldPause = tabIsPlaying(tab);
      if (!shouldPause) tab.explicitPlayUntil = Date.now() + 5000;
      const result = await controlTabMedia(message.tabId, shouldPause ? 'pause' : 'resume');
      if (!result.controlled || !result.success) {
        if (tab) delete tab.explicitPlayUntil;
        return { success: false, error: result.error || tab?.controlError || 'This player cannot be controlled from the page.' };
      }
      if (!shouldPause) {
        tab.playIntentAt = Date.now();
        tab.playIntentPriority = 4;
        await activateTab(message.tabId);
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: 'This tab cannot be controlled. Reload it and try again.' };
    }
  }
  if (message.action === ACTIONS.SET_MEDIA_MUTED && Number.isInteger(message.tabId)) {
    const tab = mediaTabs[String(message.tabId)];
    const shouldMute = Boolean(message.muted);
    if (tab) tab.muteRequestedUntil = Date.now() + 3000;
    try {
      const result = await controlTabMedia(message.tabId, shouldMute ? 'mute' : 'unmute');
      if (!result.controlled || !result.success) {
        if (tab) delete tab.muteRequestedUntil;
        return { success: false, error: result.error || 'No controllable media player was found.' };
      }
      if (!shouldMute) {
        if (tab) {
          tab.explicitPlayUntil = Date.now() + 5000;
          tab.playIntentAt = Date.now();
          tab.playIntentPriority = 4;
        }
        await activateTab(message.tabId, 4, Date.now());
      }
      if (tab) await persistMediaTabs();
      return { success: true };
    } catch (error) {
      if (tab) delete tab.muteRequestedUntil;
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
    if (activeTabId === tabId) {
      activeTabId = null;
      activePriority = 0;
      activeIntentAt = 0;
      await chrome.storage.session.set({ winner: null });
    }
    await syncListeningClock();
    await persistMediaTabs();
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tabInfo) => {
  void ready.then(async () => {
    let tab = mediaTabs[String(tabId)];
    if (changeInfo.status === 'loading') {
      delete mediaTabs[String(tabId)];
      if (activeTabId === tabId) {
        activeTabId = null;
        activePriority = 0;
        activeIntentAt = 0;
        await chrome.storage.session.set({ winner: null });
      }
      await syncListeningClock();
      await persistMediaTabs();
      return;
    }
    if (!tab && changeInfo.audible) tab = ensureTabRecord(tabId, tabInfo);
    if (!tab) {
      if (changeInfo.status === 'complete') await syncOpenTab(tabInfo);
      await syncListeningClock();
      await persistMediaTabs();
      return;
    }
    if (changeInfo.audible !== undefined) {
      tab.isAudible = changeInfo.audible;
      if (!changeInfo.audible) delete tab.pauseRequestedUntil;
      refreshAggregate(tab);
      await syncListeningClock();
      const pauseIsPending = tab.pauseRequestedUntil && Date.now() <= tab.pauseRequestedUntil;
      if (changeInfo.audible && tabIsAudible(tab) && enabled && !pauseIsPending) {
        const intent = await getTabPlayIntent(tabId);
        await activateTab(tabId, intent.priority, intent.intentAt);
      }
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
      if (enabled && mediaTabs[String(tabId)]?.isPlaying) {
        const intent = await getTabPlayIntent(tabId);
        await activateTab(tabId, intent.priority, intent.intentAt);
      }
      await syncListeningClock();
      await persistMediaTabs();
    }
  });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void ready.then(async () => {
    const tab = mediaTabs[String(tabId)];
    if (enabled && tabIsAudible(tab)) {
      await activateTab(tabId, 3, Date.now());
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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LISTENING_ALARM) void ready.then(checkpointListeningClock);
});
