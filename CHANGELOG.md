# Changelog

## 0.5.8: sites can be added from another computer, and open sessions see them

- **A running router now picks up registry changes on its next tool call.** It
  read `sites.json` once at start, so a site connected from another shell
  stayed invisible until the MCP client restarted the server. T3 Code's
  `/mcp` reconnect did not restart the router a session was using
  (reset-network.org, 12 November 2026). The router now checks the file's
  modification time on every tool call and on tool listing. A changed file is
  reloaded: new sites appear, removed ones go, and a site whose entry changed
  gets a fresh session and catalog. The `site` enum in the tool schemas
  follows, and clients get `notifications/tools/list_changed` when the set of
  ids changes. A half-written or invalid file keeps the last good registry.
  An env-var registry (`WP_MCP_ROUTER_SITES`) is not watched.
- **`connect-remote`, for a router on a machine nobody is sitting at.**
  `add-site` and `connect-batch` open the approval page in a browser on the
  machine the router runs on, which on a headless server is a window nobody
  sees. `connect-remote <url> --id <id>` prints the approval link instead, to
  open on any computer. Then `connect-remote <url> --id <id> --password-file
  <file>` reads the password from a file (never the command line), checks it
  against the site's MCP endpoint, and saves it only if it works, keeping the
  old registry as `sites.json.bak`. `--user` defaults to `weave_admin`.
- `--no-browser` (or `WP_MCP_ROUTER_NO_BROWSER=1`) stops `add-site` and
  `connect-batch` opening a browser; the URL is printed as before.

- **`add-site` in paste mode now catches the application password at the
  login prompt.** The steps said "Paste it below", and the first prompt below
  asks for the login, so the password went into both fields and was saved
  that way (blocks.weave.co.nz, 26 October 2026; every call then failed with
  a 401). A login with a password's shape (24 letters and digits, spaced in
  fours or not) is refused and asked for again, a login equal to the
  password stops before anything is saved, and step 3 now says the login
  comes first.
- CI runs on the fork for the first time (GitHub keeps a fork's workflows
  off until enabled), on Node 20, 22 and 24, with a manual run button.

## 0.5.7: a site without Block MCP is never promised rules

- **A first `wp_run` on a site without Block MCP could be told rules were
  coming, and none ever came.** The route answered 404 quickly, but the
  router waited for `weave/get-site-info` as well, in case it still had the
  field. When the agent's call returned in between, its result carried
  `site_rules_pending`, which said the rules "come with the next wp_run on
  this site". The lookup then settled on "no Block MCP" and nothing followed.
  An agent told to make its next call a read first did so for nothing, and
  could go on waiting for rules the site does not have. Found in the final
  review of 0.5.6, 26 October 2026.
- A 404 from `/wp-json/gk-block-api/v1/instructions` now settles it on its
  own. It means Block MCP is not active, and get-site-info only has
  `agent_instructions` when it is (weave-abilities 0.9.5 adds the field only
  when `GK_BLOCK_MCP_VERSION` is defined), so waiting could only ever end in
  the same answer. get-site-info's field still wins if it is already in. A
  route failure (a 403, a 429, a timeout) still waits for get-site-info,
  which covers a route that is blocked or rate-limited.
- The pending line no longer promises anything, since the lookup can still
  be running when the site has no Block MCP (the 404 itself was slower than
  the call). It now reads: the router was still checking the site for agent
  rules when this call returned, and it does not wait; any rules the site
  sets come as `site_rules` with a later `wp_run` on it; once a result there
  has no `site_rules_pending`, the check is done; make the next call a read
  if you were about to write. The `wp_run` and `wp_list_sites` descriptions
  say "any rules the site sets" and "a later call" the same way.
- Tests: two new cases for the race, one where get-site-info is slower than
  the call (nothing added, `agent_rules` reads "none (no Block MCP)" at once)
  and one where the 404 is (the pending line promises no rules, and the next
  call carries nothing). Both fail on 0.5.6. The `decideRules` unit test now
  expects a 404 to settle it, and a route failure still to wait.
- Checked live on a local site (WordPress 7.1.3, mcp-adapter 0.7.1, Block MCP
  2.2.1 switched off for the test, weave-abilities with the field) with a
  temporary mu-plugin holding one request:
  - get-site-info held 2 seconds: 0.5.6 returned the first call in 220 ms
    with `site_rules_pending`, and the next two calls carried nothing. 0.5.7
    added nothing to any of three calls, four runs out of four, with
    `agent_rules` "none (no Block MCP)".
  - The 404 route held 1.5 seconds: 0.5.7 returned the first call in 215 ms
    with the new pending line, and the next two carried nothing.
  - Block MCP switched back on: the rules (1,964 characters) came with the
    first call, as before.

## 0.5.6: each site's agent rules reach the agent

- **Block MCP's custom instructions never reached a router agent.** A site's
  custom instructions are its rules for AI agents: voice, content only, and
  how to undo a write, including the 20 October 2026 correction that stops an
  agent reverting to an autosave. Block MCP 2.2.1 serves them only to its own
  Node server at initialize, and the router read nothing from initialize but
  the protocol version. The Weave playbook said every agent reads them at
  connect. Found in the Roots & Fruit review, 26 October 2026.
- The first `wp_run` on each site in a session now carries a labelled
  `site_rules` object (text, source, updated_at) ahead of the result. If the
  rules are not in when that call returns, the result says so in a one-line
  `site_rules_pending`, and the first `wp_run` on the site to return after
  they are in carries them, with an `arrived_late` line counting the calls
  that ran without them. Later calls on that site do not repeat them. The
  `wp_run` description says to follow them, and to open each site with a
  read, reading again while `site_rules_pending` shows, so the rules arrive
  before any write.
- Sources, asked at the same time with the route first: Block MCP's public
  `/wp-json/gk-block-api/v1/instructions` route, fetched from the MCP
  endpoint's origin with the same credentials and custom headers, and
  `agent_instructions` from `weave/get-site-info` (weave-abilities after
  0.9.4). The route's answer is enough on its own. get-site-info's is used
  when it has come in too, since it is the same text, and it covers a route
  that is blocked or rate-limited. A 404 on the route means no Block MCP, and
  nothing is added. When the agent's own call is `weave/get-site-info`, its
  result is read instead of calling it twice.
- Never in the way: the router never waits for the lookup, so it adds nothing
  to the agent's call. A lookup gets 5 seconds before it counts as failed
  (`rulesTimeoutMs`, `WP_MCP_ROUTER_RULES_TIMEOUT_MS`). A failure adds a
  one-line `site_rules_note` to the next result and is retried by a later
  `wp_run`, three tries a session at most. The text is capped at 2,000
  characters with zero-width and bidi characters removed. `siteRules: false`
  or `WP_MCP_ROUTER_SITE_RULES=off` turns it off.
- **Fixed before release: the first build held the call.** 780cda7 (in the
  live dist from 26 October 2026, never tagged) asked get-site-info, then the
  route, one after the other, and held the agent's result until both
  answered, up to the 5 second budget. Every fleet site was on weave-abilities
  0.9.4 with no field, so every first `wp_run` paid both round trips, and a
  slow site paid 5 seconds on each of its first three calls and never got its
  rules. Found in review the same day.
- Measured on a local site (WordPress 7.1.3, mcp-adapter 0.7.1, Block MCP
  2.2.1, weave-abilities 0.9.4) with a mu-plugin slowing every REST request,
  fresh router each run, median of five, first `wp_run` then second:
  - 1 second per request: 780cda7 5.98 s then 1.21 s. 0.5.6 with rules on
    4.69 s then 1.21 s, with rules off 4.87 s then 1.22 s.
  - 3 seconds per request: 780cda7 14.63 s then 5.00 s, and no rules in any
    run. 0.5.6 with rules on 12.72 s then 3.23 s, with rules off 12.97 s then
    3.24 s. The rules came with the first call in 4 runs of 5 and with the
    second, marked late, in 1.
  - Agent's first call `weave/get-site-info` (median of three): 780cda7 15.95 s,
    0.5.6 12.72 s, rules off 12.90 s at 3 seconds; 5.88 s, 4.89 s and 4.76 s
    at 1 second.
  - With the field (weave-abilities after 0.9.4), 0.5.6 matched rules off at
    both delays, and 780cda7 did too, since one round trip fits beside the call.
  - Rechecked on the final build, median of three: rules on 4.80 s, off 4.88 s
    at 1 second; on 12.76 s, off 12.86 s at 3 seconds.
- `wp_list_sites` shows `agent_rules` per site once known, from the cache
  only. `refresh: true` resends the rules with the next `wp_run`.
- `wp_run_across` is unchanged.
- `package-lock.json` carries the version again; it had stayed at 0.5.1.
- Checked live on the same site with 0.5.6: Block MCP switched off (nothing
  added), empty instructions (the one line), and a 1 ms budget on a slowed
  site (a note on each of three calls, then nothing). On an unslowed site a
  1 ms budget still delivered the rules, because the requests run up to
  100 ms past the deadline and an answer that lands by the next call beats
  the failure. The first build was also checked on mcp-adapter 0.6.1.

## 0.5.5: MCP Adapter is on wordpress.org

- When a site is missing MCP Adapter, `setup`, `add-site` and `--doctor` now open
  that site's Plugins > Add New search for it, instead of a GitHub zip and the
  upload screen. The adapter moved to wordpress.org with 0.7.0. The router
  still never installs plugins itself.
- README: which adapter versions work (0.7.0 needs router 0.5.4 or later), an
  Updating section, and a few dashes reworded.

## 0.5.4: works with mcp-adapter 0.7.0

- **mcp-adapter 0.7.0 (2 October 2026) would have broken every call.** After
  `initialize`, 0.7.0 refuses any request without an `MCP-Protocol-Version`
  header: `-32600 MCP-Protocol-Version header is required for a 2025-06-18
  session`. The router never sent it, because 0.6.x did not check. Found on
  a local dev site, the first one on 0.7.0. The router now records the version
  the site agrees in `initialize` and sends it on every later request.
- Proposes `2025-11-25` instead of `2025-06-18`. Both adapter versions serve it
  natively; 0.7.0 only accepts 2025-06-18 as a legacy alias.
- `setup`'s connection check lists tools instead of sending a second
  `initialize`, so it exercises a post-initialize request, which is where the
  header check bites.
- Checked live against a local site on 0.7.0 and two hosted dev sites on
  0.6.1. Nothing else in the 0.7.0 breaking list
  touches the router: it sends no batches, never called `tools/list/all`, and
  reads results from the text block, so the dropped `structuredContent` for list
  results does not matter.

## 0.5.3: a misplaced key is refused, not dropped

- **A misplaced key no longer vanishes.** The MCP SDK does not check a call
  against a tool's inputSchema, so `wp_run` quietly ignored any top-level key it
  did not know. Ability parameters sent as `parameters` instead of `arguments`
  reached the site as `{}`, and an all-optional ability ran on its defaults and
  reported success: `per_page: 8` came back as 50 on nursing-research-dev
  (23 Sep 2026), and nothing said so. Every router tool now refuses a key it
  does not declare, names it, lists what it does accept, and on `wp_run` and
  `wp_run_across` says that ability parameters go inside `arguments`. A
  non-object `arguments` (a JSON string, an array) is refused too.
- Misspelt keys *inside* `arguments` are the site's job, not the router's, since
  third-party schemas do not all declare their extras. weave-abilities 0.9.1
  refuses them for `weave/*`.

## 0.5.1: install points at this checkout

- **`install` pointed every client at the wrong router.** Both the JSON entry
  (Claude Code / Desktop / Cursor) and the TOML block (Codex) emitted
  `npx -y wp-mcp-router`, which fetches the UPSTREAM npm package: a different,
  older codebase. This fork is `private: true` and deliberately unpublished, so
  anyone following the README's `install` line got 0.4.0 with none of the 0.5.0
  work, and the symptom looked like missing abilities rather than a wrong
  binary. Both writers now emit `process.execPath` plus an absolute path to this
  checkout's `dist/index.js`. Re-run `install` after changing Node version, the
  path is resolved at install time.

- Remove the dead `COMPANION_BLOCK_MCP` spec and the README's "recommended
  companion" link. Both pointed at `danieliser/block-mcp`, whose latest release
  is a stock 2.0.2 rollback zip with no abilities in it; the abilities work in
  that fork (PRs #48 and #49 to GravityKit) was never merged. GravityKit's own
  Block MCP registers Abilities since 2.1.0 and needs no help from the router.
- `wp_get_content_by_url` accepts any `*resolve-url` ability and says plainly
  when a site has none, instead of telling you to install `gk-block-mcp`.

## 0.5.0: Weave takes over the fork

From this release `weavedigitalstudio/wp-mcp-router` is its own line, not a
patch set on top of upstream. Daniel Iser wrote 0.1.0 to 0.4.0 (GPL-2.0-or-later,
July 2026); everything below is Weave's, and the upstream repo has been quiet
since 13 July 2026. Not published to npm: clone and build.

- **Ownership.** `package.json` now names Weave as maintainer with Daniel Iser
  credited as original author, points `repository`, `bugs` and `homepage` at the
  Weave fork, and is marked `private` so it can never be published over the
  upstream npm package by accident. `master` is the Weave line; the
  `weave-hardening` and `weave-batch-connect` branches are folded into it.
- **`connect-batch <template.json>`** walks a secret-free site template (ids,
  labels, URLs), runs the WordPress authorize flow for each site, and writes the
  registry. Resumable: sites that already hold a credential are skipped unless
  `--force`. Invalid entries are reported and skipped, not fatal.
- **`export`** prints the registry as one line of JSON for a secret store
  (1Password's dotenv export reinserts line breaks into long values).
- **`--auto` pre-flight.** Before opening a browser, `--auto` GETs the authorize
  URL; a 4xx (GridPane's 7G firewall returns 403 for any query string containing
  `127.0.0.1`) falls back to manual paste in seconds instead of after the
  five-minute callback timeout. Five tests.
- **Registry ids come from the template** (`ConnectOptions.id`), not from the
  hostname, so they match what `wp_run` takes as `site`.
- Carried over from `v0.4.0-weave.1` (16 July 2026): HTTPS enforced for
  non-loopback sites; the REST plugin installer and the third-party companion
  plugin step are removed, missing plugins get manual guidance only.

## 0.4.0 — required-plugin detection and guided install

- `add-site` now verifies the MCP endpoint and, on failure, diagnoses the usual
  cause: it checks the site's plugins over the REST API, offers to **activate**
  `mcp-adapter` if it's installed but inactive, attempts a WordPress.org install
  when possible, and otherwise walks you through the one-time manual upload
  (opening the download + upload pages in your browser). Re-verifies after fixing.
- `--doctor` does the same diagnosis for every failing site and can fix it
  interactively.
- `add-site` also offers the recommended **Block MCP** companion plugin, which
  registers content abilities (posts, blocks, media, terms) for the router to call.
- Requires connecting as a user who can manage plugins; limited-role users get a
  clear "needs an administrator" note instead of a silent failure.

## 0.3.3 — docs: setup wizard is the front door

- Quick start now leads with `npx wp-mcp-router setup` (the guided wizard);
  `add-site` + `install` documented as the step-by-step alternative. No code changes.

## 0.3.2 — platform-native paths + consistent registry resolution

- **Audit log moved** to the per-user state dir: `~/.local/state/wp-mcp-router/audit.jsonl`
  (`$XDG_STATE_HOME` honored), Windows `%LOCALAPPDATA%\wp-mcp-router\audit.jsonl`. The old
  `~/.wp-mcp-router/audit.jsonl` is migrated automatically on first write. Rationale: logs are
  growing state, not config — and config dirs are what dotfile-sync/backup tools sweep.
- **Windows-native config path**: the registry fallback is now `%APPDATA%\wp-mcp-router\sites.json`
  on Windows (unchanged `~/.config/wp-mcp-router/sites.json` elsewhere, `$XDG_CONFIG_HOME` honored).
- **`add-site` / `install` resolve the registry identically**: `WP_MCP_ROUTER_CONFIG` now wins over
  a `./sites.json` in the current directory (previously reversed, so the two commands could pick
  different files depending on where you ran them). When a cwd-local registry is used, it's
  announced. `install` warns if the registry file it's pointing the client at doesn't exist yet.

## 0.3.1 — leaner README + doc cleanup

- README rewritten to be short and practical: what it is, quick start, tools,
  configuration, security. No behavior changes.
- Generic example usernames in docs and `sites.example.json`; generalized a few
  source comments.

## 0.3.0 — Consistent tool naming

- **Breaking:** renamed `fleet_list_sites` → `wp_list_sites`,
  `fleet_search_abilities` → `wp_search_abilities`, and
  `fleet_get_ability` → `wp_get_ability`.
- This aligns every tool under the `wp_` prefix after the `wp-fleet` →
  `wp-mcp-router` package rename.

## 0.2.2 — add-site prompt + npx-aware suggestions

- The credential prompt no longer claims the login is shown on the WordPress
  approval page (it isn't — WP shows only the app name + password). It now asks
  for the username-or-email you sign in with and points to Users → Profile.
  Handles email logins.
- Suggested follow-up commands are prefixed with `npx ` when the tool was
  launched via npx, so they're copy-paste runnable.
- Approval button label matches WP core ("Yes, I approve of this connection").

## 0.2.1 — add-site: manual paste by default; clearer flow

- `install` now also targets **Codex** (`~/.codex/config.toml`) in addition to
  Claude Desktop / Claude Code / Cursor. Codex config is TOML: the block is
  appended if absent (existing servers preserved, `.bak` written), and left
  untouched if `[mcp_servers.wp-mcp-router]` already exists.
- `add-site` now uses the **manual paste** flow by default: approve in the
  browser, WordPress shows the application password, you paste it back. The
  localhost-callback flow is opt-in via `add-site --auto` (and falls back to
  paste if the callback isn't received).
- The `--auto` callback uses `http://127.0.0.1:<port>`, which IS a valid
  WordPress authorize `success_url` (WP core allows the `127.0.0.1` / `[::1]`
  loopback host over http regardless of environment; `localhost` is NOT allowed
  and is rejected). So `--auto` works on standard sites — no public IP needed;
  the site only redirects *your* browser to *your* machine's callback.

### Note: "The URL must be served over a secure connection"

WordPress uses this same error for a *site-level* check too:
`authorize-application.php` requires `is_ssl()` to be true. Behind a reverse
proxy / CDN that terminates TLS and forwards plain HTTP to the origin (common
on managed hosts), `is_ssl()` can be **false** even though your browser shows
HTTPS — and the authorize page then errors regardless of the callback URL. Fix
it on the WordPress side by trusting the forwarded protocol, e.g. in
`wp-config.php`:

```php
if ( isset( $_SERVER['HTTP_X_FORWARDED_PROTO'] ) && 'https' === $_SERVER['HTTP_X_FORWARDED_PROTO'] ) {
    $_SERVER['HTTPS'] = 'on';
}
```

Or create the application password manually (Users → Profile → Application
Passwords) and paste it into `add-site`.

## 0.2.0 — Zero-friction onboarding

Adds a browser-based setup flow so connecting a site takes two commands and no
manual credential handling.

- `wp-mcp-router add-site [url]` — connect a site via WordPress core's Application
  Passwords authorization flow: opens the browser, the user clicks "Approve", and the
  minted credential is caught on a localhost callback, written to the registry (0600),
  and verified against the live MCP endpoint. No manual credential copying.
- `wp-mcp-router install [client]` — auto-detect and inject the server into Claude
  Desktop / Claude Code / Cursor config (merges, backs up to `.bak`, never clobbers).
- `wp-mcp-router setup` — guided one-shot wizard chaining both.
- `--help` with full usage; a "run setup" nudge when started with no config.
- Audit log file/dir hardened to `0600`/`0700` with a one-time `FULL`-mode warning.

Node built-ins only — no new dependencies.

## 0.1.0 — Initial public release

First public release. Multi-site WordPress MCP router: one MCP connection for a
fleet of `mcp-adapter` (Abilities API) sites.

### Tools

- `fleet_list_sites` — the fleet map (sites, tags, ability counts, namespace groups).
- `fleet_search_abilities` — keyword search across sites, grouped by site.
- `fleet_get_ability` — full schema for one ability on one site (cached per (site, ability)).
- `wp_run` — execute an ability on one site, guarded (missing → names the sites that have it).
- `wp_run_across` — run the same ability across many sites in parallel (fan-out).
- `wp_get_content_by_url` — resolve a URL/path to its post, optionally with full content.

### Transport & reliability

- Session-aware JSON-RPC client (`initialize` → `Mcp-Session-Id` → `initialized` → echo header),
  handling both JSON and SSE response framing, with one-shot session-recovery on expiry.
- Split timeouts: tighter `initTimeoutMs` (25s) for the handshake vs `requestTimeoutMs` (120s)
  for tool calls.
- Network errors mapped to actionable messages (DNS / TLS / refused / timeout).
- Per-site `customHeaders` for sites behind Cloudflare Access, Sucuri, or a WAF.

### Observability & efficiency

- Client-side audit log (JSONL), on by default, args redacted by default, `0600`/`0700` perms,
  opt-in `FULL` mode with a stderr warning, and an `=off` switch.
- Opt-in lossless response compaction (`compact: true`) — strips `_links` / `_embedded`.

### Safety

- Registry (credentials) is never committed and never shipped to npm — `files` whitelist +
  `.npmignore` guarantee only `dist/`, docs, and the example config ship.
