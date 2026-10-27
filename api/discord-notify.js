// Proxy serverless : le webhook Discord reste dans DISCORD_WEBHOOK_URL (Vercel),
// jamais dans le front ni dans Git.
const WEBHOOK_HOSTS = new Set([
  "discord.com",
  "discordapp.com",
  "canary.discord.com",
  "ptb.discord.com",
]);

function json(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(body);
}

function readBody(req) {
  if (req.body == null || req.body === "") return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  if (typeof req.body === "object") return req.body;
  return null;
}

function isDiscordWebhook(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    if (!WEBHOOK_HOSTS.has(url.hostname.toLowerCase())) return false;
    return /^\/api\/webhooks\/\d+\/[\w-]+/.test(url.pathname);
  } catch {
    return false;
  }
}

function sanitizeEmbed(embed) {
  if (!embed || typeof embed !== "object") return null;
  const out = {};
  if (typeof embed.title === "string" && embed.title.trim()) out.title = embed.title.slice(0, 256);
  if (typeof embed.description === "string" && embed.description.trim()) out.description = embed.description.slice(0, 4096);
  if (Number.isInteger(embed.color) && embed.color >= 0 && embed.color <= 0xffffff) out.color = embed.color;
  if (Array.isArray(embed.fields)) {
    out.fields = embed.fields.slice(0, 25).map((field) => ({
      name: String(field?.name || "").slice(0, 256) || "—",
      value: String(field?.value || "").slice(0, 1024) || "—",
      inline: Boolean(field?.inline),
    }));
  }
  if (embed.footer && typeof embed.footer.text === "string" && embed.footer.text.trim()) {
    out.footer = { text: embed.footer.text.slice(0, 2048) };
  }
  if (typeof embed.timestamp === "string" && !Number.isNaN(Date.parse(embed.timestamp))) {
    out.timestamp = embed.timestamp;
  }
  if (!out.title && !out.description && !(out.fields && out.fields.length)) return null;
  return out;
}

function sanitizePayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const content = typeof body.content === "string" ? body.content.slice(0, 2000) : "";
  const embeds = (Array.isArray(body.embeds) ? body.embeds : []).slice(0, 10).map(sanitizeEmbed).filter(Boolean);
  if (!content.trim() && embeds.length === 0) return null;
  const payload = {};
  if (content.trim()) payload.content = content;
  if (embeds.length) payload.embeds = embeds;
  const roles = body.allowed_mentions && Array.isArray(body.allowed_mentions.roles)
    ? body.allowed_mentions.roles.filter((role) => typeof role === "string" && /^\d{6,22}$/.test(role)).slice(0, 5)
    : [];
  if (roles.length) payload.allowed_mentions = { parse: ["roles"], roles };
  return payload;
}

function redact(text, secret) {
  let out = String(text || "");
  if (secret) {
    out = out.split(secret).join("[redacted]");
    try {
      const token = new URL(secret).pathname.split("/").filter(Boolean).pop();
      if (token && token.length >= 8) out = out.split(token).join("[redacted]");
    } catch { /* URL déjà validée en amont */ }
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 240);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    json(res, 405, { error: "Method not allowed", code: "method_not_allowed" });
    return;
  }

  const webhookUrl = (process.env.DISCORD_WEBHOOK_URL || "").trim();
  if (!webhookUrl) {
    json(res, 503, {
      error: "DISCORD_WEBHOOK_URL not configured",
      message: "Discord n'est pas configuré : ajoute DISCORD_WEBHOOK_URL sur le projet Vercel mevryapp (Production, Preview et Development), puis redéploie.",
      code: "not_configured",
    });
    return;
  }
  if (!isDiscordWebhook(webhookUrl)) {
    json(res, 503, {
      error: "DISCORD_WEBHOOK_URL is not a Discord webhook URL",
      message: "DISCORD_WEBHOOK_URL n'est pas une URL de webhook Discord (https://discord.com/api/webhooks/…).",
      code: "invalid_webhook",
    });
    return;
  }

  const payload = sanitizePayload(readBody(req));
  if (!payload) {
    json(res, 400, {
      error: "Empty Discord message",
      message: "Message Discord vide.",
      code: "empty_message",
    });
    return;
  }

  const endpoint = new URL(webhookUrl);
  endpoint.searchParams.set("wait", "true");

  let discordRes;
  let discordText = "";
  try {
    discordRes = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    discordText = await discordRes.text();
  } catch {
    json(res, 502, {
      error: "Discord request failed",
      message: "Discord est injoignable. Réessaie dans un instant.",
      code: "upstream",
    });
    return;
  }

  if (discordRes.ok) {
    json(res, 200, { ok: true });
    return;
  }

  let discordJson = null;
  try { discordJson = discordText ? JSON.parse(discordText) : null; } catch { discordJson = null; }
  const detail = redact(
    (discordJson && (discordJson.message || discordJson.error)) || discordText,
    webhookUrl,
  );
  const rateLimited = discordRes.status === 429;
  json(res, 502, {
    error: rateLimited ? "Discord rate limited" : "Discord request failed",
    message: rateLimited
      ? "Discord limite les envois. Réessaie dans quelques secondes."
      : (detail ? `Discord a refusé le message (${discordRes.status}) : ${detail}` : `Discord a refusé le message (${discordRes.status}).`),
    code: rateLimited ? "rate_limited" : "upstream",
  });
}
