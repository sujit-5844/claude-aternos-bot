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
  autoSleep: process.env.MC_AUTO_SLEEP !== 'false', // set to "false" to disable
};

// ── State ────────────────────────────────────────────────────────────────────
let bot = null;
let reconnectTimer = null;
let afkTimer = null;
let walkTimer = null;
let jumpTimer = null;
let sleepTimer = null;
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
  if (CONFIG.autoSleep) scheduleSleep();
}

// Step out in a random direction, hold, then walk straight back to the
// same spot, then wait a random gap before picking a new direction.
const OPPOSITE_DIR = { forward: 'back', back: 'forward', left: 'right', right: 'left' };

// Checks if the block the bot is currently standing in/on is water or lava.
function isInLiquid() {
  if (!bot || !bot.entity) return false;
  const block = bot.blockAt(bot.entity.position);
  if (!block) return false;
  return block.name === 'water' || block.name === 'lava' ||
    block.name === 'flowing_water' || block.name === 'flowing_lava';
}

function scheduleWalk() {
  const delay = 4000 + Math.random() * 6000; // wait 4-10s before next move
  walkTimer = setTimeout(() => {
    if (bot && status === 'connected' && !bot.isSleeping) {
      const directions = ['forward', 'back', 'left', 'right'];
      const dir = directions[Math.floor(Math.random() * directions.length)];
      const back = OPPOSITE_DIR[dir];
      const stepDuration = 500 + Math.random() * 1000; // 0.5-1.5s out, same time back

      // Step away from origin, watching for liquid underfoot the whole time
      bot.setControlState(dir, true);
      const liquidWatch = setInterval(() => {
        if (isInLiquid()) {
          clearInterval(liquidWatch);
          returnToOriginAndRedirect(dir);
        }
      }, 150);

      setTimeout(() => {
        clearInterval(liquidWatch);
        if (!bot) return;
        bot.setControlState(dir, false);

        if (isInLiquid()) {
          returnToOriginAndRedirect(dir);
          return;
        }

        // Walk back to origin
        bot.setControlState(back, true);
        setTimeout(() => {
          if (bot) bot.setControlState(back, false);
        }, stepDuration);
      }, stepDuration);
    }
    scheduleWalk();
  }, delay);
}

// Hit water/lava: stop, reverse straight back to origin, then pick a fresh
// direction on the next cycle instead of continuing the current one.
function returnToOriginAndRedirect(dir) {
  if (!bot) return;
  log(`⚠ Liquid detected, returning to origin`, 'warn');
  bot.setControlState(dir, false);
  const back = OPPOSITE_DIR[dir];
  bot.setControlState(back, true);
  setTimeout(() => {
    if (bot) bot.setControlState(back, false);
  }, 1200); // slightly longer hold to make sure it clears the liquid
}

// Occasionally jump in place, on a random timer.
function scheduleJump() {
  const delay = 8000 + Math.random() * 12000; // jump every 8-20s
  jumpTimer = setTimeout(() => {
    if (bot && status === 'connected' && !bot.isSleeping) {
      bot.setControlState('jump', true);
      setTimeout(() => {
        if (bot) bot.setControlState('jump', false);
      }, 250);
    }
    scheduleJump();
  }, delay);
}

// Find a bed block within reach of the bot.
function findBed() {
  if (!bot || !bot.registry) return null;
  const bedIds = bot.registry.blocksArray
    .filter((b) => b.name.endsWith('_bed'))
    .map((b) => b.id);

  return bot.findBlock({
    matching: (block) => bedIds.includes(block.type),
    maxDistance: 8,
  });
}

// Every ~15s, check whether it's night and the bot should hop into bed,
// or whether it's day and the bot should get back up.
function scheduleSleep() {
  sleepTimer = setTimeout(() => {
    if (bot && status === 'connected' && bot.time) {
      const t = bot.time.timeOfDay; // 0-24000
      const canSleep = t >= 12541 && t <= 23458; // Minecraft's "sleepable" window

      if (bot.isSleeping) {
        if (!canSleep) {
          bot.wake().catch((err) => log(`Wake failed: ${err.message}`, 'warn'));
        }
      } else if (canSleep) {
        const bed = findBed();
        if (bed) {
          bot.sleep(bed).catch((err) => log(`Sleep failed: ${err.message}`, 'warn'));
        }
      }
    }
    scheduleSleep();
  }, 15000);
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
  if (sleepTimer) {
    clearTimeout(sleepTimer);
    sleepTimer = null;
  }
  // Release any held movement keys so the bot doesn't get stuck mid-step
  if (bot) {
    ['forward', 'back', 'left', 'right', 'jump', 'sneak'].forEach((c) => {
      try { bot.setControlState(c, false); } catch (_) {}
    });
    if (bot.isSleeping) {
      bot.wake().catch(() => {});
    }
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

  bot.on('sleep', () => {
    log('💤 Went to sleep', 'system');
  });

  bot.on('wake', () => {
    log('☀ Woke up', 'system');
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
