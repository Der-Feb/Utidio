(() => {
  if (window.__tabAudioSentinelInstalled) return;
  window.__tabAudioSentinelInstalled = true;

  function mediaElements() {
    return Array.from(document.querySelectorAll('audio, video'));
  }

  function isPlaying(element) {
    return !element.paused && !element.ended && !element.muted && element.volume > 0;
  }

  function status() {
    const elements = mediaElements();
    return {
      hasMedia: elements.length > 0,
      isPlaying: elements.some(isPlaying),
      title: document.title,
      url: location.href,
    };
  }

  function report() {
    try {
      if (!chrome.runtime?.id) return;
      chrome.runtime.sendMessage({ action: TAB_AUDIO_SENTINEL.actions.MEDIA_UPDATE, ...status() }, () => {
        // Accessing lastError consumes the expected error after extension reload.
        void chrome.runtime.lastError;
      });
    } catch (error) {
      // The page may outlive an extension update.
    }
  }

  document.addEventListener('playing', report, true);
  for (const eventName of ['pause', 'ended', 'volumechange', 'emptied']) {
    document.addEventListener(eventName, report, true);
  }

  // Register media that existed before the content script was injected.
  report();

  // Keep the popup metadata fresh on single-page app title and URL changes.
  const titleObserver = new MutationObserver((records) => {
    if (records.some((record) => record.target.nodeName === 'TITLE'
      || Array.from(record.addedNodes).some((node) => node.nodeName === 'TITLE'))) report();
  });
  if (document.documentElement) titleObserver.observe(document.documentElement, {
    childList: true, subtree: true, characterData: true,
  });
  addEventListener('popstate', report);
  addEventListener('hashchange', report);

  const mediaObserver = new MutationObserver((records) => {
    const mediaWasAdded = records.some((record) => Array.from(record.addedNodes).some((node) =>
      node.nodeName === 'AUDIO' || node.nodeName === 'VIDEO' || node.querySelector?.('audio, video')));
    if (mediaWasAdded) report();
  });
  if (document.documentElement) mediaObserver.observe(document.documentElement, {
    childList: true, subtree: true,
  });
})();
