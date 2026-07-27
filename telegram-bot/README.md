# BenStream Telegram Bot

Bot Telegram serverless (Vercel) qui sert des **films / séries à la demande** depuis un **canal Telegram privé** où le bot est administrateur.

## Fonctionnement

1. Tu publies (ou re-publies) un film/épisode dans le canal privé.
2. Le bot, admin du canal, reçoit le `channel_post` et **indexe** le titre (caption / nom de fichier) dans Redis (Upstash).
3. Un utilisateur écrit un titre au bot → recherche → boutons → le bot **copie** (`copyMessage`) le média du canal vers le chat privé.

L'utilisateur n'a pas besoin d'être membre du canal.

## Prérequis

1. Créer un bot via [@BotFather](https://t.me/BotFather) → récupérer `BOT_TOKEN`
2. Créer un **canal privé**, y ajouter le bot en **administrateur** (au minimum : publier messages / gérer messages)
3. Récupérer l'`CHANNEL_ID` (ex. `-1001234567890`) via [@userinfobot](https://t.me/userinfobot) ou en forwardant un message du canal à un bot d'ID
4. Créer une base [Upstash Redis](https://upstash.com/) (free tier) → `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
5. Compte [Vercel](https://vercel.com)

## Variables d'environnement

Voir `.env.example` :

| Variable | Rôle |
|---|---|
| `BOT_TOKEN` | Token BotFather |
| `CHANNEL_ID` | ID du canal privé (`-100…`) |
| `WEBHOOK_SECRET` | Secret webhook Telegram |
| `ADMIN_IDS` | IDs Telegram admins (indexation manuelle) |
| `UPSTASH_REDIS_REST_URL` | Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash |
| `PUBLIC_URL` | URL Vercel, ex. `https://xxx.vercel.app` |

## Déploiement Vercel

1. Importer le repo GitHub dans Vercel
2. **Root Directory** : `telegram-bot`
3. Framework preset : Other
4. Ajouter les variables d'environnement
5. Deploy

Puis enregistrer le webhook :

```text
https://TON_DOMAINE.vercel.app/api/setup?secret=WEBHOOK_SECRET
```

Vérifier :

```text
https://TON_DOMAINE.vercel.app/api/health
```

## Conventions de publication (canal)

Pour un catalogue propre, mets une caption claire :

```text
Inception (2010) 1080p VF #film
Breaking Bad S01E01 1080p VOSTFR #serie
Attack on Titan S01E03 #anime
```

Le bot détecte automatiquement :
- type (`#film` / `#serie` / `#anime`, ou heuristique SxxExx)
- saison / épisode (`S01E02`, `1x02`, `Episode 5`)
- année, qualité (`1080p`, `4K`…), langue (`VF`, `VOSTFR`…)

Les séries et animés sont **groupés** : recherche du nom → liste d’épisodes paginée.

## Endpoints

| Route | Description |
|---|---|
| `POST /api/webhook` | Webhook Telegram |
| `GET /api/setup` | Enregistre le webhook |
| `GET /api/health` | Santé + taille catalogue |

## Développement local

```bash
cd telegram-bot
cp .env.example .env
npm install
npx vercel dev
```

Pour le webhook local, utilise un tunnel (ngrok / cloudflared) et mets `PUBLIC_URL` sur l'URL tunnel, puis appelle `/api/setup`.

## Structure

```text
telegram-bot/
├── api/           # Fonctions Vercel
├── src/
│   ├── catalog.ts
│   ├── config.ts
│   ├── telegram.ts
│   └── handlers/
└── vercel.json
```
