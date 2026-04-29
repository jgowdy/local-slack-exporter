# Local Slack Channel Exporter

Local Slack Channel Exporter is a small, local-only Chrome Manifest V3 extension for exporting the currently open Slack conversation or channel from `app.slack.com` to JSON.

It is intended for personal archival and LLM ingestion workflows where you want a local JSON file containing the visible conversation history, including thread replies nested under their parent messages.

## Privacy And Trust

This extension is designed to be readable, inspectable, and local.

- No backend service.
- No analytics.
- No OAuth flow.
- No broad web permissions.
- No remote code.
- No `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, or similar network exfiltration APIs.
- Export happens by creating a local `Blob` in the Slack tab and triggering a browser download.

The source is intentionally small and plain JavaScript/HTML so you can read it before loading it. The Chrome extension permissions are limited to:

- `activeTab`
- `scripting`
- `https://*.slack.com/*`

## Status

This is an early personal tool. Slack's web DOM is virtualized and changes over time, so scraping behavior may need adjustment. The extension includes a redacted DOM diagnostics export to help debug selector changes without sharing message text.

## Install From Source

Clone the repository:

```sh
git clone git@github.com:jgowdy/local-slack-exporter.git
cd local-slack-exporter
```

Load it in Chrome or a Chromium-based browser:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the cloned `local-slack-exporter` directory.
5. Pin or open the extension from the browser toolbar.

When files change locally, click the extension reload button on `chrome://extensions` before testing again.

## Usage

1. Open Slack in the browser at `app.slack.com`.
2. Open the conversation, DM, group DM, or channel you want to export.
3. Open the extension popup.
4. Adjust options if needed.
5. Click **Export current conversation**.

The extension first moves the message pane to the newest/bottom position without harvesting. It then walks upward through the conversation, collecting messages and thread replies as it encounters them.

Use **Stop and download partial export** if you want to stop early and keep a partial JSON file.

## Output Format

The downloaded JSON includes metadata plus a sorted `messages` array. Thread replies are nested directly under their parent message:

```json
{
  "messages": [
    {
      "ts": "1777311302.994279",
      "user": "Example User",
      "text": "Parent message text",
      "has_thread": true,
      "thread_reply_count": 2,
      "thread_replies": [
        {
          "ts": "1777311320.123456",
          "user": "Another User",
          "text": "Thread reply text"
        }
      ]
    }
  ]
}
```

Slack timestamps are used as stable message keys where available.

## Options

- **Include thread replies**: Opens visible thread parents and collects replies into `thread_replies`.
- **Scroll/click delay, ms**: Delay between automated scroll/click actions. Default is `500`.
- **Max conversation pages safety limit**: Upper bound to avoid spinning forever if Slack's DOM changes or scrolling gets stuck. Default is `10000`.
- **Stop after this many no-growth pages**: Stop condition for repeated pages that do not reveal new messages.

## Diagnostics

Click **Export DOM diagnostics** to download a redacted JSON snapshot of the current Slack DOM structure.

Diagnostics are meant for debugging selector changes. They include selector counts, candidate message elements, candidate scroll containers, chosen scroller details, and redacted HTML snippets.

The diagnostics redaction is designed to remove or hash message/user text and redact URLs/media sources, but you should still review the file before sharing it.

## Development

There is no build step. The unpacked extension consists of:

- `manifest.json`
- `popup.html`
- `popup.js`
- `content.js`

After editing files, reload the unpacked extension in `chrome://extensions`.

Useful checks before committing:

```sh
node --check content.js
node --check popup.js
rg -n "fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|chrome\\.identity|eval|Function\\(" manifest.json popup.html popup.js content.js
```

The grep should not find executable network/OAuth/eval APIs. It may match explanatory text in the popup.

## License

MIT. See [LICENSE](LICENSE).
