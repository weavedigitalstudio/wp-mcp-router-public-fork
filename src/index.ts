#!/usr/bin/env node
/**
 * wp-mcp-router entry point.
 *
 *   wp-mcp-router                 → start the MCP server on stdio (default)
 *   wp-mcp-router setup           → guided first-run: connect a site + wire in a client
 *   wp-mcp-router add-site [url]   → connect a WordPress site via the browser
 *                                    (Application Passwords authorize flow)
 *   wp-mcp-router connect-batch <f> → walk a secret-free site template, connecting each
 *   wp-mcp-router connect-remote <url> --id <id> [--label <l>] [--user <login>]
                                 [--password-file <file>]
                                 For a router on a machine nobody is sitting at.
                                 Without --password-file, prints the approval
                                 link to open on any computer. With it, checks
                                 the password against the site and saves it
                                 only if it works (old registry kept as .bak).
                                 --user defaults to weave_admin.
  --no-browser                   Never open a browser (add-site, connect-batch);
                                 the URL is printed instead.
  wp-mcp-router export           → print the registry for a secret store
 *   wp-mcp-router install [client] → inject the server into Claude / Cursor config
 *   wp-mcp-router --doctor         → hit every site, report ability counts, exit
 *   wp-mcp-router --help           → usage
 */

import { existsSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { Catalog } from "./catalog.js";
import { auditStatus } from "./audit.js";
import { addSite, connectBatch, connectRemote, exportRegistry, install, setup, selfCmd, ensureIo } from "./setup.js";
import { REQUIRED_PLUGIN, ensurePlugin, probePlugin } from "./adapter.js";

const HELP = `wp-mcp-router — one MCP connection for a fleet of WordPress sites

Usage:
  wp-mcp-router                  Start the MCP server (stdio). This is what your
                                 AI client runs.
  wp-mcp-router setup            Guided setup: connect a site in your browser,
                                 then wire it into Claude / Cursor. Start here.
  wp-mcp-router add-site [url]    Connect one WordPress site. Opens the browser
                                 to approve; WordPress shows the password, you
                                 paste it. Add --auto to catch it via a
                                 localhost callback instead (nicer, but web
                                 firewalls such as GridPane 7G reject the
                                 loopback URL; when one does, this falls back
                                 to paste straight away).
  wp-mcp-router connect-batch <template.json>
                                 Connect every site in a secret-free template
                                 (ids, labels, URLs) in one pass. Approve each in
                                 the browser; nothing is pasted into JSON by hand.
                                 Skips sites that already hold a credential, so
                                 an interrupted run resumes. --auto and --force
                                 apply.
  wp-mcp-router export           Print the registry as one line of JSON on stdout,
                                 ready to pipe into a secret store. --pretty for
                                 a readable copy. Contains live passwords.
  wp-mcp-router install [client] Add wp-mcp-router to an MCP client's config
                                 (Claude Desktop | Claude Code | Cursor | Codex).
  wp-mcp-router --doctor         Check connectivity + list abilities per site.
  wp-mcp-router --help           This message.

Config: sites live in a gitignored registry (./sites.json, WP_MCP_ROUTER_CONFIG,
or ~/.config/wp-mcp-router/sites.json). See sites.example.json.
`;

async function runDoctor(): Promise<number> {
  const { config, source } = loadConfig();
  process.stderr.write(`wp-mcp-router doctor — config from ${source}\n`);
  process.stderr.write(`default site: ${config.defaultSite ?? "(none)"}\n`);
  process.stderr.write(`${auditStatus()}\n\n`);
  const catalog = new Catalog(config);
  let failures = 0;
  for (const site of config.sites) {
    process.stderr.write(`• ${site.id} (${site.url})\n`);
    try {
      const cat = await catalog.getCatalog(site.id, true);
      if (cat.error) {
        failures++;
        process.stderr.write(`    ✗ ${cat.error}\n`);
        // The usual culprit: mcp-adapter missing or inactive. Diagnose —
        // and when the terminal is interactive, offer to fix it in place.
        if (site.username && site.appPassword) {
          const probe = await probePlugin(site.url, site.username, site.appPassword, REQUIRED_PLUGIN.slug);
          if (probe.status === "inactive" || probe.status === "missing") {
            process.stderr.write(`    ↳ mcp-adapter is ${probe.status} on this site.\n`);
            const fixed = await ensurePlugin(site.url, site.username, site.appPassword, REQUIRED_PLUGIN, ensureIo());
            if (fixed) {
              const retry = await catalog.getCatalog(site.id, true);
              if (!retry.error) {
                failures--;
                process.stderr.write(`    ✓ fixed — ${retry.abilities.length} abilities now visible.\n`);
              }
            }
          } else if (probe.status === "unknown" && probe.reason) {
            process.stderr.write(`    ↳ couldn't check plugins: ${probe.reason}\n`);
          }
        }
      } else {
        const groups = [...new Set(cat.abilities.map((a) => a.group).filter(Boolean))];
        process.stderr.write(`    ✓ ${cat.abilities.length} abilities — groups: ${groups.join(", ") || "(none)"}\n`);
      }
    } catch (err) {
      failures++;
      process.stderr.write(`    ✗ ${(err as Error).message}\n`);
    }
  }
  process.stderr.write(`\n${failures === 0 ? "All sites reachable." : `${failures} site(s) failed.`}\n`);
  return failures === 0 ? 0 : 1;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.find((a) => !a.startsWith("-"));

  if (args.includes("--no-browser")) process.env.WP_MCP_ROUTER_NO_BROWSER = "1";
  if (args.includes("--help") || args.includes("-h") || cmd === "help") {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (args.includes("--doctor") || cmd === "doctor") {
    process.exit(await runDoctor());
  }
  if (cmd === "setup") {
    process.exit(await setup());
  }
  if (cmd === "add-site") {
    // The URL (if any) is the first non-flag arg after the command.
    const url = args.filter((a) => !a.startsWith("-"))[1];
    process.exit(await addSite(url));
  }
  if (cmd === "connect-remote") {
    const flag = (name: string): string | undefined => {
      const i = args.indexOf(name);
      return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
    };
    // The URL is the first bare arg after the command that is not a flag's value.
    const flagValues = new Set(["--id", "--label", "--user", "--password-file"].map(flag).filter(Boolean));
    const url = args.filter((a) => !a.startsWith("-") && a !== cmd && !flagValues.has(a))[0];
    process.exit(
      await connectRemote(url, {
        id: flag("--id"),
        label: flag("--label"),
        user: flag("--user"),
        passwordFile: flag("--password-file"),
      }),
    );
  }
  if (cmd === "connect-batch") {
    const template = args.filter((a) => !a.startsWith("-"))[1];
    process.exit(await connectBatch(template));
  }
  if (cmd === "export") {
    process.exit(await exportRegistry());
  }
  if (cmd === "install") {
    const client = args.filter((a) => !a.startsWith("-")).slice(1).join(" ") || undefined;
    process.exit(await install(client));
  }

  // No recognized subcommand → run as the MCP stdio server.
  let config;
  let source = "";
  try {
    ({ config, source } = loadConfig());
  } catch (err) {
    process.stderr.write(`wp-mcp-router: ${(err as Error).message}\n`);
    process.stderr.write(`\nNo sites configured yet. Run:  ${selfCmd("setup")}\n`);
    process.exit(1);
  }

  // An env-var registry has no file to watch; a file source is its path.
  const configPath = existsSync(source) ? source : undefined;
  const server = buildServer(config, { configPath });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`wp-mcp-router ready — ${config.sites.length} site(s): ${config.sites.map((s) => s.id).join(", ")}\n`);
}

main().catch((err) => {
  process.stderr.write(`wp-mcp-router fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
