import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import discordNotify from "../api/discord-notify.js";
import calBookings from "../api/cal-bookings.js";

const WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/superSecretToken";
const CAL_KEY = "super-secret-cal-key";

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function call(handler, { method = "GET", body, env = {}, fetchMock } = {}) {
  const keys = ["DISCORD_WEBHOOK_URL", "CAL_API_KEY"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, env);
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (!fetchMock) throw new Error("fetch inattendu");
    return fetchMock(url, init, calls);
  };
  try {
    const res = mockRes();
    await handler({ method, body }, res);
    return { res, calls };
  } finally {
    globalThis.fetch = original;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function assertNoSecret(value, secret) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(secret), false, "la réponse contient un secret");
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test("discord refuse les méthodes autres que POST", async () => {
  const { res, calls } = await call(discordNotify, { method: "GET" });
  assert.equal(res.statusCode, 405);
  assert.equal(calls.length, 0);
});

test("discord sans variable répond 503 et ne contacte pas Discord", async () => {
  const { res, calls } = await call(discordNotify, {
    method: "POST",
    body: { content: "ping" },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, "DISCORD_WEBHOOK_URL not configured");
  assert.equal(res.body.code, "not_configured");
  assert.match(res.body.message, /mevryapp/);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(calls.length, 0);
});

test("discord refuse une URL qui n'est pas un webhook Discord", async () => {
  const { res, calls } = await call(discordNotify, {
    method: "POST",
    body: { content: "ping" },
    env: { DISCORD_WEBHOOK_URL: "https://example.com/api/webhooks/123/abcdefghi" },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "invalid_webhook");
  assert.equal(calls.length, 0);
});

test("discord refuse un message vide avant d'appeler Discord", async () => {
  const { res, calls } = await call(discordNotify, {
    method: "POST",
    body: {},
    env: { DISCORD_WEBHOOK_URL: WEBHOOK },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "empty_message");
  assert.equal(calls.length, 0);
});

test("discord confirme l'envoi et retire l'image d'embed", async () => {
  const { res, calls } = await call(discordNotify, {
    method: "POST",
    body: {
      content: "<@&1522187964430549122>",
      embeds: [{ title: "Projet", description: "Prêt", image: { url: "https://cdn.discordapp.com/expired.png" }, color: 5721851 }],
      allowed_mentions: { roles: ["1522187964430549122", "not-a-role"] },
    },
    env: { DISCORD_WEBHOOK_URL: WEBHOOK },
    fetchMock: async () => jsonResponse(200, { id: "1" }),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(calls.length, 1);
  const sentUrl = new URL(calls[0].url);
  assert.equal(sentUrl.searchParams.get("wait"), "true");
  assert.equal(sentUrl.hostname, "discord.com");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.embeds[0].image, undefined);
  assert.deepEqual(sent.allowed_mentions.roles, ["1522187964430549122"]);
});

test("discord masque le token si Discord le renvoie dans l'erreur", async () => {
  const { res } = await call(discordNotify, {
    method: "POST",
    body: { content: "ping" },
    env: { DISCORD_WEBHOOK_URL: WEBHOOK },
    fetchMock: async () => jsonResponse(429, { message: `slow down ${WEBHOOK}` }),
  });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.code, "rate_limited");
  assertNoSecret(res.body, "superSecretToken");
  assertNoSecret(res.body, WEBHOOK);
});

test("discord signale Discord injoignable", async () => {
  const { res } = await call(discordNotify, {
    method: "POST",
    body: { content: "ping" },
    env: { DISCORD_WEBHOOK_URL: WEBHOOK },
    fetchMock: async () => { throw new Error("network"); },
  });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.code, "upstream");
});

test("cal refuse les méthodes autres que GET", async () => {
  const { res, calls } = await call(calBookings, { method: "POST" });
  assert.equal(res.statusCode, 405);
  assert.equal(calls.length, 0);
});

test("cal sans variable répond 503 et n'appelle pas Cal.com", async () => {
  const { res, calls } = await call(calBookings, { method: "GET" });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, "CAL_API_KEY not configured");
  assert.equal(res.body.code, "not_configured");
  assert.match(res.body.message, /mevryapp/);
  assert.equal(calls.length, 0);
});

test("cal pagine le curseur v2 et dédoublonne les uid", async () => {
  const { res, calls } = await call(calBookings, {
    method: "GET",
    env: { CAL_API_KEY: CAL_KEY },
    fetchMock: async (url, init) => {
      assert.equal(init.headers["cal-api-version"], "2026-05-01");
      assert.equal(init.headers.Authorization, `Bearer ${CAL_KEY}`);
      const cursor = new URL(url).searchParams.get("cursor");
      if (cursor === "c2") {
        return jsonResponse(200, {
          data: [{ uid: "b", start: "2026-03-02T09:00:00.000Z" }],
          pagination: { hasMore: false, nextCursor: null },
        });
      }
      return jsonResponse(200, {
        data: [
          { uid: "a", start: "2026-03-01T09:00:00.000Z" },
          { uid: "a", start: "2026-03-01T09:00:00.000Z" },
        ],
        pagination: { hasMore: true, nextCursor: "c2" },
      });
    },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.bookings.map((b) => b.uid), ["a", "b"]);
  assert.equal(calls.length, 2);
  assertNoSecret(res.body, CAL_KEY);
});

test("cal retombe sur l'API v1 si la clé est refusée en v2", async () => {
  const { res, calls } = await call(calBookings, {
    method: "GET",
    env: { CAL_API_KEY: CAL_KEY },
    fetchMock: async (url) => {
      const href = String(url);
      if (href.includes("/v2/")) return jsonResponse(401, { message: `bad ${CAL_KEY}` });
      assert.match(href, /\/v1\/bookings\?apiKey=/);
      return jsonResponse(200, [{ uid: "legacy", status: "ACCEPTED", startTime: "2026-01-01T10:00:00.000Z" }]);
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.bookings[0].uid, "legacy");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers["cal-api-version"], "2026-05-01");
});

test("cal n'essaie pas v1 après une erreur 500", async () => {
  const { res, calls } = await call(calBookings, {
    method: "GET",
    env: { CAL_API_KEY: CAL_KEY },
    fetchMock: async () => jsonResponse(500, { message: `boom ${CAL_KEY}` }),
  });
  assert.equal(res.statusCode, 502);
  assert.equal(calls.length, 1);
  assertNoSecret(res.body, CAL_KEY);
});

test("cal essaie la version 2024-08-13 si 2026-05-01 est refusée", async () => {
  const { res, calls } = await call(calBookings, {
    method: "GET",
    env: { CAL_API_KEY: CAL_KEY },
    fetchMock: async (_url, init) => {
      if (init.headers["cal-api-version"] === "2026-05-01") return jsonResponse(400, { message: "unsupported" });
      assert.equal(init.headers["cal-api-version"], "2024-08-13");
      return jsonResponse(200, {
        data: [{ bookings: [{ uid: "child", start: "2026-04-01T09:00:00.000Z" }] }],
        pagination: { hasNextPage: false },
      });
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.bookings[0].uid, "child");
  assert.equal(calls.length, 2);
});

test("cal masque la clé quand v1 refuse aussi", async () => {
  const { res } = await call(calBookings, {
    method: "GET",
    env: { CAL_API_KEY: CAL_KEY },
    fetchMock: async (url) => jsonResponse(401, { message: `nope ${encodeURIComponent(String(url).includes("/v1/") ? CAL_KEY : CAL_KEY)}` }),
  });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.code, "unauthorized");
  assertNoSecret(res.body, CAL_KEY);
  assertNoSecret(res.body, encodeURIComponent(CAL_KEY));
});

test("le front n'appelle plus le worker Cloudflare et affiche les erreurs", () => {
  for (const file of ["index.html", "mevry-os (24).html"]) {
    const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", file), "utf8");
    assert.equal(html.includes("mevry.joxdib.workers.dev"), false, file);
    assert.equal(html.includes("DISCORD_BANNER_URL"), false, file);
    assert.equal(html.includes("/* silencieux"), false, file);
    assert.match(html, /\/api\/cal-bookings/);
    assert.match(html, /function stopCalPoll/);
    assert.match(html, /id="automation-banner"/);
    assert.match(html, /showAutomationAlert\("discord"/);
    assert.match(html, /if \(!res\.ok\)/);
  }
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(err);
  }
}
if (failed) {
  console.error(`${failed} test(s) en échec`);
  process.exit(1);
}
console.log(`${tests.length} tests ok`);
