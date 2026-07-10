// Proxy serverless : garde le webhook Discord côté serveur (variable d'env Vercel),
// jamais exposé dans le code front ni dans le repo Git.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    res.status(500).json({ error: "DISCORD_WEBHOOK_URL not configured" });
    return;
  }
  try {
    const discordRes = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    res.status(discordRes.status).json({ ok: discordRes.ok });
  } catch (err) {
    res.status(502).json({ error: "Discord request failed" });
  }
}
