# chrome-no-focus-relay

Stop [agent-browser](https://github.com/vercel-labs/agent-browser) from
stealing focus. A small Chrome DevTools Protocol (CDP) relay that lets an AI
agent drive your headed, signed-in Chrome without pulling the Chrome window in
front of whatever you are doing.

The relay sits between the agent and Chrome. It opens new tabs in the
background, drops the commands that bring Chrome to the front
(`Page.bringToFront`, `Target.activateTarget`), and turns on focus emulation so
background tabs still accept clicks. Everything else passes through unchanged,
and several agent sessions can share one relay.

Use it if you see any of these with agent-browser `--cdp` on macOS:

- `agent-browser tab new` brings Chrome to the front.
- Switching tabs (`agent-browser tab <ref>`) brings Chrome to the front.
- Every agent session that attaches to Chrome makes it jump in front once.
- What you type ends up in the browser while Claude Code, Codex or another
  agent is browsing.

It works with any CDP client that connects through the relay. Only
agent-browser 0.43.0 has been tested.

## Usage

1. Start Chrome with remote debugging and a non-default profile directory.
   Chrome refuses remote debugging on its default data directory. The last
   three flags stop Chrome from slowing down tabs in a window that sits behind
   other apps:

   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --user-data-dir="$HOME/agent-chrome-profile" \
     --remote-debugging-port=9222 \
     --disable-backgrounding-occluded-windows \
     --disable-renderer-backgrounding \
     --disable-background-timer-throttling
   ```

2. Start the relay where agent-browser runs. Requires Node.js 18 or later;
   `npx` (or `pnpm dlx`) fetches the relay on first run:

   ```bash
   # Chrome on the same machine
   npx chrome-no-focus-relay --upstream 127.0.0.1:9222 --focus-emulation all

   # agent-browser in a container (Docker Desktop), Chrome on the host
   npx chrome-no-focus-relay --upstream host.docker.internal:9222 --focus-emulation all
   ```

   Use `--focus-emulation all` when this Chrome is only used by agents. The
   default, `created`, only covers tabs opened through the relay since it
   started, so tabs that already existed, or that survived a relay restart,
   would not get it. Do not use `all` on a Chrome you also browse with: pages
   such as chat apps would then believe they are focused.

3. Point agent-browser at the relay, not at Chrome. Use `--cdp`, not
   `--auto-connect`, which looks for Chrome on its own and may bypass the
   relay:

   ```bash
   agent-browser --session agent1 --cdp http://127.0.0.1:9223 --pin-tab open https://example.com
   ```

   Use one `--session` per agent and `--pin-tab` so sessions do not take over
   each other's tab.

### Options

| Flag | Env | Default |
|---|---|---|
| `--listen host:port` | `RELAY_LISTEN` | `127.0.0.1:9223` |
| `--upstream host:port` | `RELAY_UPSTREAM` | `host.docker.internal:9222` |
| `--focus-emulation created\|all\|off` | `RELAY_FOCUS_EMULATION` | `created` |
| `--verbose` | | off, logs every rewritten or swallowed command |

`kill -USR1 <pid>` prints counters (tabs created, commands swallowed, sessions
given focus emulation). They are also printed on exit.

### Other ways to run it

```bash
# pnpm
pnpm dlx chrome-no-focus-relay --upstream 127.0.0.1:9222

# latest commit from GitHub instead of the npm release
npx github:anthonylau/chrome-no-focus-relay --upstream 127.0.0.1:9222
```

## Known limits

- If Chrome has no window open, a new tab may open a new window, and that can
  bring Chrome to the front. Keep one Chrome window open. It can sit behind
  your other apps or on another Space.
- A tab that Chrome discarded (Memory Saver) cannot be revived, because the
  relay swallows `Target.activateTarget`. agent-browser then reports
  `did not recover after activation`. Open a new tab with `tab new`.
- A background tab does not run `requestAnimationFrame`, so pages that draw in
  an animation loop (canvas, some charts) stay at their first frame. To watch
  the agent, click its tab in the Chrome window.
- HTTP `/json/new` is forwarded unchanged and still opens a foreground tab.
  agent-browser does not use it.
- `open -a "Google Chrome"` or AppleScript `activate` bring Chrome forward
  without going through CDP. The relay cannot stop those.
- No authentication. Anyone who can reach the listen address controls a
  signed-in browser. Keep it on `127.0.0.1`.

## Development

```bash
git clone https://github.com/anthonylau/chrome-no-focus-relay.git
cd chrome-no-focus-relay
npm install
npm test
```

`npm test` runs `test/smoke.sh`: a throwaway headless Chromium behind the
relay, driven by agent-browser. It checks that a click reaches the page, a
screenshot is written, `Target.createTarget` is rewritten, `Page.bringToFront`
is swallowed, focus emulation is enabled, and Chrome accepts every command the
relay sends on its own. It needs `chromium` (or `CHROME=/path/to/chrome`) and
`agent-browser` on `PATH`.

Headless Chrome has no window, so the smoke test cannot show focus behavior.
On macOS, run `test/mac-focus-watch.sh` while an agent opens and switches
tabs. It prints every change of the frontmost app. Chrome should not appear
unless you click it.

## Related issues

agent-browser has no built-in background mode yet. These track it:

- [vercel-labs/agent-browser#1247](https://github.com/vercel-labs/agent-browser/issues/1247): background mode to prevent stealing focus when connected to an already-running Chrome. The comments describe the CDP rewrites this relay implements.
- [vercel-labs/agent-browser#1695](https://github.com/vercel-labs/agent-browser/pull/1695): create tabs in the background and drop the implicit `bringToFront`.
- [vercel-labs/agent-browser#1880](https://github.com/vercel-labs/agent-browser/pull/1880): rebase of #1695 that also exposes a `bringtofront` command.
- [vercel-labs/agent-browser#1427](https://github.com/vercel-labs/agent-browser/pull/1427): `tab new --background` plus focus emulation.

A related report from another CDP client:

- [ChromeDevTools/chrome-devtools-mcp#1254](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1254): Chrome stealing focus on every CDP command on macOS. Closed by [puppeteer/puppeteer#14922](https://github.com/puppeteer/puppeteer/pull/14922), which stopped Puppeteer from reopening DevTools. agent-browser does not open DevTools, so that fix does not apply to it.

## License

MIT. See [LICENSE](LICENSE).
