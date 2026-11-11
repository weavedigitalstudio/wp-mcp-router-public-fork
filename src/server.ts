/**
 * wp-mcp-router MCP server.
 *
 * Exposes a small, stable tool surface that is identical regardless of how many
 * sites are behind it. Every site-targeting tool takes a `site` argument (falling
 * back to the configured default). Discovery tools answer "what can each site do?"
 * so the agent looks up capabilities BEFORE calling, and a guard turns a
 * wrong-site call into a helpful redirect instead of an opaque remote error.
 *
 * Tools:
 *   wp_list_sites           — sites + tags + ability counts (the map)
 *   wp_search_abilities     — search abilities across sites (per-site results)
 *   wp_get_ability          — input/output schema for one ability on one site
 *   wp_run                  — execute an ability on ONE site (guarded)
 *   wp_run_across           — execute the SAME ability on MANY sites (fan-out)
 *   wp_get_content_by_url   — resolve a URL/path to its post (+optional content)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { statSync } from "node:fs";
import { loadConfig, type FleetConfig } from "./config.js";
import { Catalog, EXECUTE_TOOL } from "./catalog.js";
import { compactResult } from "./compact.js";
import * as audit from "./audit.js";
import { SiteRules } from "./site-rules.js";

/** Fleet-standard abilities used by the convenience wrappers. */
const RESOLVE_URL_ABILITY = "gk-block-mcp/resolve-url";
const GET_POST_INFO_ABILITY = "gk-block-mcp/get-post-info";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(message: string, extra?: Record<string, unknown>) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: message, ...extra }, null, 2) }],
  };
}

/**
 * Pull a post id out of a resolve-url tool result. The result envelope wraps a
 * JSON text node; different resolvers use post_id / postId / id, so we probe a
 * few shapes rather than assume one.
 */
function extractPostId(result: any): number | string | null {
  let payload: any = result;
  const content = result?.content;
  if (Array.isArray(content)) {
    const textNode = content.find((c: any) => c?.type === "text" && typeof c.text === "string");
    if (textNode) {
      try {
        payload = JSON.parse(textNode.text);
      } catch {
        /* leave payload as-is */
      }
    }
  }
  const data = payload?.data ?? payload;
  const id = data?.post_id ?? data?.postId ?? data?.id ?? null;
  return typeof id === "number" || typeof id === "string" ? id : null;
}

/**
 * Top-level keys a router tool does not declare. The MCP SDK does not check a
 * call against the tool's inputSchema, so a misplaced key was dropped without a
 * word: ability parameters sent as `parameters` instead of `arguments` reached
 * the site as {}, and an all-optional ability ran on its defaults and reported
 * success (per_page 8 came back as 50, nursing-research-dev, 23 Sep 2026).
 */
export function unknownToolArgs(
  tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>,
  name: string,
  args: Record<string, unknown>,
): { message: string; detail: Record<string, unknown> } | null {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return null;
  const accepted = Object.keys(tool.inputSchema.properties ?? {});
  const unknown = Object.keys(args).filter((k) => !accepted.includes(k));
  if ("arguments" in args && (typeof args.arguments !== "object" || args.arguments === null || Array.isArray(args.arguments))) {
    return {
      message: `${name}: "arguments" must be an object of the ability's parameters.`,
      detail: { accepted },
    };
  }
  if (unknown.length === 0) return null;
  const takesArguments = accepted.includes("arguments");
  return {
    message: `${name} does not accept ${unknown.join(", ")}, so nothing ran.${
      takesArguments ? " Ability parameters go inside \"arguments\"." : ""
    }`,
    detail: { unknown, accepted },
  };
}

export interface BuildOptions {
  /**
   * Path of the registry file the config came from. When given, the server
   * re-reads it whenever its modification time changes, so a site added or
   * re-credentialed by another process is live on the next tool call without
   * restarting the MCP client. Omit for an env-var registry.
   */
  configPath?: string;
}

/** Modification time of a file, or undefined when it can't be read. */
function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

export function buildServer(config: FleetConfig, opts: BuildOptions = {}): Server {
  const catalog = new Catalog(config);
  const rules = new SiteRules(config, catalog);
  // Mutated in place on reload: siteEnum below holds this same array, so the
  // tool schemas pick up a new site id without being rebuilt.
  const siteIds = config.sites.map((s) => s.id);
  const siteEnum = { type: "string" as const, enum: siteIds, description: "Target site id." };

  const resolveSite = (arg: unknown): { id: string } | { error: string } => {
    const id = (typeof arg === "string" && arg) || config.defaultSite;
    if (!id) return { error: `No site given and no defaultSite configured. Sites: ${siteIds.join(", ")}.` };
    if (!siteIds.includes(id)) return { error: `Unknown site "${id}". Configured: ${siteIds.join(", ")}.` };
    return { id };
  };

  const server = new Server(
    { name: "wp-mcp-router", version: "0.1.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  // Hot reload of the registry. The router used to read sites.json once at
  // start, so a site connected from another shell stayed invisible until the
  // MCP client restarted the server, which some hosts (T3 Code) cannot do from
  // inside a session. A stat per tool call is cheap; a parse only happens when
  // the file changed. A half-written or invalid file keeps the old config.
  let lastMtime = opts.configPath ? mtimeOf(opts.configPath) : undefined;
  const reloadIfChanged = async (): Promise<void> => {
    if (!opts.configPath) return;
    const mtime = mtimeOf(opts.configPath);
    if (mtime === undefined || mtime === lastMtime) return;
    let fresh: FleetConfig;
    try {
      fresh = loadConfig().config;
    } catch (err) {
      process.stderr.write(`wp-mcp-router: registry changed but did not load, keeping the old one: ${(err as Error).message}\n`);
      return;
    }
    lastMtime = mtime;
    const before = new Map(config.sites.map((s) => [s.id, JSON.stringify(s)]));
    const after = new Map(fresh.sites.map((s) => [s.id, JSON.stringify(s)]));
    for (const [id, old] of before) {
      if (after.get(id) !== old) {
        catalog.forget(id);
        rules.reset(id);
      }
    }
    Object.assign(config, fresh);
    const idsChanged = siteIds.join("\n") !== fresh.sites.map((s) => s.id).join("\n");
    siteIds.splice(0, siteIds.length, ...fresh.sites.map((s) => s.id));
    process.stderr.write(`wp-mcp-router: registry reloaded — ${siteIds.length} site(s)\n`);
    if (idsChanged) {
      try {
        await server.sendToolListChanged();
      } catch {
        /* not connected yet, or the client ignores it: the enum is current either way */
      }
    }
  };

  const tools = [
    {
      name: "wp_list_sites",
      description:
        "TIER 1 discovery — the fleet map. Returns each site's id, label, tags, ability count, and namespace GROUPS (e.g. 'popup-maker', 'fluent-crm'). Deliberately compact: no ability names, no schemas. Call this first to see which site is likely to have what you need, then use wp_search_abilities to drill in.",
      inputSchema: {
        type: "object",
        properties: {
          refresh: {
            type: "boolean",
            description:
              "Force re-discovery of ability catalogs (ignore cache), and send each site's agent rules again, where it sets any, with its next wp_run.",
          },
        },
      },
    },
    {
      name: "wp_search_abilities",
      description:
        "TIER 2 discovery — drill into abilities. Keyword search across sites' ability catalogs (matches name, description, or namespace). Returns matches grouped by site with names + descriptions but NOT full schemas. Empty query lists everything for the specified sites. Use wp_get_ability for a specific ability's full schema.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keyword, e.g. 'popup', 'contact', 'create'. Empty = list all." },
          sites: { type: "array", items: { type: "string" }, description: "Limit to these site ids (default: all). Narrow with wp_list_sites first for large fleets." },
        },
      },
    },
    {
      name: "wp_get_ability",
      description:
        "TIER 3 discovery — the full input/output schema and description for one ability on one site. Call this before wp_run when you need to know the exact parameters. Result is cached per (site, ability) with the same TTL as the site catalog.",
      inputSchema: {
        type: "object",
        properties: {
          site: siteEnum,
          ability_name: { type: "string", description: "Full ability name, e.g. 'popup-maker/create-popup'." },
        },
        required: ["ability_name"],
      },
    },
    {
      name: "wp_run",
      description:
        "Execute a WordPress ability on a single site. Guarded: if the ability is not available on the target site, returns an error naming the sites that DO have it (no blind cross-site calls). The first wp_run on a site in each session also returns site_rules: the rules that site's administrators set for AI agents (Block MCP custom instructions). Follow them for every call on that site. The router never waits for them: if the lookup is not done when a call returns, the result says site_rules_pending, and any rules the site sets come with a later wp_run on it, marked arrived_late. A site without Block MCP sets none, and nothing is added. Start a new site with a read such as weave/get-site-info, and read again while site_rules_pending shows, so any rules arrive before a write.",
      inputSchema: {
        type: "object",
        properties: {
          site: siteEnum,
          ability_name: { type: "string", description: "Full ability name, e.g. 'core/get-site-info'." },
          arguments: { type: "object", description: "Arguments object for the ability (see wp_get_ability)." },
          compact: {
            type: "boolean",
            description:
              "Losslessly strip _links / _embedded (HAL hypermedia noise) from the result to save context. Default false. No data an agent acts on is removed.",
          },
        },
        required: ["ability_name"],
      },
    },
    {
      name: "wp_run_across",
      description:
        "Execute the SAME ability on MANY sites in parallel (federation/fan-out). Sites that lack the ability are reported as skipped, not failed. Use for fleet-wide reads or coordinated writes.",
      inputSchema: {
        type: "object",
        properties: {
          ability_name: { type: "string", description: "Full ability name to run on each site." },
          arguments: { type: "object", description: "Arguments applied to every site." },
          sites: { type: "array", items: { type: "string" }, description: "Target site ids (default: all not excluded from fan-out)." },
          compact: {
            type: "boolean",
            description: "Losslessly strip _links / _embedded from each site's result. Default false.",
          },
        },
        required: ["ability_name"],
      },
    },
    {
      name: "wp_get_content_by_url",
      description:
        "Resolve a WordPress URL (or site-relative path) to its underlying post/page — id, type, title, status — in one step, instead of listing content and filtering yourself. Optionally include the full post info. Requires the target site to expose a URL-resolve ability (any ability named *resolve-url, e.g. gk-block-mcp/resolve-url); falls back with a clear message if it doesn't.",
      inputSchema: {
        type: "object",
        properties: {
          site: siteEnum,
          url: { type: "string", description: "Full URL (https://site/path/) or site-relative path (/path/)." },
          with_content: {
            type: "boolean",
            description: "Also fetch full post info (get-post-info) for the resolved post. Default false.",
          },
        },
        required: ["url"],
      },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await reloadIfChanged();
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    await reloadIfChanged();

    // Every tool call is timed and audited in the request path — no invocation
    // can bypass the log. record() is a no-op when WP_MCP_ROUTER_AUDIT=off.
    const startedAt = Date.now();
    const auditOf = (res: { isError?: boolean; content?: Array<{ text?: string }> }) => {
      let error: string | undefined;
      if (res?.isError) {
        try {
          error = JSON.parse(res.content?.[0]?.text ?? "{}")?.error;
        } catch {
          error = res.content?.[0]?.text;
        }
      }
      audit.record({
        tool: name,
        site: typeof args.site === "string" ? args.site : undefined,
        ability: typeof args.ability_name === "string" ? args.ability_name : undefined,
        args,
        durationMs: Date.now() - startedAt,
        ok: !res?.isError,
        error,
      });
      return res;
    };

    try {
      return auditOf(await handleTool());
    } catch (err) {
      return auditOf(fail((err as Error).message));
    }

    async function handleTool(): Promise<any> {
      const unknown = unknownToolArgs(tools, name, args);
      if (unknown) return fail(unknown.message, unknown.detail);

      switch (name) {
        case "wp_list_sites": {
          const refresh = args.refresh === true;
          const rows = await Promise.all(
            config.sites.map(async (s) => {
              if (refresh) {
                await catalog.getCatalog(s.id, true);
                rules.reset(s.id);
              }
              const { groups, error, abilityCount } = await catalog.siteGroups(s.id);
              const agentRules = rules.status(s.id);
              return {
                id: s.id,
                label: s.label,
                url: s.url,
                tags: s.tags,
                default: s.id === config.defaultSite,
                ability_count: abilityCount,
                groups,
                ...(agentRules ? { agent_rules: agentRules } : {}),
                ...(error ? { error } : {}),
              };
            }),
          );
          return ok({
            default_site: config.defaultSite,
            sites: rows,
            hint: "Use wp_search_abilities({sites:['<id>']}) to see abilities on a specific site, or wp_search_abilities({query:'…'}) to search across the fleet. A site's agent rules, if it sets any, arrive as site_rules with the first wp_run on it, or a later one if the lookup is slower than that call.",
          });
        }

        case "wp_search_abilities": {
          const query = typeof args.query === "string" ? args.query : "";
          const sites = Array.isArray(args.sites) ? (args.sites as string[]) : undefined;
          const results = await catalog.search(query, sites);
          return ok({
            query,
            results: results.map((r) => ({
              site: r.site,
              count: r.matches.length,
              ...(r.error ? { error: r.error } : {}),
              abilities: r.matches.map((m) => ({ name: m.name, description: m.description })),
            })),
          });
        }

        case "wp_get_ability": {
          const site = resolveSite(args.site);
          if ("error" in site) return fail(site.error);
          const abilityName = String(args.ability_name ?? "");
          if (!abilityName) return fail("ability_name is required.");
          const info = await catalog.getAbilityInfo(site.id, abilityName);
          return ok({ site: site.id, ability: abilityName, info });
        }

        case "wp_run": {
          const site = resolveSite(args.site);
          if ("error" in site) return fail(site.error);
          const abilityName = String(args.ability_name ?? "");
          if (!abilityName) return fail("ability_name is required.");

          const check = await catalog.checkAbility(site.id, abilityName);
          if (!check.available) {
            return fail(`Ability "${abilityName}" is not available on site "${site.id}".`, {
              available_on: check.alsoOn,
              hint:
                check.alsoOn.length > 0
                  ? `Re-run with site="${check.alsoOn[0]}", or use wp_search_abilities to find the right site.`
                  : "No site in the fleet exposes this ability. Check the name with wp_search_abilities.",
            });
          }

          // The site's agent rules ride on its first wp_run each session. The
          // lookup starts with the call and never fails or delays it: finish()
          // attaches the rules if they are in, and leaves them for a later
          // wp_run on the site if not (site-rules.ts).
          const claim = rules.begin(site.id, abilityName);
          let result;
          try {
            result = await catalog
              .client(site.id)
              .callTool(EXECUTE_TOOL, {
                ability_name: abilityName,
                parameters: (args.arguments as object) ?? {},
              });
          } catch (err) {
            claim?.release();
            throw err;
          }
          const siteRules = claim ? claim.finish(result) : {};
          let compaction: { bytes_before: number; bytes_after: number } | undefined;
          if (args.compact === true) {
            const c = compactResult(result);
            result = c.result;
            compaction = { bytes_before: c.bytesBefore, bytes_after: c.bytesAfter };
          }
          return ok({ site: site.id, ability: abilityName, ...siteRules, result, ...(compaction ? { compaction } : {}) });
        }

        case "wp_run_across": {
          const abilityName = String(args.ability_name ?? "");
          if (!abilityName) return fail("ability_name is required.");
          const targets = catalog.fanoutSiteIds(Array.isArray(args.sites) ? (args.sites as string[]) : undefined);
          const params = (args.arguments as object) ?? {};

          const outcomes = await Promise.all(
            targets.map(async (id) => {
              try {
                const check = await catalog.checkAbility(id, abilityName);
                if (!check.available) return { site: id, status: "skipped" as const, reason: "ability not available" };
                let result = await catalog.client(id).callTool(EXECUTE_TOOL, {
                  ability_name: abilityName,
                  parameters: params,
                });
                if (args.compact === true) result = compactResult(result).result;
                return { site: id, status: "ok" as const, result };
              } catch (err) {
                return { site: id, status: "error" as const, error: (err as Error).message };
              }
            }),
          );
          return ok({
            ability: abilityName,
            summary: {
              ok: outcomes.filter((o) => o.status === "ok").length,
              skipped: outcomes.filter((o) => o.status === "skipped").length,
              error: outcomes.filter((o) => o.status === "error").length,
            },
            outcomes,
          });
        }

        case "wp_get_content_by_url": {
          const site = resolveSite(args.site);
          if ("error" in site) return fail(site.error);
          const url = String(args.url ?? "").trim();
          if (!url) return fail("url is required.");

          // Find a URL-resolver ability the target site actually exposes.
          // Prefer gk-block-mcp/resolve-url if present, else any *resolve-url
          // ability. Note: weave-abilities registers none as of 28 Aug 2026,
          // so on Weave sites this tool fails until one exists.
          const cat = await catalog.getCatalog(site.id);
          const resolver =
            cat.byName.has(RESOLVE_URL_ABILITY)
              ? RESOLVE_URL_ABILITY
              : cat.abilities.find((a) => /resolve[-_]?url$/i.test(a.name))?.name;
          if (!resolver) {
            const alsoOn = (await catalog.search("resolve-url", undefined))
              .filter((r) => r.matches.length)
              .map((r) => r.site);
            return fail(`Site "${site.id}" has no URL-resolver ability.`, {
              needed: RESOLVE_URL_ABILITY,
              available_on: alsoOn,
              hint: "No plugin on this site registers a *resolve-url ability. Use wp_search_abilities to find one that does, or list content with the site's own abilities and match the slug.",
            });
          }

          const resolved = await catalog
            .client(site.id)
            .callTool(EXECUTE_TOOL, { ability_name: resolver, parameters: { url } });

          const out: Record<string, unknown> = { site: site.id, url, resolver, resolved };

          // Optional deep fetch: chain to get-post-info if the site has it and
          // we can extract a post id from the resolve result.
          if (args.with_content === true && cat.byName.has(GET_POST_INFO_ABILITY)) {
            const payload = extractPostId(resolved);
            if (payload != null) {
              out.content = await catalog
                .client(site.id)
                .callTool(EXECUTE_TOOL, {
                  ability_name: GET_POST_INFO_ABILITY,
                  parameters: { post_id: payload },
                });
            } else {
              out.content_note = "Could not extract a post id from the resolve result to fetch full content.";
            }
          }
          return ok(out);
        }

        default:
          return fail(`Unknown tool "${name}".`);
      }
    }
  });

  return server;
}
