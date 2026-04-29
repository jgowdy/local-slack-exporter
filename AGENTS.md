# Local Slack Channel Exporter Agent Notes

## Project

Local Slack Channel Exporter is an original, fully local MV3 Chrome extension for exporting the currently open Slack channel from `app.slack.com` into local JSON suitable for LLM ingestion.

The extension must export main channel messages and thread replies without network exfiltration, OAuth, analytics, backend services, or remote code. Output is created only through a local Blob/download in the Slack tab.

This repository is the unpacked extension source. Edit these files directly and bump the patch version for every functional change so Chrome reloads are easy to verify. Do not create ZIPs or alternate generated extension copies unless explicitly requested.

## Files

- `manifest.json`
- `popup.html`
- `popup.js`
- `content.js`

## Constraints

- Intended as original personal GitHub work under MIT.
- Do not reference, copy, or attribute other Slack exporter projects.
- Keep the extension unpacked-extension friendly.
- Keep manifest permissions minimal:
  - `activeTab`
  - `scripting`
  - host permission: `https://*.slack.com/*`
  - Slack-only content script matches.
- No `fetch`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`, `EventSource`, `chrome.identity`, `eval`, or `Function(`.
- No OAuth, no analytics, no backend, no remote code.
- Use local Blob/download only.
- Keep scrolling and clicking human-ish with throttling and stop checks.

## Functional Design

- Popup injects/messages `content.js`.
- Content script scrapes Slack DOM.
- Export flow:
  - collect currently loaded messages
  - collect visible thread replies beside their parent messages as each page is encountered
  - scroll the main Slack virtual list upward to collect older history
  - scroll downward/newest-ward to collect newer history
- Message identity should primarily use Slack timestamps from:
  - `data-msg-ts`
  - `data-item-key`
  - `message-list_<ts>`
  - timestamp archive links
- Output JSON nests thread replies under the parent message:

```json
{
  "messages": [
    {
      "ts": "...",
      "user": "...",
      "text": "...",
      "thread_replies": [
        { "ts": "...", "user": "...", "text": "..." }
      ]
    }
  ]
}
```

## Slack DOM Findings

Main messages:

- `[data-qa="virtual-list-item"]`
- `[data-qa="message_container"]`
- `.c-virtual_list__item`
- `.c-message_kit__background`

Message text:

- `[data-qa="message-text"]`
- `.p-rich_text_section`

Sender:

- `[data-qa="message_sender"]`
- `[data-qa="message_sender_name"]`

Timestamp:

- `data-msg-ts`
- `data-item-key`
- `id="message-list_<ts>"`
- `a[href*="/archives/"][href*="p"]`

Thread indicator/click target:

- parent contains `[data-qa="reply_bar"]`
- reliable button observed as `button[data-qa="reply_bar_count"]`
- Slack may render reply bars/count controls as siblings of the normalized message body inside the virtual-list row, so thread discovery should inspect the enclosing `[data-qa="virtual-list-item"]` / `.c-virtual_list__item`, not only `[data-qa="message_container"]`.

Scroll container:

- `div[data-qa="slack_kit_scrollbar"].c-scrollbar__hider`
- There may be multiple Slack scrollbars. Choose the one with message descendants.

## Known Issues And Priorities

### Stop

- Stop button should never be disabled.
- Stop sends `LOCAL_SLACK_EXPORT_STOP`.
- Content script sets `stopRequested = true` and responds synchronously/quickly.
- Long loops must check `stopRequested` after every sleep, scroll, and click.
- On stop, export partial payload with `stopped_early: true`.

### Thread Capture

- Thread replies should be collected as parent messages are encountered, not only in a deferred full second pass.
- Final JSON should nest replies directly under their parent messages.
- Avoid storing DOM element references across major scrolls because Slack virtualizes/recycles nodes.
- In the thread pass, for each visible parent with a reply count/bar:
  - scroll parent into view
  - hover parent
  - wait two `requestAnimationFrame`s plus a short delay
  - click the exact reply count button/control
  - detect the thread pane
  - collect messages inside the thread pane
  - scroll the thread pane to collect replies
  - close the pane
  - attach replies to the parent message

Thread pane detection should consider:

- `[data-qa="thread_view"]`
- `[data-qa="thread_flexpane"]`
- `[data-qa*="thread" i]`
- `.p-threads_flexpane`
- `.p-flexpane`
- right-side containers with message descendants and close controls

### Scrolling

- Backscroll should use viewport/page-size jumps, not tiny nudges.
- Top-of-channel detection should combine:
  - no growth in message count
  - no new oldest timestamp
  - little/no change in scroll height
  - repeated no-movement passes
- Do not rely only on `scrollTop <= 2`.

### Status Logging

Keep status useful during a run:

- phase: collecting older history / collecting newer / collecting threads / stopping / done
- message count
- oldest/newest timestamp
- thread parents discovered/processed
- replies collected

### Diagnostics

Diagnostics export should remain useful and privacy-preserving:

- selector counts
- chosen scroller
- scrollable containers
- message candidates
- thread pane candidates
- redacted HTML snippets
- redact text/hash and URLs, but preserve structural selectors

Important redaction bugfix:

- Strip/replace `svg`, `img`, `picture`, `video`, `audio`, `canvas`, and `source` subtrees before redacting attributes.
- Do not truncate/mutate SVG path `d` attributes; that previously caused Chrome console errors.

## Release Audit

Before release or commit, run:

```sh
rg -n "fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|chrome\\.identity|eval|Function\\(" manifest.json popup.html popup.js content.js
node --check content.js
node --check popup.js
```

Expected: no outbound network/OAuth/eval APIs in executable code. The popup may contain explanatory text mentioning `fetch`.
