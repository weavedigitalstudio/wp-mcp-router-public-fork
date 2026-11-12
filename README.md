# wp-mcp-router

[![CI](https://github.com/weavedigitalstudio/wp-mcp-router/actions/workflows/ci.yml/badge.svg)](https://github.com/weavedigitalstudio/wp-mcp-router/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-GPL--2.0--or--later-blue.svg)](./LICENSE)

> **Origins.** Forked from [danieliser/wp-mcp-router](https://github.com/danieliser/wp-mcp-router)
> at v0.4.0 by [Weave Digital Studio](https://weave.co.nz) in July 2026 and
> maintained here since 0.5.0. Daniel Iser wrote 0.1.0 to 0.4.0; the licence
> (GPL-2.0-or-later) and his copyright are unchanged. What Weave changed and
> when is in [CHANGELOG.md](./CHANGELOG.md). This fork is **not on npm**:
> `npx wp-mcp-router` fetches the upstream package, so clone this repo and
> `npm ci && npm run build` instead.

**One MCP connection for all your WordPress sites.**

wp-mcp-router is an MCP (stdio) server that fronts any number of WordPress sites running the
[Abilities API](https://developer.wordpress.org/news/2026/02/from-abilities-to-ai-agents-introducing-the-wordpress-mcp-adapter/)
via the [`mcp-adapter`](https://github.com/WordPress/mcp-adapter) plugin. Instead of one MCP
server per site, you connect your AI client (Claude Desktop / Claude Code / Cursor / Codex)
once and address each site by name. The router discovers what each site can actually do,
lets you search abilities across all of them, and guards execution: calling an ability on a
site that doesn't have it returns *"not on B; available on A and C"* instead of an opaque error.

## Quick start

```bash
git clone https://github.com/weavedigitalstudio/wp-mcp-router.git
cd wp-mcp-router && npm ci && npm run build
node dist/index.js setup
```

The wizard connects your first site (opens your browser; you approve, WordPress mints a
scoped application password, you paste it back once) and wires the server into your AI
client (auto-detects Claude Desktop / Claude Code / Cursor / Codex). Restart your client
and you're connected.

Prefer the steps individually?

```bash
node dist/index.js add-site example.com          # connect a site (repeat per site)
node dist/index.js add-site example.com --auto   # same, caught on a localhost callback
node dist/index.js install                       # add to your AI client's config
```

A fleet? Put ids, labels and URLs in a template (see `site-template.example.json`) and let
the browser flow run once per site, then print the registry as one line for a secret store:

```bash
node dist/index.js connect-batch sites.json --auto   # skips sites already connected
node dist/index.js export                            # one line of JSON on stdout
```

Add more sites any time with `add-site`; they all live behind the one connection.

**On a headless or remote machine** (a server you reach over SSH or a remote agent session),
nobody sees a browser the router opens. Use `connect-remote` instead:

```bash
node dist/index.js connect-remote https://example.com --id example        # prints the approval link
# approve on any computer, save the password it shows into a file, then:
node dist/index.js connect-remote https://example.com --id example --user <login> --password-file /path/to/pw
```

It saves the credential only after the site accepts it. Running routers re-read the registry
when it changes, so open sessions see the new site on their next tool call.
`node dist/index.js --doctor` checks connectivity and lists abilities per site.

Each target site needs the [MCP Adapter](https://wordpress.org/plugins/mcp-adapter/) plugin
active (it registers the `/wp-json/mcp/…` endpoint the router talks to). It is on
wordpress.org since 0.7.0, so install it from Plugins > Add New. `add-site` and `--doctor`
check for it: if it's installed but inactive they offer to activate it, and if it's missing
they open the Add New search for you. The router never installs plugins itself.

**Adapter versions.** The router works with mcp-adapter 0.6.x and 0.7.0. **Sites on 0.7.0
need router 0.5.4 or later:** 0.7.0 refuses every request that lacks an
`MCP-Protocol-Version` header, which older routers did not send. Update the router before
you update the adapter on any site it serves. Content abilities come from whatever the site itself registers
through the Abilities API; the router discovers them, it does not install them. On Weave
sites that is `weave-abilities`. If a site runs GravityKit's
[Block MCP](https://github.com/GravityKit/block-mcp) (2.1.0 and later register its
block-level editing as Abilities), those show up too.

## Updating

```bash
cd wp-mcp-router
git fetch && git reset --hard origin/master   # or `git pull` if you never rewrote history
npm ci && npm run build
```

Then restart your AI client so it loads the new build. Your site registry lives outside the
repo, so it is untouched.

## Tools

| Tool | Purpose |
| --- | --- |
| `wp_list_sites` | Sites + tags + ability counts + namespace groups. |
| `wp_search_abilities` | Keyword search across sites; results grouped by site. |
| `wp_get_ability` | Input/output schema for one ability on one site. |
| `wp_run` | Execute an ability on **one** site (guarded). The first call on each site in a session also carries that site's agent rules, if it sets any, or a later call if they are not in yet (see below). |
| `wp_run_across` | Execute the same ability on **many** sites in parallel. |
| `wp_get_content_by_url` | Resolve a URL/path → post, optionally with full content. |

Every site-targeting tool takes a `site` argument; omit it to use the configured `defaultSite`.

### Site rules

GravityKit Block MCP lets each site set custom instructions: its rules for AI agents, such as
voice, what not to edit, and how to undo a write. Block MCP hands them only to its own MCP
server, so an agent on the router never saw them. The router now passes them on. The first
`wp_run` on a site in each session carries a labelled `site_rules` object, placed before the
result, with the text, where it came from and when it was last saved. If the rules are not in
by the time that call returns, they come with a later `wp_run` on the site instead, with an
`arrived_late` line. Later calls on that site do not repeat them.

- Source: Block MCP's public route `/wp-json/gk-block-api/v1/instructions` and
  `agent_instructions` in `weave/get-site-info` (weave-abilities after 0.9.4), asked at the same
  time, the route first. The route's answer is enough on its own, and get-site-info's is used
  when it has come in too, since it is the same text. When the agent's own call is
  `weave/get-site-info`, its result is read instead of asking twice. The route is fetched from the
  same origin and with the same credentials as the MCP endpoint. If Block MCP is active with no
  rules set, the agent is told so in one line.
- A site without Block MCP gets nothing added. The route answers 404 there, and that settles it
  on its own: get-site-info only has the field when Block MCP is active, so the router does not
  wait for it. (0.5.6 did wait, and a call that returned in between was told rules were coming
  when the site had none.)
- It never holds up the call. The lookup starts with the agent's call and the router never waits
  for it. A result that goes back before the lookup is done says so in a one-line
  `site_rules_pending`. That line never promises rules, since the site may set none: it says any
  rules the site sets come with a later call, and that the check is done once a result has no
  `site_rules_pending`. If there are rules, the first `wp_run` on the site to return after they
  are in carries them, marked `arrived_late` with a count of the calls that ran without them. If
  there are none, later results carry nothing. A lookup gets 5 seconds before it counts as failed.
  A failure adds a one-line `site_rules_note` to the next result, and a later `wp_run` tries
  again, three tries a session at most. The text is capped at Block MCP's own 2,000 characters,
  with zero-width and bidi characters removed.
- An agent's first call can run before the rules arrive, and it may be a write, so the `wp_run`
  description tells agents to start each site with a read such as `weave/get-site-info`, and to
  read again while `site_rules_pending` shows.
- `wp_list_sites` shows `agent_rules` for a site once the router knows them, without fetching.
  `refresh: true` makes the next `wp_run` send the rules again, where the site sets any.
- `wp_run_across` carries no rules: on a fan-out they would repeat once per site.

## Configuration

The site registry carries credentials, so it is **never committed**. Resolved at runtime, in
priority order:

1. `WP_MCP_ROUTER_SITES`: the whole registry as inline JSON in one env var.
2. `WP_MCP_ROUTER_CONFIG`: path to a JSON file.
3. `./sites.json` next to the package (gitignored).
4. `~/.config/wp-mcp-router/sites.json` (Windows: `%APPDATA%\wp-mcp-router\sites.json`).

See [`sites.example.json`](./sites.example.json). Each site needs a `url`, a `username`, and a
WordPress [Application Password](https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/)
(`appPassword`):

```jsonc
{
  "defaultSite": "main",
  "sites": [
    { "id": "main", "url": "https://example.com", "username": "agent", "appPassword": "xxxx xxxx …", "tags": ["ecommerce"] }
  ]
}
```

Useful per-site / global options:

- `endpoint`: override the MCP endpoint (default `<url>/wp-json/mcp/mcp-adapter-default-server`).
- `customHeaders`: extra headers merged into every request (Cloudflare Access service
  tokens, WAF allow-list headers, etc.).
- `requestTimeoutMs` (default 120000) / `initTimeoutMs` (default 25000): call and
  handshake timeouts; also settable via `WP_MCP_ROUTER_TIMEOUT_MS` / `WP_MCP_ROUTER_INIT_TIMEOUT_MS`.
- `rulesTimeoutMs` (default 5000) / `siteRules` (default true): how long the site rules lookup
  may take before it counts as failed (it never delays a call), and a switch to turn it off;
  also settable via `WP_MCP_ROUTER_RULES_TIMEOUT_MS` / `WP_MCP_ROUTER_SITE_RULES=off`.

## Security

Auth is per-site WordPress Application Passwords (Basic auth over HTTPS): scoped, revocable,
never your real login; rotate by deleting and re-minting the app password. Credentials live
only in the gitignored registry or env vars, never in the repo or the npm package. Every
routed call is written to a local audit log (`~/.local/state/wp-mcp-router/audit.jsonl`,
Windows: `%LOCALAPPDATA%\wp-mcp-router\audit.jsonl`; args redacted, owner-only permissions;
`WP_MCP_ROUTER_AUDIT=off` disables it, `WP_MCP_ROUTER_AUDIT_FILE` relocates it).

**Recommendation:** connect each site as a dedicated limited-role user, enough to edit
content, not enough to execute code or manage users, so a leaked credential has a small
blast radius.

## License

GPL-2.0-or-later. Copyright (C) 2026 Daniel Iser (0.1.0 to 0.4.0); modifications
Copyright (C) 2026 Weave Digital Studio (0.5.0 onward). See [CHANGELOG.md](./CHANGELOG.md)
for what changed and when.
