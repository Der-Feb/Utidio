# Utidio

Utidio follows the rule “One plays. Others pause.” When media starts in one tab, it automatically pauses ordinary HTML audio and video in other tabs. Its popup lists playing and paused media tabs, lets you control playback and player mute state, and shows daily listening time.

## Install locally

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this project directory.
4. If Chrome asks, allow access to the sites where you want the extension to work. To inspect local files, enable **Allow access to file URLs** on the extension details page.

The extension also scans already-open, accessible tabs on install and whenever automatic pausing is enabled again. If more than one tab is already playing, it keeps the active tab playing when possible; otherwise it keeps the most recently observed playing tab. It does not automatically resume a tab when another one pauses or ends.

For new playback, Utidio records the media `play` intent before buffering completes. An explicit Play command in the popup has highest priority; otherwise a fresh intent in the active tab wins over delayed playback in a background tab. The later `playing` and tab-audible signals confirm playback but cannot let an older request take over.

Use **Mute** to mute page-visible media players without muting the whole Chrome tab. The popup labels media that is still running while muted. **Unmute** is an explicit request to hear that tab and takes priority over passive playback signals. Sites may control or override their media elements, and media without a page-visible audio/video element cannot be muted through the player.

The popup’s **Listening time** view shows daily wall-clock totals. Overlapping playback counts once, totals use the computer’s local date, and media titles are not stored in the history. The extension checkpoints an active listening interval about once a minute.

## Permissions

- `tabs` reads tab titles, URLs, favicons, audibility, and tab lifecycle events for the popup and playback coordination.
- `scripting` checks and controls media in open tabs, including tabs that were already open when the extension was installed or enabled.
- `storage` preserves the enabled setting and the current browser-session media list across service-worker restarts.
- `alarms` checkpoints listening time while media remains active, even when the service worker is idle.
- The `<all_urls>` content-script match allows detection and control on ordinary websites and embedded frames. Chrome-managed pages and other restricted pages cannot be inspected.

## Limits

Chrome reports whether a tab is audible, including sound from Web Audio and players that do not use a page-visible `<audio>` or `<video>` element. The extension can pause page-visible audio and video. When sound is detected but the page exposes no pausable media element, the extension reports that it could not control the player; it does not silently mute the tab.

The browser's audible flag is tab-wide, so Utidio cannot reliably identify which player produced a tab's sound. A tab may contain more than one player; popup controls currently act on the tab's page-visible media together. Utidio coordinates playback between tabs and does not arbitrate between players within one tab. A silent video may appear as playing in the popup, but it does not pause another tab or add listening time unless Chrome reports that the tab is audible.

Playback resumed from the popup may be blocked by a site’s autoplay policy. In that case, start playback from the page itself. Calls and other real-time audio are not automatically excluded; use the master switch when you do not want competing audio paused.

## Development checks

The project has no package manager or browser automation suite. Run the local package checks with:

```sh
node scripts/check-extension.mjs
```
