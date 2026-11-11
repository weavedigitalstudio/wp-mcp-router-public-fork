import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";

/**
 * The router read sites.json once at start, so a site connected from another
 * shell stayed invisible until the MCP client restarted it, which T3 Code could
 * not do from inside a session (reset-network.org, 12 November 2026). The server
 * now re-reads the registry when its modification time changes.
 */

process.env.WP_MCP_ROUTER_AUDIT = "off";

let dir: string;
let path: string;
const realFetch = globalThis.fetch;
const prevEnv = { sites: process.env.WP_MCP_ROUTER_SITES, config: process.env.WP_MCP_ROUTER_CONFIG };
let tick = Date.now() / 1000;

function site(id: string, appPassword = "p") {
  return { id, label: id, url: `https://${id}.test`, username: "u", appPassword };
}

/** Write the registry and push its mtime forward, so every write registers. */
function writeRegistry(body: string): void {
  writeFileSync(path, body);
  tick += 10;
  utimesSync(path, tick, tick);
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "wp-mcp-router-reload-"));
  path = join(dir, "sites.json");
  delete process.env.WP_MCP_ROUTER_SITES;
  process.env.WP_MCP_ROUTER_CONFIG = path;
  // No network: every site call fails at once, which wp_list_sites reports per row.
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
  if (prevEnv.sites === undefined) delete process.env.WP_MCP_ROUTER_SITES;
  else process.env.WP_MCP_ROUTER_SITES = prevEnv.sites;
  if (prevEnv.config === undefined) delete process.env.WP_MCP_ROUTER_CONFIG;
  else process.env.WP_MCP_ROUTER_CONFIG = prevEnv.config;
});

async function start() {
  const { config } = loadConfig();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer(config, { configPath: path }).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  let listChanged = 0;
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/tools/list_changed") listChanged++;
  };
  await client.connect(clientSide);
  const listedIds = async (): Promise<string[]> => {
    const res: any = await client.callTool({ name: "wp_list_sites", arguments: {} });
    return JSON.parse(res.content[0].text).sites.map((s: { id: string }) => s.id);
  };
  const enumIds = async (): Promise<string[]> => {
    const { tools } = await client.listTools();
    const run: any = tools.find((t) => t.name === "wp_run");
    return run.inputSchema.properties.site.enum;
  };
  return { client, listedIds, enumIds, listChanged: () => listChanged };
}

test("a site added to the file is live on the next call, schema enum included", async () => {
  writeRegistry(JSON.stringify({ sites: [site("one")] }));
  const r = await start();
  assert.deepEqual(await r.listedIds(), ["one"]);

  writeRegistry(JSON.stringify({ sites: [site("one"), site("two")] }));
  assert.deepEqual(await r.listedIds(), ["one", "two"]);
  assert.deepEqual(await r.enumIds(), ["one", "two"]);
  // Give the notification a turn to arrive.
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(r.listChanged(), 1);
  await r.client.close();
});

test("a broken file keeps the last good registry", async () => {
  writeRegistry(JSON.stringify({ sites: [site("one"), site("two")] }));
  const r = await start();
  writeRegistry('{"sites": [ half written');
  assert.deepEqual(await r.listedIds(), ["one", "two"]);
  // Fixed again: picked up, though the mtime check already saw the broken write.
  writeRegistry(JSON.stringify({ sites: [site("three")] }));
  assert.deepEqual(await r.listedIds(), ["three"]);
  await r.client.close();
});

test("an unchanged file is not re-read and sends no notification", async () => {
  writeRegistry(JSON.stringify({ sites: [site("one")] }));
  const r = await start();
  await r.listedIds();
  await r.listedIds();
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(r.listChanged(), 0);
  await r.client.close();
});
