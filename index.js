const mineflayer = require('mineflayer');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ── Config ──────────────────────────────────────────────────────────────────
const CONFIG = {
  host: process.env.MC_HOST || 'Bhikmanges.aternos.me',
  port: parseInt(process.env.MC_PORT) || 25615,
  username: process.env.MC_USERNAME || 'Bhikmangya',
  version: process.env.MC_VERSION || '1.20.1',
  webPort: parseInt(process.env.WEB_PORT) || 3000,
  reconnectDelay: 5000,
  afkInterval: 3000,
};

// ── State ────────────────────────────────────────────────────────────────────
let bot = null;
let reconnectTimer = null;
let afkTimer = null;
let walkTimer = null;
let jumpTimer = null;
let consoleLog = [];
let status = 'disconnected'; // disconnected | connecting | connected | reconnecting
let botInfo = {
  username: CONFIG.username,
  position: null,
  health: null,
  food: null,
  ping: null,
  dimension: null,
  gameMode: null,
  connectedAt: null,
};

// ── Logger ───────────────────────────────────────────────────────────────────
function log(msg, type = 'info') {
  const entry = {
    time: new Date().toISOString(),
    msg,
    type, // info | error | warn | chat | system
  };
  consoleLog.push(entry);
  if (consoleLog.length > 300) consoleLog.shift();
  io.emit('log', entry);
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

function setStatus(s) {
  status = s;
  io.emit('status', { status, botInfo });
  log(`Status → ${s}`, 'system');
}

// ── AFK Logic ────────────────────────────────────────────────────────────────
function startAFK() {
  stopAFK();
  let tick = 0;
  afkTimer = setInterval(() => {
    if (!bot || status !== 'connected') return;

    // Wiggle look direction to prevent AFK kick
    const yaw = Math.sin(tick * 0.05) * 0.3;
    const pitch = Math.cos(tick * 0.07) * 0.1;
    bot.look(bot.entity.yaw + yaw, bot.entity.pitch + pitch, false);

    // Sneak toggle every ~10s
    if (tick % (10000 / CONFIG.afkInterval) === 0) {
      bot.setControlState('sneak', true);
      setTimeout(() => bot && bot.setControlState('sneak', false), 500);
    }

    tick++;

    // Emit live position
    if (bot.entity) {
      botInfo.position = {
        x: bot.entity.position.x.toFixed(2),
        y: bot.entity.position.y.toFixed(2),
        z: bot.entity.position.z.toFixed(2),
      };
      botInfo.health = bot.health;
      botInfo.food = bot.food;
      botInfo.ping = bot._client?.latency ?? null;
      io.emit('status', { status, botInfo });
    }
  }, CONFIG.afkInterval);

  // Kick off randomized walking and jumping loops
  scheduleWalk();
  scheduleJump();
}

// Take a short forward or back step, then schedule the next one after a
// random gap so the movement doesn't follow a fixed, detectable pattern.
function scheduleWalk() {
  const delay = 4000 + Math.random() * 6000; // next step in 4-10s
  walkTimer = setTimeout(() => {
    if (bot && status === 'connected') {
      const dir = Math.random() < 0.5 ? 'forward' : 'back';
      const stepDuration = 500 + Math.random() * 1000; // hold for 0.5-1.5s

      bot.setControlState(dir, true);
      setTimeout(() => {
        if (bot) bot.setControlState(dir, false);
      }, stepDuration);
    }
    scheduleWalk();
  }, delay);
}

// Occasionally jump in place, on a random timer.
function scheduleJump() {
  const delay = 8000 + Math.random() * 12000; // jump every 8-20s
  jumpTimer = setTimeout(() => {
    if (bot && status === 'connected') {
      bot.setControlState('jump', true);
      setTimeout(() => {
        if (bot) bot.setControlState('jump', false);
      }, 250);
    }
    scheduleJump();
  }, delay);
}

function stopAFK() {
  if (afkTimer) {
    clearInterval(afkTimer);
    afkTimer = null;
  }
  if (walkTimer) {
    clearTimeout(walkTimer);
    walkTimer = null;
  }
  if (jumpTimer) {
    clearTimeout(jumpTimer);
    jumpTimer = null;
  }
  // Release any held movement keys so the bot doesn't get stuck mid-step
  if (bot) {
    ['forward', 'back', 'left', 'right', 'jump', 'sneak'].forEach((c) => {
      try { bot.setControlState(c, false); } catch (_) {}
    });
  }
}

// ── Bot Creation ─────────────────────────────────────────────────────────────
function createBot() {
  if (bot) {
    try { bot.quit(); } catch (_) {}
    bot = null;
  }
  stopAFK();

  setStatus('connecting');
  log(`Connecting to ${CONFIG.host}:${CONFIG.port} as ${CONFIG.username}`, 'system');

  try {
    bot = mineflayer.createBot({
      host: CONFIG.host,
      port: CONFIG.port,
      username: CONFIG.username,
      version: CONFIG.version,
      hideErrors: false,
      auth: 'offline',
    });
  } catch (err) {
    log(`Failed to create bot: ${err.message}`, 'error');
    scheduleReconnect();
    return;
  }

  bot.on('login', () => {
    botInfo.connectedAt = new Date().toISOString();
    botInfo.username = bot.username;
    setStatus('connected');
    log(`Logged in as ${bot.username}`, 'system');
    startAFK();
  });

  bot.on('spawn', () => {
    botInfo.dimension = bot.game?.dimension;
    botInfo.gameMode = bot.game?.gameMode;
    log(`Spawned in ${bot.game?.dimension ?? 'unknown'}`, 'info');
    io.emit('status', { status, botInfo });
  });

  bot.on('chat', (username, message) => {
    log(`<${username}> ${message}`, 'chat');
  });

  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString();
    log(text, 'info');
  });

  bot.on('health', () => {
    botInfo.health = bot.health;
    botInfo.food = bot.food;
    if (bot.health <= 2) {
      log(`⚠ Critical health: ${bot.health}`, 'warn');
    }
  });

  bot.on('kicked', (reason) => {
    log(`Kicked: ${reason}`, 'warn');
    setStatus('reconnecting');
    stopAFK();
    scheduleReconnect();
  });

  bot.on('error', (err) => {
    log(`Error: ${err.message}`, 'error');
  });

  bot.on('end', (reason) => {
    log(`Disconnected: ${reason}`, 'warn');
    if (status === 'connected') {
      setStatus('reconnecting');
    }
    stopAFK();
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  log(`Reconnecting in ${CONFIG.reconnectDelay / 1000}s...`, 'system');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    createBot();
  }, CONFIG.reconnectDelay);
}

// ── Web Server ────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/state', (req, res) => {
  res.json({ status, botInfo, config: { host: CONFIG.host, port: CONFIG.port, username: CONFIG.username }, log: consoleLog.slice(-100) });
});

// ── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  // Send current state to new connection
  socket.emit('init', {
    status,
    botInfo,
    config: { host: CONFIG.host, port: CONFIG.port, username: CONFIG.username },
    log: consoleLog.slice(-100),
  });

  // Run a raw command via bot._client or bot.chat
  socket.on('cmd', (data) => {
    const { type, value } = data;
    if (!bot || status !== 'connected') {
      socket.emit('log', { time: new Date().toISOString(), msg: 'Bot not connected.', type: 'error' });
      return;
    }
    if (type === 'chat') {
      log(`[YOU → chat] ${value}`, 'system');
      bot.chat(value);
    } else if (type === 'command') {
      log(`[YOU → cmd] /${value}`, 'system');
      bot.chat(`/${value}`);
    }
  });

  socket.on('reconnect_bot', () => {
    log('Manual reconnect triggered', 'system');
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    createBot();
  });

  socket.on('disconnect_bot', () => {
    log('Manual disconnect triggered', 'system');
    stopAFK();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (bot) { try { bot.quit('Disconnected from dashboard'); } catch (_) {} bot = null; }
    setStatus('disconnected');
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(CONFIG.webPort, () => {
  console.log(`\n🌐 Dashboard → http://localhost:${CONFIG.webPort}\n`);
  createBot();
});
