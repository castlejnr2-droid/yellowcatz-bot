# 🐱 YellowCatz — $YellowCatz Telegram Bot + Website

A complete play-to-earn Telegram bot and landing website for the **$YellowCatz** Solana SPL token. Collect tokens, battle other players, earn referral bonuses, and withdraw real $YellowCatz to your Solana wallet.

---

## ✨ Features

### Telegram Bot
- **`/start`** — Welcome screen with portfolio overview (Gamble + Spot balances)
- **`/collect`** — Earn 50–1,000 $YellowCatz every 5 minutes
- **`/battle <amount>`** — Challenge players, winner takes the pot via dice roll
- **Manage Funds** — Transfer between Gamble/Spot, withdraw to Solana wallet
- **Referral Program** — Unique link, 500 $YellowCatz per successful referral
- **Admin Commands** — Approve/reject withdrawals, view stats

### Website
- **Landing Page** — Hero, how-it-works, tokenomics, referral explainer, leaderboard preview
- **Leaderboard** — Top Collectors, Battlers, Referrers with podium view
- **Dashboard** — Look up any player's full stats by Telegram ID
- **REST API** — `/api/stats`, `/api/leaderboard`, `/api/user/:id`

### Blockchain
- Solana SPL token withdrawals via `@solana/web3.js` + `@solana/spl-token`
- Admin approval flow with auto-send capability
- Transaction hash stored on completion

---

## 🚀 Quick Start

### 1. Prerequisites
- Node.js v18+
- A Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- A Solana wallet with your SPL token (for the hot wallet)
- Your SPL token's mint address

### 2. Clone & Install
```bash
git clone <your-repo>
cd yellowcatz
npm install
```

### 3. Configure Environment
```bash
cp .env.example .env
```

Edit `.env`:
```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
BOT_USERNAME=YellowCatzBot

DATABASE_URL=./yellowcatz.db

SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_PRIVATE_KEY=your_base58_private_key
YELLOWCATZ_TOKEN_MINT=your_spl_token_mint_address

ADMIN_TELEGRAM_IDS=123456789,987654321
ADMIN_API_KEY=your_secret_admin_key

PORT=3000
BASE_URL=https://yourdomain.com
```

### 4. Start the App
```bash
npm start
# or for development with auto-restart:
npm run dev
```

The bot will start polling Telegram, and the website will be available at `http://localhost:3000`.

---

## 🤖 Bot Commands

| Command | Description |
|---|---|
| `/start` | Show portfolio & main menu |
| `/collect` | Collect free tokens (5m cooldown) |
| `/battle <amount>` | Create a battle challenge |
| `/help` | Show help message |

### Admin Commands (restricted to ADMIN_TELEGRAM_IDS)

| Command | Description |
|---|---|
| `/pending` | List all pending withdrawals |
| `/approve_<id>` | Approve & auto-send a withdrawal |
| `/reject_<id>` | Reject & refund a withdrawal |
| `/stats` | View platform statistics |

---

## 🏗️ Project Structure

```
yellowcatz/
├── src/
│   ├── index.js              # Entry point
│   ├── bot/
│   │   ├── bot.js            # Bot setup & command registration
│   │   ├── commands/
│   │   │   ├── start.js      # /start command
│   │   │   ├── collect.js    # /collect command
│   │   │   └── battle.js     # /battle command
│   │   └── handlers/
│   │       ├── callbacks.js  # Inline button callbacks
│   │       ├── funds.js      # Manage funds flow
│   │       └── referral.js   # Referral menu
│   ├── db/
│   │   ├── index.js          # SQLite connection
│   │   ├── queries.js        # All DB query functions
│   │   └── schema.sql        # Database schema
│   ├── solana/
│   │   └── withdraw.js       # SPL token transfers
│   └── server/
│       ├── index.js          # Express server
│       └── routes/
│           ├── api.js        # Public API routes
│           └── admin.js      # Admin API routes
├── public/
│   ├── index.html            # Landing page
│   ├── leaderboard.html      # Leaderboard page
│   ├── dashboard.html        # Player dashboard
│   ├── css/style.css         # All styles
│   └── js/main.js            # Frontend JS
├── .env.example
├── package.json
└── README.md
```

---

## 🗄️ Database Schema

**SQLite** (via `better-sqlite3`). Tables:

| Table | Description |
|---|---|
| `users` | telegram_id, balances, referral_code, referred_by |
| `collections` | Per-collect record with amount & timestamp |
| `transfers` | Gamble ↔ Spot balance moves |
| `withdrawals` | Withdrawal requests with status & tx_hash |
| `battles` | Battle records with rolls & winner |
| `referrals` | Referral credits |

---

## 🌐 API Endpoints

### Public
```
GET /api/stats                          — Platform stats
GET /api/leaderboard                    — Top collectors/battlers/referrers
GET /api/user/:telegramId               — User overview
GET /api/user/:telegramId/collections   — Collection history
GET /api/user/:telegramId/withdrawals   — Withdrawal history
GET /api/user/:telegramId/battles       — Battle history
```

### Admin (requires `x-admin-key` header)
```
GET  /api/admin/pending-withdrawals     — Pending queue
POST /api/admin/withdrawal/:id/approve  — Approve
POST /api/admin/withdrawal/:id/reject   — Reject & refund
GET  /api/admin/users                   — All users
GET  /api/admin/stats                   — Full stats
```

---

## ⚙️ Getting Your Private Key (Base58)

If you have a Solana keypair JSON file, convert it:
```javascript
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const keypair = Keypair.fromSecretKey(
  new Uint8Array(require('./your-keypair.json'))
);
console.log(bs58.encode(keypair.secretKey));
```

> ⚠️ **Security Warning:** Never commit your `.env` file. Store the hot wallet private key securely. Only fund the hot wallet with tokens needed for withdrawals.

---

## 🚢 Production Deployment

### PM2 (recommended)
```bash
npm install -g pm2
pm2 start src/index.js --name yellowcatz
pm2 save
pm2 startup
```

### Nginx Reverse Proxy
```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Then add SSL with Certbot:
```bash
certbot --nginx -d yourdomain.com
```

---

## 🔧 Customization

| Setting | File | Variable |
|---|---|---|
| Collect range | `src/bot/commands/collect.js` | `MIN_COLLECT`, `MAX_COLLECT` |
| Cooldown | `src/bot/commands/collect.js` | `COOLDOWN_MS` |
| Min withdrawal | `src/bot/handlers/funds.js` | `MIN_WITHDRAW` |
| Referral bonus | `src/bot/commands/collect.js` | `REFERRAL_BONUS` |
| Bot username | `.env` | `BOT_USERNAME` |
| Website bot link | `public/js/main.js` | `BOT_USERNAME` |

---

## 📜 License

MIT — use freely for your token project.
