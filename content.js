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
      chrome.runtime.sendMessage({ action: ACTIONS.MEDIA_UPDATE, ...status() }, () => {
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

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === ACTIONS.GET_MEDIA_STATUS) {
      sendResponse(status());
      return false;
    }
    if (message.action === ACTIONS.PAUSE) {
      mediaElements().forEach((element) => element.pause());
      report();
      sendResponse({ success: true });
      return false;
    }
    if (message.action === ACTIONS.RESUME) {
      const elements = mediaElements();
      Promise.allSettled(elements.map((element) => element.play())).then((results) => {
        report();
        const rejected = results.some((result) => result.status === 'rejected');
        sendResponse({
          success: !rejected,
          error: rejected ? 'Playback needs a user gesture on the page.' : undefined,
        });
      });
      return true;
    }
    return false;
  });

  // Register media that existed before the content script was injected.
  report();

  // Keep the popup metadata fresh on single-page app title and URL changes.
  const titleObserver = new MutationObserver(report);
  const titleElement = document.querySelector('title');
  if (titleElement) titleObserver.observe(titleElement, { childList: true, subtree: true, characterData: true });
  addEventListener('popstate', report);
  addEventListener('hashchange', report);
})();
