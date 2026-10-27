# mevry-app

Cockpit d'agence : page statique et fonctions Vercel dans `api/`.

## Variables d'environnement

À créer sur le projet Vercel **mevryapp**, pour Production, Preview et Development, puis **redéployer**. Une variable ajoutée après le dernier déploiement n'est pas lue tant qu'un nouveau déploiement n'a pas eu lieu. Ne jamais committer les valeurs (voir `.env.example`).

| Variable | Usage |
| --- | --- |
| `DISCORD_WEBHOOK_URL` | URL `https://discord.com/api/webhooks/…` du salon qui reçoit le message quand un projet passe en Dev. Lue par `POST /api/discord-notify`. |
| `CAL_API_KEY` | Clé API Cal.com (Settings → Developer → API keys). Lue par `GET /api/cal-bookings`. |

Sans ces variables, l'interface affiche l'erreur. La synchro Cal.com s'arrête au premier échec au lieu d'interroger toutes les 45 secondes un endpoint mort. Le worker `https://mevry.joxdib.workers.dev` n'est plus utilisé.

## Vérifier

```bash
npm run check
```
