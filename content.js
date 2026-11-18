// Monitor all media elements on the page
document.addEventListener(
  "play",
  (event) => {
    const target = event.target;
    if (target.tagName === "VIDEO" || target.tagName === "AUDIO") {
      // Notify background script that this tab/element started playing
      chrome.runtime.sendMessage({
        action: "MEDIA_PLAYING",
        title: document.title,
        url: window.location.href,
      });
    }
  },
  true,
);

// Listen for commands from the background worker to pause playback
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "FORCE_PAUSE") {
    const mediaElements = document.querySelectorAll("video, audio");
    mediaElements.forEach((el) => el.pause());
  }
});
