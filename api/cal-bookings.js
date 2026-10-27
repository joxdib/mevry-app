// Remplace le worker Cloudflare https://mevry.joxdib.workers.dev (404).
// La clé reste dans CAL_API_KEY, côté Vercel. Le navigateur n'appelle que cette route.
const CAL_VERSIONS = ["2026-05-01", "2024-08-13"];
const MAX_PAGES = 8;

function json(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(body);
}

function fail(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.publicMessage = message;
  return err;
}

function redact(text, secret) {
  let out = String(text || "");
  if (secret) {
    out = out.split(secret).join("[redacted]");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join("[redacted]");
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 240);
}

function upstreamDetail(jsonBody, text, apiKey) {
  const raw = (jsonBody && (
    jsonBody.message
    || (jsonBody.error && jsonBody.error.message)
    || (typeof jsonBody.error === "string" ? jsonBody.error : "")
  )) || text || "";
  return redact(raw, apiKey);
}

function messageFor(status, jsonBody, text, apiKey) {
  if (status === 401 || status === 403) return "Clé Cal.com refusée. Vérifie CAL_API_KEY (clé API, pas le mot de passe du compte).";
  if (status === 429) return "Cal.com limite les appels. Réessaie dans une minute.";
  const detail = upstreamDetail(jsonBody, text, apiKey);
  return detail ? `Cal.com a répondu ${status} : ${detail}` : `Cal.com a répondu ${status}.`;
}

function normalizeList(jsonBody) {
  if (Array.isArray(jsonBody)) return jsonBody;
  if (Array.isArray(jsonBody?.bookings)) return jsonBody.bookings;
  if (Array.isArray(jsonBody?.data)) return jsonBody.data;
  if (Array.isArray(jsonBody?.data?.bookings)) return jsonBody.data.bookings;
  return null;
}

function flatten(items) {
  const out = [];
  for (const item of items) {
    if (item && !item.uid && Array.isArray(item.bookings)) out.push(...item.bookings);
    else if (item) out.push(item);
  }
  return out;
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item && item.uid;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function calRequest(url, apiKey, version) {
  let response;
  let text = "";
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "cal-api-version": version,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
    text = await response.text();
  } catch {
    throw fail(502, "upstream", "Cal.com est injoignable. Réessaie dans un instant.");
  }
  let jsonBody = null;
  try { jsonBody = text ? JSON.parse(text) : null; } catch { jsonBody = null; }
  return { ok: response.ok, status: response.status, json: jsonBody, text };
}

async function fetchCalVersion(apiKey, version) {
  const all = [];
  const seenCursors = new Set();
  let cursor = "";
  let skip = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL("https://api.cal.com/v2/bookings");
    url.searchParams.set("take", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    else if (skip) url.searchParams.set("skip", String(skip));
    const result = await calRequest(url, apiKey, version);
    if (!result.ok) {
      const code = result.status === 401 || result.status === 403 ? "unauthorized" : "upstream";
      throw fail(result.status, code, messageFor(result.status, result.json, result.text, apiKey));
    }
    const batch = normalizeList(result.json);
    if (!batch) throw fail(502, "upstream", "Réponse Cal.com inattendue.");
    all.push(...flatten(batch));
    const pagination = result.json?.pagination || {};
    if (pagination.hasMore && pagination.nextCursor && !seenCursors.has(pagination.nextCursor)) {
      seenCursors.add(pagination.nextCursor);
      cursor = pagination.nextCursor;
      continue;
    }
    if (pagination.hasMore) break;
    if (pagination.hasNextPage && batch.length > 0) {
      skip += batch.length;
      continue;
    }
    break;
  }
  return dedupe(all);
}

async function fetchCalV1(apiKey) {
  const url = new URL("https://api.cal.com/v1/bookings");
  url.searchParams.set("apiKey", apiKey);
  let response;
  let text = "";
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    text = await response.text();
  } catch {
    throw fail(502, "upstream", "Cal.com est injoignable. Réessaie dans un instant.");
  }
  let jsonBody = null;
  try { jsonBody = text ? JSON.parse(text) : null; } catch { jsonBody = null; }
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? "unauthorized" : "upstream";
    throw fail(response.status, code, messageFor(response.status, jsonBody, text, apiKey));
  }
  const batch = normalizeList(jsonBody);
  if (!batch) throw fail(502, "upstream", "Réponse Cal.com inattendue.");
  return dedupe(flatten(batch));
}

async function loadBookings(apiKey) {
  let authError = null;
  for (const version of CAL_VERSIONS) {
    try {
      return await fetchCalVersion(apiKey, version);
    } catch (err) {
      if (err.code === "unauthorized") {
        authError = err;
        break;
      }
      if (err.status === 400 || err.status === 404 || err.status === 406) continue;
      throw err;
    }
  }
  try {
    return await fetchCalV1(apiKey);
  } catch (err) {
    if (authError && err.code === "unauthorized") throw authError;
    throw err;
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    json(res, 405, { error: "Method not allowed", code: "method_not_allowed" });
    return;
  }
  const apiKey = (process.env.CAL_API_KEY || "").trim();
  if (!apiKey) {
    json(res, 503, {
      error: "CAL_API_KEY not configured",
      message: "Cal.com n'est pas configuré : ajoute CAL_API_KEY sur le projet Vercel mevryapp (Production, Preview et Development), puis redéploie.",
      code: "not_configured",
    });
    return;
  }
  try {
    const bookings = await loadBookings(apiKey);
    json(res, 200, { bookings });
  } catch (err) {
    json(res, 502, {
      error: err.code === "unauthorized" ? "Cal.com rejected the API key" : "Cal.com request failed",
      message: err.publicMessage || "La synchro Cal.com a échoué.",
      code: err.code || "upstream",
    });
  }
}
