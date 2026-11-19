# Tab Audio Sentinel

Tab Audio Sentinel automatically pauses ordinary HTML audio and video in other tabs when playback starts. Its popup lists playing and paused media tabs and lets you resume or pause media, switch to a tab, and turn automatic pausing off or on.

## Install locally

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this project directory.
4. If Chrome asks, allow access to the sites where you want the extension to work. To inspect local files, enable **Allow access to file URLs** on the extension details page.

The extension also scans already-open, accessible tabs on install and whenever automatic pausing is enabled again. If more than one tab is already playing, it keeps the active tab playing when possible; otherwise it keeps the most recently observed playing tab. It does not automatically resume a tab when another one pauses or ends.

## Permissions

- `tabs` reads tab titles, URLs, favicons, audibility, and tab lifecycle events for the popup and playback coordination.
- `scripting` checks and controls media in open tabs, including tabs that were already open when the extension was installed or enabled.
- `storage` preserves the enabled setting and the current browser-session media list across service-worker restarts.
- The `<all_urls>` content-script match allows detection and control on ordinary websites and embedded frames. Chrome-managed pages and other restricted pages cannot be inspected.

## Limits

Chrome reports whether a tab is audible, including sound from Web Audio and players that do not use a page-visible `<audio>` or `<video>` element. The extension can pause page-visible audio and video. When sound is detected but the page exposes no pausable media element, the extension reports that it could not control the player; it does not silently mute the tab.

Playback resumed from the popup may be blocked by a site’s autoplay policy. In that case, start playback from the page itself. Calls and other real-time audio are not automatically excluded; use the master switch when you do not want competing audio paused.

## Development checks

The project has no package manager or browser automation suite. Run the local package checks with:

```sh
node scripts/check-extension.mjs
```
