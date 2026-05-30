# 🤖 MC AFK Bot — Dashboard

Anti-AFK Minecraft bot with a real-time web dashboard.

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure the bot**
   ```bash
   cp .env.example .env
   # Edit .env with your server details
   ```

3. **Run**
   ```bash
   node index.js
   ```

4. **Open dashboard**
   ```
   http://localhost:3000
   ```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `MC_HOST` | `your-server.aternos.me` | Your Aternos server address |
| `MC_PORT` | `25565` | Server port |
| `MC_USERNAME` | `AFK_Bot` | Bot's username (offline mode) |
| `MC_VERSION` | `1.20.1` | Minecraft version |
| `WEB_PORT` | `3000` | Web dashboard port |

---

## Dashboard Features

- 🟢 **Live status** — connected / connecting / reconnecting / disconnected
- 📍 **Real-time coordinates** — updates every 3 seconds
- ❤️ **Health & food bars**
- 🖥️ **Console** — all bot logs, chat, errors
- 💬 **Chat** — send messages as the bot
- ⚡ **Commands** — run `/commands` through the bot
- 🔁 **Reconnect / Disconnect** buttons

---

## AFK Behaviour

The bot:
- Subtly wiggles its look direction every 3 seconds
- Toggles sneak every ~10 seconds
- Auto-reconnects on kick or disconnect (5s delay)
- Never leaves the server voluntarily

---

## Hosting (keep it online 24/7)

Use **PM2**:
```bash
npm install -g pm2
pm2 start index.js --name mc-afk-bot
pm2 save
```

Or deploy to **Railway / Render** as a Node.js service.
