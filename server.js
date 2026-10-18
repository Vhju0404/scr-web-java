const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const SLOTS_DIR = path.join(DATA_DIR, 'slots');
const SLOTS_FILE = path.join(DATA_DIR, 'slots.json');
const PRESETS_DIR = path.join(ROOT_DIR, 'presets');
const USER_GAMES_DIR = path.join(DATA_DIR, 'user_games');
const USER_GAMES_FILE = path.join(USER_GAMES_DIR, 'catalog.json');
const EMULATOR_JAR = path.join(ROOT_DIR, 'emulator', 'freej2me-headless.jar');
const UPLOAD_TMP_DIR = path.join(DATA_DIR, 'tmp_uploads');

// Ensure directories exist
[DATA_DIR, SLOTS_DIR, PRESETS_DIR, USER_GAMES_DIR, UPLOAD_TMP_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Built-in Preset Games Catalog
const BUILTIN_PRESETS = [
  {
    id: 'nro-250',
    label: 'Ngọc Rồng Online (2.5.0)',
    fileName: 'Ngọc Rồng Online.jar',
    diskPath: path.join(PRESETS_DIR, 'NgocRongOnline-2.5.0.jar'),
    defaultName: 'DragonBoy 2.5.0',
    defaultVendor: 'Team',
    isUserUploaded: false
  },
  {
    id: 'nso-latest',
    label: 'Ninja School Online (Teamobi)',
    fileName: 'Ninja School Online.jar',
    diskPath: path.join(PRESETS_DIR, 'NinjaSchoolOnline.jar'),
    defaultName: 'Ninja School',
    defaultVendor: 'Teamobi',
    isUserUploaded: false
  }
];

function loadUserGamesCatalog() {
  if (!fs.existsSync(USER_GAMES_FILE)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(USER_GAMES_FILE, 'utf8'));
    if (!Array.isArray(list)) return [];
    return list.filter((g) => g.diskPath && fs.existsSync(g.diskPath));
  } catch (e) {
    return [];
  }
}

function saveUserGameToCatalog(entry) {
  const list = loadUserGamesCatalog();
  const existingIdx = list.findIndex((g) => g.fileName === entry.fileName);
  if (existingIdx >= 0) {
    list[existingIdx] = entry;
  } else {
    list.unshift(entry);
  }
  fs.writeFileSync(USER_GAMES_FILE, JSON.stringify(list, null, 2), 'utf8');
  return list;
}

function getAllAvailableGames() {
  const userGames = loadUserGamesCatalog();
  return [...BUILTIN_PRESETS, ...userGames];
}

/**
 * Parse META-INF/MANIFEST.MF from a J2ME .jar file
 */
function parseJarManifest(jarPath, fallbackFileName = 'Game.jar') {
  const stats = fs.statSync(jarPath);
  let name = fallbackFileName.replace(/\.jar$/i, '');
  let version = '';
  let vendor = 'Unknown';
  let hasMidlet = false;

  try {
    const zip = new AdmZip(jarPath);
    const entries = zip.getEntries();
    const manifestEntry = entries.find(
      (e) => e.entryName.toUpperCase() === 'META-INF/MANIFEST.MF'
    );
    const classEntries = entries.filter((e) => e.entryName.endsWith('.class'));

    if (manifestEntry) {
      const content = manifestEntry.getData().toString('utf8');
      const lines = content.split(/\r?\n/);
      const props = {};
      let lastKey = null;
      for (const line of lines) {
        if (line.startsWith(' ') && lastKey) {
          props[lastKey] += line.slice(1);
        } else {
          const idx = line.indexOf(':');
          if (idx > 0) {
            const key = line.slice(0, idx).trim();
            const val = line.slice(idx + 1).trim();
            props[key] = val;
            lastKey = key;
          }
        }
      }
      if (props['MIDlet-Name']) name = props['MIDlet-Name'];
      if (props['MIDlet-Version']) version = props['MIDlet-Version'];
      if (props['MIDlet-Vendor']) vendor = props['MIDlet-Vendor'];
      if (props['MIDlet-1'] || classEntries.length > 0) hasMidlet = true;
    } else if (classEntries.length > 0) {
      hasMidlet = true;
    }
  } catch (err) {
    throw new Error('File .jar không hợp lệ hoặc bị hỏng: ' + err.message);
  }

  if (!hasMidlet) {
    throw new Error('File .jar không chứa MIDlet J2ME hợp lệ.');
  }

  const displayName =
    version && !name.includes(version) ? `${name} ${version}` : name;

  return {
    name: displayName,
    vendor,
    fileSize: stats.size
  };
}

function formatViDateTime(ts = Date.now()) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

/**
 * Represents one Cloud J2ME Slot running in the background 24/7
 */
class SlotInstance {
  constructor(meta, manager) {
    this.meta = meta;
    this.manager = manager;
    this.proc = null;
    this.stdoutBuffer = '';
    this.lastFrame = null;
    this.lastFrameSentAt = 0;
    this.activeTextBox = { active: false };
    this.socketState = { activeSockets: 0, host: '', port: 0, lastEvent: '' };
    this.macroTimers = new Map();
    this.periodicKeyTimer = null;
    this.scheduledRestartTimer = null;
    this.playingMacroId = null;
    this.stopMacroFlag = false;
    this.autoReconnectTimer = null;

    this.slotDir = path.join(SLOTS_DIR, this.meta.id);
    this.rmsDir = path.join(this.slotDir, 'rms');
    if (!fs.existsSync(this.rmsDir)) {
      fs.mkdirSync(this.rmsDir, { recursive: true });
    }

    this.setupAutomationTimers();
  }

  getPublicState() {
    return {
      id: this.meta.id,
      name: this.meta.name,
      running: Boolean(this.proc),
      inGameStatus: this.meta.inGameStatus || 'Chưa vào game',
      plan: this.meta.plan || 'Dùng thử',
      expiresAt: this.meta.expiresAt,
      width: this.meta.width || 240,
      height: this.meta.height || 320,
      fps: this.meta.fps || 12,
      gameInfo: this.meta.gameInfo,
      automation: this.meta.automation,
      activeTextBox: this.activeTextBox,
      socketState: this.socketState,
      playingMacroId: this.playingMacroId
    };
  }

  broadcast(payload) {
    this.manager.broadcastToAll({
      ...payload,
      slotId: this.meta.id
    });
  }

  broadcastFrame(b64) {
    const now = Date.now();
    this.manager.broadcastFrameForSlot(this.meta.id, b64, now);
  }

  broadcastState() {
    this.broadcast({
      type: 'state',
      slot: this.getPublicState()
    });
  }

  start() {
    if (this.proc) return;

    const jarPath = this.meta.gameInfo?.jarPath;
    if (!jarPath || !fs.existsSync(jarPath)) {
      console.error(`[Slot ${this.meta.id}] JAR not found at ${jarPath}`);
      return;
    }

    const width = this.meta.width || 240;
    const height = this.meta.height || 320;
    const fps = this.meta.fps || 12;

    // Lightweight JVM flags (-Xmx96m -Xms32m -XX:+UseSerialGC) for multi-instance efficiency
    const args = [
      '-Djava.awt.headless=true',
      '-Xms32m',
      '-Xmx96m',
      '-XX:+UseSerialGC',
      '-Dfile.encoding=UTF-8',
      '-jar',
      EMULATOR_JAR,
      jarPath,
      this.slotDir,
      String(width),
      String(height),
      String(fps)
    ];

    console.log(`[Slot ${this.meta.id}] Starting headless J2ME: ${path.basename(jarPath)} (${width}x${height} @ ${fps}fps)`);
    const spawnedProc = spawn('java', args, {
      cwd: ROOT_DIR,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.proc = spawnedProc;

    spawnedProc.on('error', () => {});
    if (spawnedProc.stdin) spawnedProc.stdin.on('error', () => {});
    if (spawnedProc.stdout) spawnedProc.stdout.on('error', () => {});
    if (spawnedProc.stderr) spawnedProc.stderr.on('error', () => {});

    this.meta.running = true;
    this.stdoutBuffer = '';
    this.activeTextBox = { active: false };
    this.manager.saveSlots();
    this.broadcastState();

    spawnedProc.stdout.on('data', (chunk) => {
      if (this.proc !== spawnedProc) return;
      this.stdoutBuffer += chunk.toString('utf8');
      let idx;
      while ((idx = this.stdoutBuffer.indexOf('\n')) !== -1) {
        const line = this.stdoutBuffer.slice(0, idx).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
        if (line) this.handleEmulatorLine(line);
      }
    });

    spawnedProc.stderr.on('data', (chunk) => {
      if (this.proc !== spawnedProc) return;
      const text = chunk.toString('utf8').trim();
      if (text && text.includes('FATAL')) {
        console.error(`[Slot ${this.meta.id} ERR]`, text);
      }
    });

    spawnedProc.on('close', (code) => {
      if (this.proc !== spawnedProc) return;
      console.log(`[Slot ${this.meta.id}] Emulator process exited (code ${code})`);
      this.proc = null;
      this.activeTextBox = { active: false };
      this.broadcastState();

      if (this.meta.running) {
        setTimeout(() => {
          if (this.meta.running && !this.proc) {
            this.start();
          }
        }, 2000);
      }
    });
  }

  stop() {
    this.meta.running = false;
    this.stopMacro();
    if (this.proc) {
      try {
        this.sendCommand('QUIT');
        this.proc.kill();
      } catch (e) {}
      this.proc = null;
    }
    this.activeTextBox = { active: false };
    this.manager.saveSlots();
    this.broadcastState();
  }

  destroy() {
    this.stop();
    for (const timer of this.macroTimers.values()) clearInterval(timer);
    this.macroTimers.clear();
    if (this.periodicKeyTimer) clearInterval(this.periodicKeyTimer);
    if (this.scheduledRestartTimer) clearInterval(this.scheduledRestartTimer);
    if (this.autoReconnectTimer) clearTimeout(this.autoReconnectTimer);
  }

  restart() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch (e) {}
      this.proc = null;
    }
    this.meta.running = true;
    this.lastFrame = null;
    this.activeTextBox = { active: false };
    this.start();

    if (this.meta.automation?.autoLoginEnabled) {
      this.scheduleAutoLogin(4500, 'Khởi động lại game');
    }
  }

  handleEmulatorLine(line) {
    if (line.startsWith('FRAME:')) {
      const b64 = line.slice(6);
      this.lastFrame = b64;
      this.broadcastFrame(b64);
    } else if (line.startsWith('TEXTBOX:')) {
      try {
        const tb = JSON.parse(line.slice(8));
        this.activeTextBox = tb;
        this.broadcast({ type: 'textbox', data: tb });
      } catch (e) {}
    } else if (line.startsWith('SOCKET:')) {
      try {
        const prevActive = this.socketState.activeSockets;
        const sock = JSON.parse(line.slice(7));
        this.socketState = {
          activeSockets: sock.activeSockets || 0,
          host: sock.host || '',
          port: sock.port || 0,
          lastEvent: sock.event || ''
        };
        if (
          (sock.event === 'disconnected' || sock.event === 'error') &&
          prevActive > 0 &&
          this.socketState.activeSockets === 0
        ) {
          if (this.meta.inGameStatus === 'Đã vào game') {
            this.meta.inGameStatus = 'Mất kết nối';
            this.broadcastState();
          }
          if (this.meta.automation?.autoLoginEnabled) {
            this.scheduleAutoLogin(3500, 'Mất kết nối máy chủ');
          }
        }
        this.broadcast({ type: 'socket', data: this.socketState });
      } catch (e) {}
    } else if (line.startsWith('READY:')) {
      try {
        const info = JSON.parse(line.slice(6));
        this.meta.width = info.width || this.meta.width;
        this.meta.height = info.height || this.meta.height;
        this.broadcastState();
      } catch (e) {}
    }
  }

  sendCommand(cmd) {
    if (this.proc && this.proc.stdin && !this.proc.stdin.destroyed) {
      try {
        this.proc.stdin.write(cmd + '\n');
      } catch (e) {}
    }
  }

  scheduleAutoLogin(delayMs = 3500, reason = 'Tự động kết nối lại') {
    if (this.autoReconnectTimer) clearTimeout(this.autoReconnectTimer);
    const loginMacro = (this.meta.automation?.macros || []).find(
      (m) => m.type === 'login' && m.steps && m.steps.length > 0
    );
    if (!loginMacro) return;

    this.broadcast({
      type: 'toast',
      message: `[${this.meta.name || this.meta.id}] ${reason}: chạy tự đăng nhập sau ${(delayMs / 1000).toFixed(1)}s...`
    });

    this.autoReconnectTimer = setTimeout(() => {
      if (this.meta.running && this.meta.automation?.autoLoginEnabled) {
        this.playMacro(loginMacro.id);
      }
    }, delayMs);
  }

  async playMacro(macroId) {
    const macro = (this.meta.automation?.macros || []).find((m) => m.id === macroId);
    if (!macro || !macro.steps || macro.steps.length === 0) return;

    if (this.playingMacroId) {
      this.stopMacroFlag = true;
      await new Promise((r) => setTimeout(r, 150));
    }

    this.playingMacroId = macro.id;
    this.stopMacroFlag = false;
    this.broadcastState();
    this.broadcast({
      type: 'toast',
      message: `[${this.meta.name || this.meta.id}] Đang chạy "${macro.name}" (${macro.steps.length} bước)...`
    });

    for (let i = 0; i < macro.steps.length; i++) {
      if (this.stopMacroFlag || !this.proc) break;
      const step = macro.steps[i];
      const waitMs = Math.max(40, Math.min(step.delay || 250, 15000));
      await new Promise((r) => setTimeout(r, waitMs));
      if (this.stopMacroFlag || !this.proc) break;

      this.executeStep(step);
    }

    const finishedMacroType = macro.type;
    const finishedName = macro.name;
    this.playingMacroId = null;
    this.stopMacroFlag = false;

    if (finishedMacroType === 'login' && this.proc) {
      this.meta.inGameStatus = 'Đã vào game';
      this.manager.saveSlots();
    }

    this.broadcastState();
    this.broadcast({
      type: 'toast',
      message: `[${this.meta.name || this.meta.id}] Đã hoàn tất "${finishedName}".`
    });
  }

  stopMacro() {
    this.stopMacroFlag = true;
    this.playingMacroId = null;
    this.broadcastState();
  }

  executeStep(step) {
    switch (step.action) {
      case 'KEY_PRESS':
        this.sendCommand(`KEY_PRESS ${step.keyCode}`);
        break;
      case 'KEY_DOWN':
        this.sendCommand(`KEY_DOWN ${step.keyCode}`);
        break;
      case 'KEY_UP':
        this.sendCommand(`KEY_UP ${step.keyCode}`);
        break;
      case 'CLICK':
        this.sendCommand(`CLICK ${step.x} ${step.y}`);
        break;
      case 'POINTER_DOWN':
        this.sendCommand(`POINTER_DOWN ${step.x} ${step.y}`);
        break;
      case 'POINTER_DRAG':
        this.sendCommand(`POINTER_DRAG ${step.x} ${step.y}`);
        break;
      case 'POINTER_UP':
        this.sendCommand(`POINTER_UP ${step.x} ${step.y}`);
        break;
      case 'TEXT': {
        const b64 = Buffer.from(step.text || '', 'utf8').toString('base64');
        if (this.activeTextBox && this.activeTextBox.active) {
          this.sendCommand(`TEXTBOX_SUBMIT ${b64}`);
        } else {
          this.sendCommand(`TEXT ${b64}`);
        }
        break;
      }
      case 'TEXTBOX_SUBMIT': {
        const b64 = Buffer.from(step.text || '', 'utf8').toString('base64');
        this.sendCommand(`TEXTBOX_SUBMIT ${b64}`);
        break;
      }
      default:
        break;
    }
  }

  setupAutomationTimers() {
    for (const timer of this.macroTimers.values()) {
      clearInterval(timer);
    }
    this.macroTimers.clear();
    if (this.periodicKeyTimer) {
      clearInterval(this.periodicKeyTimer);
      this.periodicKeyTimer = null;
    }
    if (this.scheduledRestartTimer) {
      clearInterval(this.scheduledRestartTimer);
      this.scheduledRestartTimer = null;
    }

    const auto = this.meta.automation || {};

    for (const macro of auto.macros || []) {
      if (macro.loop && macro.intervalSec >= 3) {
        const timer = setInterval(() => {
          if (this.meta.running && !this.playingMacroId) {
            this.playMacro(macro.id);
          }
        }, macro.intervalSec * 1000);
        this.macroTimers.set(macro.id, timer);
      }
    }

    if (auto.periodicKey && auto.periodicKey.enabled && auto.periodicKey.intervalSec >= 1) {
      this.periodicKeyTimer = setInterval(() => {
        if (this.meta.running && !this.playingMacroId) {
          this.sendCommand(`KEY_PRESS ${auto.periodicKey.keyCode}`);
        }
      }, auto.periodicKey.intervalSec * 1000);
    }

    if (auto.scheduledRestart && auto.scheduledRestart.enabled && auto.scheduledRestart.everyHours >= 1) {
      this.scheduledRestartTimer = setInterval(() => {
        if (this.meta.running) {
          this.restart();
        }
      }, auto.scheduledRestart.everyHours * 3600 * 1000);
    }
  }
}

/**
 * Manages all slots and multiplexes frames/events to connected WebSocket clients
 */
class SlotManager {
  constructor() {
    this.slots = new Map();
    this.wsClients = new Set();
    this.loadSlots();
  }

  broadcastToAll(payload) {
    const msg = JSON.stringify(payload);
    for (const ws of this.wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  broadcastFrameForSlot(slotId, b64, now) {
    const msg = JSON.stringify({ type: 'frame', slotId, data: b64 });
    for (const ws of this.wsClients) {
      if (ws.readyState !== WebSocket.OPEN) continue;

      // Smart Eco Mode throttling:
      // Focused slot gets full FPS; unfocused background slots in grid get throttled (~4 FPS) when ecoMode is on
      const isFocused = ws.focusedSlotId === slotId;
      if (!isFocused && ws.ecoMode) {
        const lastSent = ws.lastFrameTimes?.get(slotId) || 0;
        if (now - lastSent < 240) {
          continue;
        }
      }
      if (ws.lastFrameTimes) {
        ws.lastFrameTimes.set(slotId, now);
      }
      ws.send(msg);
    }
  }

  loadSlots() {
    let list = [];
    if (fs.existsSync(SLOTS_FILE)) {
      try {
        list = JSON.parse(fs.readFileSync(SLOTS_FILE, 'utf8'));
      } catch (e) {
        list = [];
      }
    }

    const allGames = getAllAvailableGames();

    if (!Array.isArray(list) || list.length === 0) {
      const defaultPreset = BUILTIN_PRESETS[0];
      const fileSize = fs.existsSync(defaultPreset.diskPath)
        ? fs.statSync(defaultPreset.diskPath).size
        : 1375172;

      list = [
        {
          id: 'JS00005',
          name: 'JS00005',
          running: true,
          inGameStatus: 'Chưa vào game',
          plan: 'Dùng thử',
          expiresAt: Date.now() + 23 * 3600 * 1000 + 50 * 60 * 1000,
          width: 240,
          height: 320,
          fps: 12,
          gameInfo: {
            name: 'DragonBoy 2.5.0',
            vendor: 'Team',
            fileName: 'Ngọc Rồng Online.jar',
            fileSize,
            uploadedAt: '03:51:50 18/4/2026',
            jarPath: defaultPreset.diskPath,
            presetId: 'nro-250'
          },
          automation: {
            autoLoginEnabled: false,
            macros: [],
            periodicKey: {
              enabled: false,
              keyCode: -5,
              intervalSec: 15
            },
            scheduledRestart: {
              enabled: false,
              everyHours: 6
            }
          }
        }
      ];
    }

    for (const item of list) {
      if (item.gameInfo?.presetId) {
        const preset = allGames.find((p) => p.id === item.gameInfo.presetId);
        if (preset && fs.existsSync(preset.diskPath)) {
          item.gameInfo.jarPath = preset.diskPath;
        }
      }
      const instance = new SlotInstance(item, this);
      this.slots.set(item.id, instance);
      if (item.running) {
        instance.start();
      }
    }
    this.saveSlots();
  }

  saveSlots() {
    const data = Array.from(this.slots.values()).map((s) => s.meta);
    fs.writeFileSync(SLOTS_FILE, JSON.stringify(data, null, 2), 'utf8');
  }

  getSlot(id) {
    return this.slots.get(id);
  }

  getAllSlotsPublic() {
    return Array.from(this.slots.values()).map((s) => s.getPublicState());
  }

  createSlot({ customName, presetId, customGameInfo } = {}) {
    let nextNum = 5;
    while (this.slots.has(`JS${String(nextNum).padStart(5, '0')}`)) {
      nextNum++;
    }
    const id = `JS${String(nextNum).padStart(5, '0')}`;
    const allGames = getAllAvailableGames();
    const chosenPreset =
      allGames.find((p) => p.id === presetId) || BUILTIN_PRESETS[0];

    let gameInfo;
    if (customGameInfo) {
      gameInfo = customGameInfo;
    } else {
      const fileSize = fs.existsSync(chosenPreset.diskPath)
        ? fs.statSync(chosenPreset.diskPath).size
        : 1375172;
      gameInfo = {
        name: chosenPreset.defaultName || chosenPreset.label,
        vendor: chosenPreset.defaultVendor || 'Teamobi',
        fileName: chosenPreset.fileName,
        fileSize,
        uploadedAt: formatViDateTime(),
        jarPath: chosenPreset.diskPath,
        presetId: chosenPreset.id
      };
    }

    const meta = {
      id,
      name: customName && customName.trim() ? customName.trim() : id,
      running: true,
      inGameStatus: 'Chưa vào game',
      plan: 'Dùng thử',
      expiresAt: Date.now() + 24 * 3600 * 1000,
      width: 240,
      height: 320,
      fps: 12,
      gameInfo,
      automation: {
        autoLoginEnabled: false,
        macros: [],
        periodicKey: { enabled: false, keyCode: -5, intervalSec: 15 },
        scheduledRestart: { enabled: false, everyHours: 6 }
      }
    };

    const instance = new SlotInstance(meta, this);
    this.slots.set(id, instance);
    instance.start();
    this.saveSlots();
    this.broadcastToAll({
      type: 'slots_updated',
      slots: this.getAllSlotsPublic()
    });
    return instance;
  }

  deleteSlot(id) {
    if (this.slots.size <= 1) {
      throw new Error('Phải giữ lại ít nhất 1 tab máy treo.');
    }
    const slot = this.slots.get(id);
    if (!slot) {
      throw new Error('Không tìm thấy tab máy treo.');
    }
    slot.destroy();
    this.slots.delete(id);
    try {
      if (fs.existsSync(slot.slotDir)) {
        fs.rmSync(slot.slotDir, { recursive: true, force: true });
      }
    } catch (e) {}
    this.saveSlots();
    this.broadcastToAll({
      type: 'slots_updated',
      slots: this.getAllSlotsPublic()
    });
  }
}

const slotManager = new SlotManager();

// Express & HTTP Server Setup
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(ROOT_DIR, 'public')));

// Multer setup for .jar upload (max 20 MB)
const upload = multer({
  dest: UPLOAD_TMP_DIR,
  limits: { fileSize: 20 * 1024 * 1024 }
});

function getPublicPresetsList() {
  return getAllAvailableGames().map((p) => ({
    id: p.id,
    label: p.isUserUploaded ? `📦 ${p.label} (Đã tải lên)` : p.label,
    fileName: p.fileName,
    isUserUploaded: Boolean(p.isUserUploaded)
  }));
}

// REST API Endpoints
app.get('/api/bootstrap', (req, res) => {
  res.json({
    slots: slotManager.getAllSlotsPublic(),
    presets: getPublicPresetsList()
  });
});

// Create a new slot / tab (with optional presetId)
app.post('/api/slots', (req, res) => {
  const { name, presetId } = req.body || {};
  const slot = slotManager.createSlot({ customName: name, presetId });
  res.json({
    slot: slot.getPublicState(),
    slots: slotManager.getAllSlotsPublic(),
    presets: getPublicPresetsList()
  });
});

// Create a new tab and immediately run an uploaded .jar file
app.post('/api/slots/create-with-jar', upload.single('jarFile'), (req, res) => {
  const customName = req.body?.name || '';
  if (!req.file) {
    return res.status(400).json({ error: 'Vui lòng chọn file .jar' });
  }

  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  if (!originalName.toLowerCase().endsWith('.jar')) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Chỉ chấp nhận file định dạng .jar' });
  }

  try {
    const parsed = parseJarManifest(req.file.path, originalName);
    const safeDiskName = `${Date.now()}_${originalName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const sharedJarPath = path.join(USER_GAMES_DIR, safeDiskName);
    fs.copyFileSync(req.file.path, sharedJarPath);
    fs.unlinkSync(req.file.path);

    const userPresetId = 'user_' + Date.now();
    saveUserGameToCatalog({
      id: userPresetId,
      label: `${parsed.name} (${originalName})`,
      fileName: originalName,
      diskPath: sharedJarPath,
      defaultName: parsed.name,
      defaultVendor: parsed.vendor,
      isUserUploaded: true
    });

    const slot = slotManager.createSlot({
      customName,
      customGameInfo: {
        name: parsed.name,
        vendor: parsed.vendor,
        fileName: originalName,
        fileSize: parsed.fileSize,
        uploadedAt: formatViDateTime(),
        jarPath: sharedJarPath,
        presetId: userPresetId
      }
    });

    res.json({
      slot: slot.getPublicState(),
      slots: slotManager.getAllSlotsPublic(),
      presets: getPublicPresetsList()
    });
  } catch (err) {
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(400).json({ error: err.message });
  }
});

// Delete / close a tab
app.delete('/api/slots/:id', (req, res) => {
  try {
    slotManager.deleteSlot(req.params.id);
    const remaining = slotManager.getAllSlotsPublic();
    res.json({
      slots: remaining,
      activeSlot: remaining[0] || null
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Rename or update slot status/expiration
app.patch('/api/slots/:id', (req, res) => {
  const slot = slotManager.getSlot(req.params.id);
  if (!slot) return res.status(404).json({ error: 'Không tìm thấy máy treo' });

  const { name, inGameStatus, extendHours, plan } = req.body || {};
  if (typeof name === 'string' && name.trim()) {
    slot.meta.name = name.trim();
  }
  if (typeof inGameStatus === 'string') {
    slot.meta.inGameStatus = inGameStatus;
  }
  if (typeof extendHours === 'number' && extendHours > 0) {
    const base = Math.max(Date.now(), slot.meta.expiresAt || Date.now());
    slot.meta.expiresAt = base + extendHours * 3600 * 1000;
    if (extendHours >= 24 * 7) {
      slot.meta.plan = 'VIP Cloud';
    }
  }
  if (typeof plan === 'string') {
    slot.meta.plan = plan;
  }

  slotManager.saveSlots();
  slot.broadcastState();
  res.json({ slot: slot.getPublicState(), slots: slotManager.getAllSlotsPublic() });
});

// Start / Stop / Restart slot
app.post('/api/slots/:id/power', (req, res) => {
  const slot = slotManager.getSlot(req.params.id);
  if (!slot) return res.status(404).json({ error: 'Không tìm thấy máy treo' });

  const { action } = req.body || {};
  if (action === 'start') {
    slot.start();
  } else if (action === 'stop') {
    slot.stop();
  } else if (action === 'restart') {
    slot.restart();
  } else if (action === 'toggle') {
    if (slot.proc) slot.stop();
    else slot.start();
  }

  res.json({ slot: slot.getPublicState(), slots: slotManager.getAllSlotsPublic() });
});

// Switch game to a preset or previously uploaded user game
app.post('/api/slots/:id/preset', (req, res) => {
  const slot = slotManager.getSlot(req.params.id);
  if (!slot) return res.status(404).json({ error: 'Không tìm thấy máy treo' });

  const { presetId } = req.body || {};
  const allGames = getAllAvailableGames();
  const preset = allGames.find((p) => p.id === presetId);
  if (!preset) return res.status(400).json({ error: 'Game đã chọn không hợp lệ' });

  const jarPath = preset.diskPath;
  if (!fs.existsSync(jarPath)) {
    return res.status(404).json({ error: 'File game mẫu chưa có trên máy chủ' });
  }

  try {
    const parsed = parseJarManifest(jarPath, preset.fileName);
    slot.meta.gameInfo = {
      name: parsed.name || preset.defaultName,
      vendor: parsed.vendor || preset.defaultVendor,
      fileName: preset.fileName,
      fileSize: parsed.fileSize,
      uploadedAt: formatViDateTime(),
      jarPath,
      presetId: preset.id
    };
    slot.meta.inGameStatus = 'Chưa vào game';
    slotManager.saveSlots();
    slot.restart();
    res.json({
      slot: slot.getPublicState(),
      slots: slotManager.getAllSlotsPublic()
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Upload custom .jar file for a slot & save to shared User Games Library
app.post('/api/slots/:id/upload-jar', upload.single('jarFile'), (req, res) => {
  const slot = slotManager.getSlot(req.params.id);
  if (!slot) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(404).json({ error: 'Không tìm thấy máy treo' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Vui lòng chọn file .jar' });
  }

  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  if (!originalName.toLowerCase().endsWith('.jar')) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Chỉ chấp nhận file định dạng .jar' });
  }

  try {
    const parsed = parseJarManifest(req.file.path, originalName);
    const destJar = path.join(slot.slotDir, 'custom_game.jar');
    fs.copyFileSync(req.file.path, destJar);

    const safeDiskName = `${Date.now()}_${originalName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const sharedJarPath = path.join(USER_GAMES_DIR, safeDiskName);
    fs.copyFileSync(req.file.path, sharedJarPath);
    fs.unlinkSync(req.file.path);

    const userPresetId = 'user_' + Date.now();
    saveUserGameToCatalog({
      id: userPresetId,
      label: `${parsed.name} (${originalName})`,
      fileName: originalName,
      diskPath: sharedJarPath,
      defaultName: parsed.name,
      defaultVendor: parsed.vendor,
      isUserUploaded: true
    });

    slot.meta.gameInfo = {
      name: parsed.name,
      vendor: parsed.vendor,
      fileName: originalName,
      fileSize: parsed.fileSize,
      uploadedAt: formatViDateTime(),
      jarPath: destJar,
      presetId: userPresetId
    };
    slot.meta.inGameStatus = 'Chưa vào game';
    slotManager.saveSlots();
    slot.restart();

    res.json({
      slot: slot.getPublicState(),
      slots: slotManager.getAllSlotsPublic(),
      presets: getPublicPresetsList()
    });
  } catch (err) {
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(400).json({ error: err.message });
  }
});

// Update screen resolution & FPS
app.post('/api/slots/:id/screen', (req, res) => {
  const slot = slotManager.getSlot(req.params.id);
  if (!slot) return res.status(404).json({ error: 'Không tìm thấy máy treo' });

  const width = Math.max(120, Math.min(Number(req.body.width) || 240, 800));
  const height = Math.max(120, Math.min(Number(req.body.height) || 320, 800));
  const fps = Math.max(1, Math.min(Number(req.body.fps) || 12, 60));

  slot.meta.width = width;
  slot.meta.height = height;
  slot.meta.fps = fps;
  slotManager.saveSlots();

  slot.sendCommand(`RESIZE ${width} ${height}`);
  slot.broadcastState();

  res.json({ slot: slot.getPublicState(), slots: slotManager.getAllSlotsPublic() });
});

// Automation & Macro endpoints
app.post('/api/slots/:id/automation', (req, res) => {
  const slot = slotManager.getSlot(req.params.id);
  if (!slot) return res.status(404).json({ error: 'Không tìm thấy máy treo' });

  const { autoLoginEnabled, macros, periodicKey, scheduledRestart } = req.body || {};
  if (!slot.meta.automation) {
    slot.meta.automation = { autoLoginEnabled: false, macros: [] };
  }

  if (typeof autoLoginEnabled === 'boolean') {
    slot.meta.automation.autoLoginEnabled = autoLoginEnabled;
  }
  if (Array.isArray(macros)) {
    slot.meta.automation.macros = macros;
  }
  if (periodicKey && typeof periodicKey === 'object') {
    slot.meta.automation.periodicKey = periodicKey;
  }
  if (scheduledRestart && typeof scheduledRestart === 'object') {
    slot.meta.automation.scheduledRestart = scheduledRestart;
  }

  slot.setupAutomationTimers();
  slotManager.saveSlots();
  slot.broadcastState();

  res.json({ slot: slot.getPublicState(), slots: slotManager.getAllSlotsPublic() });
});

app.post('/api/slots/:id/macros/:macroId/play', (req, res) => {
  const slot = slotManager.getSlot(req.params.id);
  if (!slot) return res.status(404).json({ error: 'Không tìm thấy máy treo' });

  slot.playMacro(req.params.macroId);
  res.json({ ok: true });
});

app.post('/api/slots/:id/macros/stop', (req, res) => {
  const slot = slotManager.getSlot(req.params.id);
  if (!slot) return res.status(404).json({ error: 'Không tìm thấy máy treo' });

  slot.stopMacro();
  res.json({ ok: true });
});

// Multiplexed WebSocket Connection for Parallel Multi-Screen Streaming & Input
wss.on('connection', (ws) => {
  ws.focusedSlotId = 'JS00005';
  ws.ecoMode = true;
  ws.lastFrameTimes = new Map();
  slotManager.wsClients.add(ws);

  // Send initial states & cached frames for ALL slots so side-by-side grid renders immediately
  for (const slot of slotManager.slots.values()) {
    ws.send(
      JSON.stringify({
        type: 'state',
        slotId: slot.meta.id,
        slot: slot.getPublicState()
      })
    );
    if (slot.lastFrame) {
      ws.send(
        JSON.stringify({
          type: 'frame',
          slotId: slot.meta.id,
          data: slot.lastFrame
        })
      );
    }
    if (slot.activeTextBox && slot.activeTextBox.active) {
      ws.send(
        JSON.stringify({
          type: 'textbox',
          slotId: slot.meta.id,
          data: slot.activeTextBox
        })
      );
    }
    slot.sendCommand('KEYFRAME');
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    if (msg.type === 'focus' || msg.type === 'subscribe') {
      if (msg.slotId) {
        ws.focusedSlotId = msg.slotId;
      }
      if (typeof msg.ecoMode === 'boolean') {
        ws.ecoMode = msg.ecoMode;
      }
      const target = slotManager.getSlot(ws.focusedSlotId);
      if (target) {
        if (target.lastFrame) {
          ws.send(
            JSON.stringify({
              type: 'frame',
              slotId: target.meta.id,
              data: target.lastFrame
            })
          );
        }
        target.sendCommand('KEYFRAME');
      }
      return;
    }

    const targetSlotId = msg.slotId || ws.focusedSlotId;
    const targetSlot = slotManager.getSlot(targetSlotId);
    if (!targetSlot) return;

    switch (msg.type) {
      case 'KEY_DOWN':
        targetSlot.sendCommand(`KEY_DOWN ${msg.keyCode}`);
        break;
      case 'KEY_UP':
        targetSlot.sendCommand(`KEY_UP ${msg.keyCode}`);
        break;
      case 'KEY_PRESS':
        targetSlot.sendCommand(`KEY_PRESS ${msg.keyCode}`);
        break;
      case 'POINTER_DOWN':
        targetSlot.sendCommand(`POINTER_DOWN ${msg.x} ${msg.y}`);
        break;
      case 'POINTER_DRAG':
        targetSlot.sendCommand(`POINTER_DRAG ${msg.x} ${msg.y}`);
        break;
      case 'POINTER_UP':
        targetSlot.sendCommand(`POINTER_UP ${msg.x} ${msg.y}`);
        break;
      case 'CLICK':
        targetSlot.sendCommand(`CLICK ${msg.x} ${msg.y}`);
        break;
      case 'TEXT': {
        const b64 = Buffer.from(msg.text || '', 'utf8').toString('base64');
        if (targetSlot.activeTextBox && targetSlot.activeTextBox.active) {
          targetSlot.sendCommand(`TEXTBOX_SUBMIT ${b64}`);
        } else {
          targetSlot.sendCommand(`TEXT ${b64}`);
        }
        break;
      }
      case 'TEXTBOX_SUBMIT': {
        const b64 = Buffer.from(msg.text || '', 'utf8').toString('base64');
        targetSlot.sendCommand(`TEXTBOX_SUBMIT ${b64}`);
        break;
      }
      case 'TEXTBOX_CANCEL':
        targetSlot.sendCommand('TEXTBOX_CANCEL');
        break;
      default:
        break;
    }
  });

  ws.on('error', () => {});

  ws.on('close', () => {
    slotManager.wsClients.delete(ws);
  });
});

function cleanupAllProcesses() {
  for (const slot of slotManager.slots.values()) {
    if (slot.proc) {
      try {
        slot.proc.kill();
      } catch (e) {}
      slot.proc = null;
    }
  }
}

process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err.message);
});

process.on('unhandledRejection', (err) => {
  console.error('[UnhandledRejection]', err);
});

process.on('exit', cleanupAllProcesses);
process.on('SIGINT', () => {
  cleanupAllProcesses();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanupAllProcesses();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`=====================================================`);
  console.log(`🚀 TREO GAME JAVA Server running at http://localhost:${PORT}`);
  console.log(`=====================================================`);
});
