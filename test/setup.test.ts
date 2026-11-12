import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { looksLikeAppPassword, preflightAuthorizeUrl } from "../src/setup.js";

const AUTHZ_PATH =
  "/wp-admin/authorize-application.php?app_name=wp-mcp-router&app_id=t&success_url=http%3A%2F%2F127.0.0.1%3A1%2Fcallback";

/** A one-response stand-in for a site, answering `status` to everything. */
async function siteAnswering(status: number, headers: Record<string, string> = {}) {
  const server = createServer((_req, res) => {
    res.writeHead(status, headers);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}${AUTHZ_PATH}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("preflight accepts the wp-login redirect a signed-out WordPress sends", async () => {
  const site = await siteAnswering(302, { Location: "/wp-login.php?redirect_to=x&reauth=1" });
  try {
    await preflightAuthorizeUrl(site.url);
  } finally {
    await site.close();
  }
});

test("preflight accepts 200 (a session already exists)", async () => {
  const site = await siteAnswering(200);
  try {
    await preflightAuthorizeUrl(site.url);
  } finally {
    await site.close();
  }
});

test("preflight rejects a firewall 403 and says so", async () => {
  // What GridPane 7G bad_querystring rule 10 does to a 127.0.0.1 success_url.
  const site = await siteAnswering(403);
  try {
    await assert.rejects(preflightAuthorizeUrl(site.url), /HTTP 403.*firewall/i);
  } finally {
    await site.close();
  }
});

test("preflight rejects other non-2xx/3xx answers without the firewall hint", async () => {
  const site = await siteAnswering(500);
  try {
    await assert.rejects(preflightAuthorizeUrl(site.url), (err: Error) => {
      assert.match(err.message, /HTTP 500/);
      assert.doesNotMatch(err.message, /firewall/i);
      return true;
    });
  } finally {
    await site.close();
  }
});

test("preflight rejects an unreachable site", async () => {
  // Bind then close to get a port nothing is listening on.
  const site = await siteAnswering(200);
  await site.close();
  await assert.rejects(preflightAuthorizeUrl(site.url), /Could not reach/);
});

test("an application password at the login prompt is caught, spaced or not", () => {
  assert.equal(looksLikeAppPassword("abcd EFGH 1234 ijkl MNOP 5678"), true);
  assert.equal(looksLikeAppPassword("  abcdEFGH1234ijklMNOP5678 "), true);
});

test("real logins are not mistaken for an application password", () => {
  for (const login of ["site_admin", "admin", "someone@example.com", "abcd efgh", "abcdefghijklmnopqrstuvwx"]) {
    assert.equal(looksLikeAppPassword(login), false, login);
  }
});
