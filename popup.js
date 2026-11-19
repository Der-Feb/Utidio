(() => {
  const ACTIONS = TAB_AUDIO_SENTINEL.actions;
  const toggle = document.getElementById('masterToggle');
  const modeLabel = document.getElementById('mode-label');
  const notice = document.getElementById('notice');
  const playingList = document.getElementById('playing-list');
  const pausedList = document.getElementById('paused-list');

  let state = { enabled: true, mediaTabs: [] };

  function send(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        resolve(error ? { success: false, error: error.message } : response);
      });
    });
  }

  function setNotice(message = '') {
    notice.textContent = message;
  }

  async function refresh() {
    const response = await send({ action: ACTIONS.GET_STATUS });
    if (!response || response.success === false) {
      setNotice(response?.error || 'Could not read media status. Try reopening this popup.');
      return;
    }
    state = { enabled: response.enabled, mediaTabs: response.mediaTabs || [] };
    toggle.checked = state.enabled;
    render();
    setNotice('');
  }

  function makeEmpty(message) {
    const element = document.createElement('p');
    element.className = 'empty';
    element.textContent = message;
    return element;
  }

  function makeCard(tab) {
    const card = document.createElement('article');
    card.className = `card${tab.isPlaying ? ' is-playing' : ''}`;

    const title = tab.title || 'Untitled tab';
    let domain = 'Restricted or unavailable page';
    try {
      domain = new URL(tab.url).hostname || domain;
    } catch (error) {
      // Keep the safe fallback for browser-managed URLs.
    }

    if (tab.favIconUrl) {
      const icon = document.createElement('img');
      icon.className = 'favicon';
      icon.src = tab.favIconUrl;
      icon.alt = '';
      icon.addEventListener('error', () => {
        const fallback = document.createElement('span');
        fallback.className = 'favicon-fallback';
        fallback.textContent = domain.charAt(0).toUpperCase() || '♪';
        icon.replaceWith(fallback);
      }, { once: true });
      card.append(icon);
    } else {
      const fallback = document.createElement('span');
      fallback.className = 'favicon-fallback';
      fallback.textContent = domain.charAt(0).toUpperCase() || '♪';
      card.append(fallback);
    }

    const details = document.createElement('div');
    details.className = 'details';
    const titleElement = document.createElement('div');
    titleElement.className = 'title';
    titleElement.textContent = title;
    titleElement.title = title;
    const domainElement = document.createElement('div');
    domainElement.className = 'domain';
    domainElement.textContent = domain;
    domainElement.title = tab.url || '';
    const status = document.createElement('span');
    status.className = `status${tab.isPlaying ? '' : ' paused'}`;
    status.textContent = tab.isPlaying ? 'Playing' : (tab.pausedBySentinel ? 'Paused by Sentinel' : 'Paused');
    details.append(titleElement, domainElement, status);
    if (tab.controlError || (tab.isPlaying && !Object.values(tab.frames || {}).some((frame) => frame.hasMedia))) {
      const controlNote = document.createElement('div');
      controlNote.className = 'control-note';
      controlNote.textContent = tab.controlError || 'Sound is detected, but this page does not expose pausable media.';
      details.append(controlNote);
    }
    card.append(details);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const canControl = Object.values(tab.frames || {}).some((frame) => frame.hasMedia);
    const mediaButton = document.createElement('button');
    mediaButton.className = 'action-btn';
    mediaButton.type = 'button';
    mediaButton.textContent = tab.isPlaying ? 'Pause' : 'Play';
    mediaButton.setAttribute('aria-label', `${tab.isPlaying ? 'Pause' : 'Play'} media in ${title}`);
    mediaButton.disabled = !canControl;
    if (!canControl) mediaButton.title = 'This player cannot be controlled from the page.';
    mediaButton.addEventListener('click', async () => {
      mediaButton.disabled = true;
      const response = await send({ action: ACTIONS.TOGGLE_TAB, tabId: tab.tabId });
      const error = response?.success ? '' : (response?.error || 'Could not control media in that tab.');
      await refresh();
      if (error) setNotice(error);
      mediaButton.disabled = false;
    });

    const focusButton = document.createElement('button');
    focusButton.className = 'action-btn';
    focusButton.type = 'button';
    focusButton.textContent = 'Go';
    focusButton.setAttribute('aria-label', `Switch to ${title}`);
    focusButton.addEventListener('click', async () => {
      const response = await send({ action: ACTIONS.FOCUS_TAB, tabId: tab.tabId });
      if (!response?.success) setNotice(response?.error || 'Could not switch to that tab.');
    });
    actions.append(mediaButton, focusButton);
    card.append(actions);
    return card;
  }

  function render() {
    modeLabel.textContent = state.enabled ? 'Automatic pausing is on' : 'Automatic pausing is off';
    playingList.replaceChildren();
    pausedList.replaceChildren();

    const tabs = [...state.mediaTabs].sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
    const playing = tabs.filter((tab) => tab.isPlaying);
    const paused = tabs.filter((tab) => !tab.isPlaying && Object.values(tab.frames || {}).some((frame) => frame.hasMedia));

    if (playing.length) playing.forEach((tab) => playingList.append(makeCard(tab)));
    else playingList.append(makeEmpty('Nothing is playing right now.'));

    if (paused.length) paused.forEach((tab) => pausedList.append(makeCard(tab)));
    else pausedList.append(makeEmpty('Paused media tabs will appear here.'));
  }

  toggle.addEventListener('change', async () => {
    const desired = toggle.checked;
    toggle.disabled = true;
    const response = await send({ action: ACTIONS.SET_ENABLED, enabled: desired });
    toggle.disabled = false;
    if (!response?.success) {
      toggle.checked = state.enabled;
      setNotice(response?.error || 'Could not update the extension setting.');
      return;
    }
    state.enabled = response.enabled;
    setNotice('');
    render();
    await refresh();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'session' && changes.mediaTabs) {
      state.mediaTabs = Object.values(changes.mediaTabs.newValue || {});
      render();
    }
    if (areaName === 'local' && changes.enabled) {
      state.enabled = changes.enabled.newValue;
      toggle.checked = state.enabled;
      render();
    }
  });

  void refresh();
})();
