const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { AppDb, PLANS, getPlan, hashPassword, verifyPassword } = require('./db');
const { loadProducts } = require('./pricing');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const SLOTS_DIR = path.join(DATA_DIR, 'slots');
const LEGACY_SLOTS_FILE = path.join(DATA_DIR, 'slots.json');
const DB_FILE = path.join(DATA_DIR, 'app.db');
const PRESETS_DIR = path.join(ROOT_DIR, 'presets');
const USER_GAMES_DIR = path.join(DATA_DIR, 'user_games');
const LEGACY_USER_GAMES_FILE = path.join(USER_GAMES_DIR, 'catalog.json');
const EMULATOR_JAR = path.join(ROOT_DIR, 'emulator', 'freej2me-headless.jar');
const UPLOAD_TMP_DIR = path.join(DATA_DIR, 'tmp_uploads');

const HOST = process.env.HOST || '0.0.0.0';
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
// Cho phép người lạ tự đăng ký tài khoản (chưa có gói, admin cấp sau). ALLOW_REGISTER=false để tắt.
const ALLOW_REGISTER = process.env.ALLOW_REGISTER !== 'false';
// File .jar là code Java chạy thẳng trên máy chủ -> mặc định chỉ admin được tải lên.
// ALLOW_USER_UPLOAD=true chỉ nên bật khi mỗi slot đã chạy trong sandbox (container riêng).
const ALLOW_USER_UPLOAD = process.env.ALLOW_USER_UPLOAD === 'true';
// Số game .jar tối đa mỗi user (không phải admin) được lưu trong kho riêng
const MAX_USER_GAMES = 20;
// Tổng số tab chạy cùng lúc trên cả máy chủ. Mỗi JVM ~160MB RAM, chừa ~1.5GB cho hệ thống.
const MAX_TOTAL_RUNNING =
  toInt(process.env.MAX_TOTAL_RUNNING) ||
  Math.max(1, Math.floor((os.totalmem() - 1.5 * 1024 ** 3) / (160 * 1024 ** 2)));
// Thông tin liên hệ mua gói, hiện cho khách chưa có gói (vd. "Zalo 09xx / fb.com/abc")
// (CONTACT_INFO trong .env chỉ là mặc định, admin sửa trong /admin.html -> xem contactInfo())
const BACKUP_KEEP_DAYS = toInt(process.env.BACKUP_KEEP_DAYS) || 7;
const SESSION_COOKIE = 'sid';
// Stream hình: tab đang chọn chạy theo FPS của slot (mặc định 20, game NRO tự chạy ~36 vòng/giây),
// tab nền trong lưới (chế độ Siêu nhẹ) chạy ECO_FPS, không ai xem thì 0 (không tốn CPU mã hóa).
const DEFAULT_FPS = 20;
const ECO_FPS = 4;

// Watchdog tự cứu acc (bật mặc định, tắt từng tab trong "Tự đăng nhập & Chống AFK")
const WATCHDOG = {
  checkEveryMs: 15 * 1000,
  startupGraceMs: 90 * 1000, // game đang tải sau khi khởi động
  frozenMs: 60 * 1000, // game không vẽ khung nào (luồng chính chết)
  silentMs: 45 * 1000, // emulator không gửi nhịp tim ALIVE (treo cứng)
  disconnectedMs: 3 * 60 * 1000, // mất kết nối máy chủ game liên tục
  maxRestartsPerHour: 5
};

// ---------------------------------------------------------------------------
// Thanh toán chuyển khoản: VietQR để khách quét, SePay / Casso báo tiền về qua webhook
// ---------------------------------------------------------------------------
// Ngân hàng, liên hệ, key webhook: admin nhập ở /admin.html (lưu trong DB), .env chỉ là mặc định.
// Đọc qua setting() mỗi lần dùng nên admin đổi xong có hiệu lực ngay, không cần khởi động lại.
const PAYMENT_SETTINGS = {
  contact_info: { env: 'CONTACT_INFO', secret: false },
  bank_id: { env: 'BANK_ID', secret: false }, // mã ngân hàng VietQR, vd. MB, VCB, ACB, TCB hoặc BIN 970422
  bank_account_no: { env: 'BANK_ACCOUNT_NO', secret: false },
  bank_account_name: { env: 'BANK_ACCOUNT_NAME', secret: false },
  sepay_api_key: { env: 'SEPAY_API_KEY', secret: true },
  casso_checksum_key: { env: 'CASSO_CHECKSUM_KEY', secret: true },
  casso_secure_token: { env: 'CASSO_SECURE_TOKEN', secret: true }
};

function setting(key) {
  const fromDb = db.getSetting(key);
  return fromDb !== null ? fromDb : process.env[PAYMENT_SETTINGS[key].env] || '';
}

function contactInfo() {
  return setting('contact_info') || 'Liên hệ admin để mua gói.';
}

function bankInfo() {
  return {
    id: setting('bank_id'),
    accountNo: setting('bank_account_no'),
    accountName: setting('bank_account_name')
  };
}

function billingEnabled() {
  const b = bankInfo();
  return Boolean(b.id && b.accountNo);
}

// Tiền tố mã nạp tiền trong nội dung chuyển khoản (chỉ chữ in hoa + số).
// Không cho sửa trong web: đổi tiền tố thì mã nạp cũ của khách sẽ không khớp nữa.
const PAY_PREFIX = (process.env.PAY_PREFIX || 'TREO').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ---------------------------------------------------------------------------
// Input helpers (chống chèn lệnh vào stdin của emulator)
// ---------------------------------------------------------------------------
function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

const MACRO_ACTIONS = new Set([
  'KEY_PRESS', 'KEY_DOWN', 'KEY_UP', 'CLICK',
  'POINTER_DOWN', 'POINTER_DRAG', 'POINTER_UP', 'TEXT', 'TEXTBOX_SUBMIT'
]);

const IN_GAME_STATUSES = new Set(['Đã vào game', 'Đang treo', 'Chưa vào game', 'Mất kết nối']);

function sanitizeMacros(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const m of list.slice(0, 50)) {
    if (!m || typeof m !== 'object') continue;
    const id = String(m.id || '').replace(/[^\w-]/g, '').slice(0, 64);
    if (!id) continue;
    const steps = [];
    for (const st of (Array.isArray(m.steps) ? m.steps : []).slice(0, 3000)) {
      if (!st || !MACRO_ACTIONS.has(st.action)) continue;
      const step = { action: st.action, delay: Math.max(0, Math.min(toInt(st.delay) ?? 250, 15000)) };
      if (st.action.startsWith('KEY_')) {
        const kc = toInt(st.keyCode);
        if (kc === null) continue;
        step.keyCode = kc;
      } else if (st.action === 'TEXT' || st.action === 'TEXTBOX_SUBMIT') {
        step.text = String(st.text ?? '').slice(0, 500);
      } else {
        const x = toInt(st.x), y = toInt(st.y);
        if (x === null || y === null) continue;
        step.x = x; step.y = y;
      }
      steps.push(step);
    }
    out.push({
      id,
      name: String(m.name || 'Kịch bản').slice(0, 100),
      type: m.type === 'login' ? 'login' : 'loop',
      steps,
      loop: Boolean(m.loop),
      intervalSec: Math.max(3, Math.min(toInt(m.intervalSec) ?? 30, 86400))
    });
  }
  return out;
}

// Ensure directories exist
[DATA_DIR, SLOTS_DIR, PRESETS_DIR, USER_GAMES_DIR, UPLOAD_TMP_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Khóa mã hóa dữ liệu slot: SECRET_KEY hoặc data/secret.key (tự sinh).
// MẤT KHÓA = MẤT DỮ LIỆU SLOT, luôn sao lưu kèm app.db.
function loadSecretKey() {
  if (process.env.SECRET_KEY) {
    return crypto.createHash('sha256').update(process.env.SECRET_KEY).digest();
  }
  const keyFile = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(keyFile)) {
    fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64'), { encoding: 'utf8', mode: 0o600 });
    console.log(`[SECURE] Đã tạo khóa mã hóa ${keyFile} — hãy sao lưu file này`);
  }
  const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error('data/secret.key không hợp lệ (cần 32 byte base64)');
  return key;
}

const db = new AppDb(DB_FILE, loadSecretKey());

// ---------------------------------------------------------------------------
// Tài khoản admin đầu tiên: user ACCESS_USER (mặc định 'admin'),
// mật khẩu ACCESS_PASSWORD hoặc data/access.txt (tự sinh nếu chưa có).
// Chỉ dùng khi DB chưa có user nào; sau đó đổi mật khẩu trong giao diện.
// ---------------------------------------------------------------------------
function ensureAdminAccount() {
  if (db.countUsers() > 0) return;
  const username = process.env.ACCESS_USER || 'admin';
  let password = process.env.ACCESS_PASSWORD || '';
  const pwFile = path.join(DATA_DIR, 'access.txt');
  if (!password && fs.existsSync(pwFile)) {
    password = fs.readFileSync(pwFile, 'utf8').trim();
  }
  if (!password) {
    password = crypto.randomBytes(12).toString('base64url');
    fs.writeFileSync(pwFile, password, 'utf8');
    console.log(`[AUTH] Đã tạo mật khẩu admin ngẫu nhiên, lưu ở ${pwFile}`);
  }
  db.createUser({ username, password, role: 'admin', plan: 'unlimited' });
  console.log(`[AUTH] Đã tạo tài khoản admin '${username}'`);
}
ensureAdminAccount();

function getAdminUser() {
  return db.listUsers().find((u) => u.role === 'admin');
}

function publicUser(user, manager) {
  const plan = getPlan(user.plan);
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    plan: plan.id,
    planLabel: plan.label,
    planExpiresAt: user.plan_expires_at || null,
    maxSlots: Number.isFinite(plan.maxSlots) ? plan.maxSlots : null,
    slotCount: manager ? manager.countOwned(user.id) : 0,
    runningCount: manager ? manager.countRunning(user.id) : 0,
    balance: user.balance || 0,
    pendingProduct: user.pending_product || null,
    autoRenew: user.auto_renew || null
  };
}

// Built-in Preset Games Catalog (dùng chung cho mọi user)
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

function gameRowToPreset(g) {
  return {
    id: g.id,
    label: g.label,
    fileName: g.file_name,
    diskPath: g.disk_path,
    defaultName: g.default_name,
    defaultVendor: g.default_vendor,
    isUserUploaded: true,
    ownerId: g.owner_id
  };
}

// Game mà user được phép dùng: game có sẵn + game do chính user tải lên
function getAvailableGames(userId) {
  const own = db
    .listGames(userId)
    .filter((g) => fs.existsSync(g.disk_path))
    .map(gameRowToPreset);
  return [...BUILTIN_PRESETS, ...own];
}

function findGameForUser(userId, presetId) {
  if (typeof presetId !== 'string' || !presetId) return null;
  const builtin = BUILTIN_PRESETS.find((p) => p.id === presetId);
  if (builtin) return builtin;
  const g = db.getGame(presetId);
  if (g && g.owner_id === userId) return gameRowToPreset(g);
  return null;
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

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Represents one Cloud J2ME Slot running in the background 24/7
 */
class SlotInstance {
  constructor(meta, manager, ownerId, createdAt = Date.now()) {
    this.meta = meta;
    this.manager = manager;
    this.ownerId = ownerId;
    this.createdAt = createdAt;
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
    this.crashCount = 0;
    this.startedAt = 0;
    this.restartTimer = null;
    this.streamFps = null;
    this.resetHealth();
    this.watchdogRestarts = [];
    this.watchdogLimitNotified = false;

    this.slotDir = path.join(SLOTS_DIR, this.meta.id);
    this.rmsDir = path.join(this.slotDir, 'rms');
    if (!fs.existsSync(this.rmsDir)) {
      fs.mkdirSync(this.rmsDir, { recursive: true });
    }

    this.setupAutomationTimers();
  }

  // Trạng thái sức khỏe của tiến trình game hiện tại (đặt lại mỗi lần khởi động)
  resetHealth() {
    this.aliveSupported = false; // emulator cũ không gửi ALIVE -> không xét đơ
    this.lastAliveAt = 0;
    this.frozenSince = null;
    this.everConnected = false;
    this.disconnectedSince = null;
    this.socketState = { activeSockets: 0, host: '', port: 0, lastEvent: '' };
  }

  watchdogEnabled() {
    return this.meta.automation?.watchdogEnabled !== false;
  }

  // Gọi định kỳ bởi SlotManager: trả về lý do cần khởi động lại, hoặc null
  watchdogReason(now) {
    if (!this.proc || !this.meta.running || !this.watchdogEnabled()) return null;
    if (now - this.startedAt < WATCHDOG.startupGraceMs) return null;
    if (this.aliveSupported && now - this.lastAliveAt > WATCHDOG.silentMs) return 'emulator không phản hồi';
    if (this.frozenSince && now - this.frozenSince >= WATCHDOG.frozenMs) return 'game bị đơ (màn hình đứng im)';
    if (this.disconnectedSince && now - this.disconnectedSince >= WATCHDOG.disconnectedMs) {
      return 'mất kết nối máy chủ game quá 3 phút';
    }
    return null;
  }

  runWatchdog(now) {
    const reason = this.watchdogReason(now);
    if (!reason) return;
    this.watchdogRestarts = this.watchdogRestarts.filter((t) => now - t < 3600 * 1000);
    const name = this.meta.name || this.meta.id;
    if (this.watchdogRestarts.length >= WATCHDOG.maxRestartsPerHour) {
      if (!this.watchdogLimitNotified) {
        this.watchdogLimitNotified = true;
        console.warn(`[Watchdog ${this.meta.id}] ${reason}, đã tự khởi động lại ${WATCHDOG.maxRestartsPerHour} lần/giờ -> tạm dừng`);
        this.broadcast({
          type: 'toast',
          message: `[${name}] 🛡 Watchdog: ${reason}, đã tự khởi động lại ${WATCHDOG.maxRestartsPerHour} lần trong 1 giờ — tạm dừng, hãy kiểm tra tab này.`
        });
      }
      return;
    }
    this.watchdogRestarts.push(now);
    this.watchdogLimitNotified = false;
    console.log(`[Watchdog ${this.meta.id}] ${reason} -> khởi động lại`);
    this.broadcast({ type: 'toast', message: `[${name}] 🛡 Watchdog: ${reason}, đang tự khởi động lại game...` });
    this.restart();
  }

  getPublicState() {
    // Gói & thời hạn tính theo tài khoản sở hữu, không theo từng tab
    const owner = db.getUser(this.ownerId);
    const plan = getPlan(owner?.plan);
    return {
      id: this.meta.id,
      name: this.meta.name,
      running: Boolean(this.proc),
      inGameStatus: this.meta.inGameStatus || 'Chưa vào game',
      plan: plan.label,
      expiresAt: owner?.plan_expires_at || null,
      width: this.meta.width || 240,
      height: this.meta.height || 320,
      fps: this.meta.fps || DEFAULT_FPS,
      gameInfo: this.meta.gameInfo,
      automation: this.meta.automation,
      activeTextBox: this.activeTextBox,
      socketState: this.socketState,
      playingMacroId: this.playingMacroId
    };
  }

  save() {
    this.manager.saveSlot(this);
  }

  broadcast(payload) {
    this.manager.sendToOwner(this.ownerId, {
      ...payload,
      slotId: this.meta.id
    });
  }

  broadcastFrame(b64) {
    const now = Date.now();
    this.manager.broadcastFrameForSlot(this, b64, now);
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
    // Tốc độ stream ban đầu theo người đang xem; đổi lúc chạy bằng lệnh FPS (applyStreamFps)
    const fps = this.manager.computeStreamFps(this);
    this.streamFps = fps;

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

    console.log(`[Slot ${this.meta.id}] Starting headless J2ME: ${path.basename(jarPath)} (${width}x${height}, stream ${fps}fps)`);
    const spawnedProc = spawn('java', args, {
      cwd: ROOT_DIR,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.proc = spawnedProc;
    this.startedAt = Date.now();
    this.resetHealth();

    spawnedProc.on('error', () => {});
    if (spawnedProc.stdin) spawnedProc.stdin.on('error', () => {});
    if (spawnedProc.stdout) spawnedProc.stdout.on('error', () => {});
    if (spawnedProc.stderr) spawnedProc.stderr.on('error', () => {});

    this.meta.running = true;
    this.stdoutBuffer = '';
    this.activeTextBox = { active: false };
    this.save();
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
        // Backoff: chết nhanh (<10s) nhiều lần thì giãn dần tới tối đa 60s
        this.crashCount = Date.now() - this.startedAt < 10000 ? this.crashCount + 1 : 0;
        const delay = Math.min(2000 * 2 ** Math.min(this.crashCount, 5), 60000);
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (this.meta.running && !this.proc) {
            this.start();
          }
        }, delay);
      }
    });
  }

  stop() {
    this.meta.running = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.stopMacro();
    if (this.proc) {
      try {
        this.sendCommand('QUIT');
        this.proc.kill();
      } catch (e) {}
      this.proc = null;
    }
    this.activeTextBox = { active: false };
    this.save();
    this.broadcastState();
  }

  destroy() {
    this.stop();
    for (const timer of this.macroTimers.values()) clearInterval(timer);
    this.macroTimers.clear();
    if (this.periodicKeyTimer) clearInterval(this.periodicKeyTimer);
    if (this.scheduledRestartTimer) clearInterval(this.scheduledRestartTimer);
    if (this.autoReconnectTimer) clearTimeout(this.autoReconnectTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
  }

  restart() {
    const old = this.proc;
    this.proc = null;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.meta.running = true;
    this.crashCount = 0;
    this.lastFrame = null;
    this.activeTextBox = { active: false };

    const launch = () => {
      if (this.meta.running && !this.proc) this.start();
      if (this.meta.automation?.autoLoginEnabled) {
        this.scheduleAutoLogin(4500, 'Khởi động lại game');
      }
    };

    if (!old) return launch();
    // Chờ tiến trình cũ thoát hẳn rồi mới mở mới, tránh 2 tiến trình cùng ghi RMS
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      launch();
    };
    old.once('exit', finish);
    setTimeout(finish, 3000);
    try {
      old.kill();
    } catch (e) {
      finish();
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
    } else if (line.startsWith('ALIVE:')) {
      // Nhịp tim 5s/lần từ emulator: paints = số lần game vẽ màn hình trong khoảng đó
      try {
        const alive = JSON.parse(line.slice(6));
        this.aliveSupported = true;
        this.lastAliveAt = Date.now();
        if (alive.paints > 0) this.frozenSince = null;
        else if (!this.frozenSince) this.frozenSince = Date.now();
      } catch (e) {}
    } else if (line.startsWith('SOCKET:')) {
      try {
        const prevActive = this.socketState.activeSockets;
        // Emulator gửi {connected, count, target: "host:port", reason}
        const sock = JSON.parse(line.slice(7));
        const target = String(sock.target || '');
        const sep = target.lastIndexOf(':');
        this.socketState = {
          activeSockets: Number(sock.count) || 0,
          host: sep > 0 ? target.slice(0, sep) : target,
          port: sep > 0 ? Number(target.slice(sep + 1)) || 0 : 0,
          lastEvent: sock.reason || ''
        };
        if (this.socketState.activeSockets > 0) {
          this.everConnected = true;
          this.disconnectedSince = null;
        } else if (this.everConnected && !this.disconnectedSince) {
          this.disconnectedSince = Date.now();
        }
        if (prevActive > 0 && this.socketState.activeSockets === 0) {
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

  // Báo emulator đổi tốc độ stream khi người xem thay đổi (mở/đóng trang, đổi tab đang chọn, ẩn hình)
  applyStreamFps() {
    if (!this.proc) return;
    const fps = this.manager.computeStreamFps(this);
    if (fps !== this.streamFps) {
      this.streamFps = fps;
      this.sendCommand(`FPS ${fps}`);
    }
  }

  sendCommand(cmd) {
    if (this.proc && this.proc.stdin && !this.proc.stdin.destroyed) {
      try {
        // Không cho phép xuống dòng trong lệnh -> không chèn được lệnh thứ 2
        this.proc.stdin.write(String(cmd).replace(/[\r\n]+/g, ' ') + '\n');
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
      this.save();
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
    const kc = toInt(step.keyCode);
    const x = toInt(step.x);
    const y = toInt(step.y);
    switch (step.action) {
      case 'KEY_PRESS':
      case 'KEY_DOWN':
      case 'KEY_UP':
        if (kc !== null) this.sendCommand(`${step.action} ${kc}`);
        break;
      case 'CLICK':
      case 'POINTER_DOWN':
      case 'POINTER_DRAG':
      case 'POINTER_UP':
        if (x !== null && y !== null) this.sendCommand(`${step.action} ${x} ${y}`);
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
          const kc = toInt(auto.periodicKey.keyCode);
          if (kc !== null) this.sendCommand(`KEY_PRESS ${kc}`);
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
 * Manages all slots and multiplexes frames/events to connected WebSocket clients.
 * Mỗi WebSocket chỉ nhận dữ liệu của các slot thuộc user đã đăng nhập trên socket đó.
 */
class SlotManager {
  constructor() {
    this.slots = new Map();
    this.wsClients = new Set();
    this.loadSlots();
  }

  sendToOwner(ownerId, payload) {
    const msg = JSON.stringify(payload);
    for (const ws of this.wsClients) {
      if (ws.userId === ownerId && ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  // Gửi lại danh sách slot + thông tin tài khoản cho mọi tab trình duyệt của user
  notifyOwner(ownerId) {
    const user = db.getUser(ownerId);
    if (!user) return;
    this.sendToOwner(ownerId, { type: 'slots_updated', slots: this.getSlotsPublicFor(ownerId) });
    this.sendToOwner(ownerId, { type: 'account', me: publicUser(user, this) });
  }

  // FPS stream cho 1 slot = mức cao nhất mà các tab trình duyệt đang mở của chủ slot cần
  computeStreamFps(slot) {
    const id = slot.meta.id;
    const userFps = slot.meta.fps || DEFAULT_FPS;
    let best = 0;
    for (const ws of this.wsClients) {
      if (ws.userId !== slot.ownerId || ws.readyState !== WebSocket.OPEN) continue;
      if (ws.pageHidden || ws.hiddenSlots?.has(id)) continue;
      const fps = ws.focusedSlotId === id || !ws.ecoMode ? userFps : Math.min(ECO_FPS, userFps);
      best = Math.max(best, fps);
    }
    return best;
  }

  updateStreamRates(ownerId) {
    for (const slot of this.ownedSlots(ownerId)) slot.applyStreamFps();
  }

  closeOwnerSockets(ownerId) {
    for (const ws of this.wsClients) {
      if (ws.userId === ownerId) ws.close(4001, 'Phiên đăng nhập đã kết thúc');
    }
  }

  broadcastFrameForSlot(slot, b64, now) {
    const slotId = slot.meta.id;
    let msg = null;
    for (const ws of this.wsClients) {
      if (ws.userId !== slot.ownerId || ws.readyState !== WebSocket.OPEN) continue;

      // Smart Eco Mode throttling:
      // Focused slot gets full FPS; unfocused background slots in grid get throttled (~4 FPS) when ecoMode is on
      const isFocused = ws.focusedSlotId === slotId;
      if (!isFocused && ws.ecoMode) {
        const lastSent = ws.lastFrameTimes?.get(slotId) || 0;
        if (now - lastSent < 240) {
          continue;
        }
      }
      if (ws.bufferedAmount > 2 * 1024 * 1024) continue; // client chậm: bỏ khung hình
      if (ws.lastFrameTimes) {
        ws.lastFrameTimes.set(slotId, now);
      }
      msg = msg || JSON.stringify({ type: 'frame', slotId, data: b64 });
      ws.send(msg);
    }
  }

  // Chuyển dữ liệu cũ (slots.json + user_games/catalog.json) vào SQLite, gán cho admin
  migrateLegacyFiles() {
    const admin = getAdminUser();
    if (!admin) return;

    if (fs.existsSync(LEGACY_USER_GAMES_FILE)) {
      try {
        const list = JSON.parse(fs.readFileSync(LEGACY_USER_GAMES_FILE, 'utf8'));
        for (const g of Array.isArray(list) ? list : []) {
          if (!g.id || !g.diskPath || db.getGame(g.id)) continue;
          db.saveGame({
            id: g.id,
            ownerId: admin.id,
            label: g.label || g.fileName,
            fileName: g.fileName || path.basename(g.diskPath),
            diskPath: g.diskPath,
            defaultName: g.defaultName,
            defaultVendor: g.defaultVendor
          });
        }
        fs.renameSync(LEGACY_USER_GAMES_FILE, LEGACY_USER_GAMES_FILE + '.migrated');
        console.log('[Migrate] Đã chuyển user_games/catalog.json vào SQLite');
      } catch (e) {
        console.error('[Migrate] Không đọc được catalog.json:', e.message);
      }
    }

    if (fs.existsSync(LEGACY_SLOTS_FILE) && db.countSlots() === 0) {
      try {
        const list = JSON.parse(fs.readFileSync(LEGACY_SLOTS_FILE, 'utf8'));
        db.transaction(() => {
          for (const item of Array.isArray(list) ? list : []) {
            if (!item || !item.id) continue;
            delete item.plan;
            delete item.expiresAt;
            db.saveSlot(item.id, admin.id, item);
          }
        });
        fs.renameSync(LEGACY_SLOTS_FILE, LEGACY_SLOTS_FILE + '.migrated');
        console.log(`[Migrate] Đã chuyển ${list.length} slot từ slots.json sang tài khoản '${admin.username}'`);
      } catch (e) {
        console.error('[Migrate] slots.json bị hỏng, bỏ qua:', e.message);
      }
    }
  }

  loadSlots() {
    this.migrateLegacyFiles();

    for (const row of db.listSlots()) {
      const item = row.meta;
      // 12 là FPS mặc định cũ (bị giật); slot chưa từng đổi thì nâng lên mặc định mới
      if (item.fps === 12) item.fps = DEFAULT_FPS;
      // jarPath tuyệt đối cũ (vd. đường dẫn Windows) không còn đúng khi chuyển máy
      const jp = item.gameInfo?.jarPath;
      if (jp && !fs.existsSync(jp) && path.basename(jp.replace(/\\/g, '/')) === 'custom_game.jar') {
        item.gameInfo.jarPath = path.join(SLOTS_DIR, item.id, 'custom_game.jar');
      }
      if (item.gameInfo?.presetId) {
        const preset = findGameForUser(row.ownerId, item.gameInfo.presetId);
        if (preset && fs.existsSync(preset.diskPath)) {
          item.gameInfo.jarPath = preset.diskPath;
        }
      }
      const instance = new SlotInstance(item, this, row.ownerId, row.createdAt);
      this.slots.set(item.id, instance);
      instance.save(); // ghi lại để mã hóa dữ liệu cũ còn ở dạng JSON thường
    }

    // Chỉ khởi động số slot nằm trong giới hạn gói của từng user và sức chứa máy chủ
    const owners = new Set(Array.from(this.slots.values()).map((s) => s.ownerId));
    for (const ownerId of owners) this.enforceQuota(ownerId);
    let started = 0;
    for (const slot of this.slots.values()) {
      if (!slot.meta.running) continue;
      if (started >= MAX_TOTAL_RUNNING) {
        slot.meta.running = false;
        slot.save();
        console.warn(`[Capacity] Máy chủ đủ ${MAX_TOTAL_RUNNING} tab, không khởi động ${slot.meta.id}`);
        continue;
      }
      slot.start();
      started++;
    }
  }

  saveSlot(slot) {
    db.saveSlot(slot.meta.id, slot.ownerId, slot.meta, slot.createdAt);
  }

  getSlot(id) {
    return this.slots.get(id);
  }

  ownedSlots(ownerId) {
    return Array.from(this.slots.values()).filter((s) => s.ownerId === ownerId);
  }

  countOwned(ownerId) {
    return this.ownedSlots(ownerId).length;
  }

  countRunning(ownerId, exceptId = null) {
    return this.ownedSlots(ownerId).filter((s) => s.meta.running && s.meta.id !== exceptId).length;
  }

  getSlotsPublicFor(ownerId) {
    return this.ownedSlots(ownerId).map((s) => s.getPublicState());
  }

  countRunningTotal(exceptId = null) {
    let n = 0;
    for (const s of this.slots.values()) if (s.meta.running && s.meta.id !== exceptId) n++;
    return n;
  }

  hasCapacity(exceptId = null) {
    return this.countRunningTotal(exceptId) < MAX_TOTAL_RUNNING;
  }

  assertCanCreate(user) {
    const plan = getPlan(user.plan);
    if (plan.maxSlots === 0) {
      throw new HttpError(403, `Tài khoản chưa có gói dịch vụ. ${contactInfo()}`);
    }
    if (this.countOwned(user.id) >= plan.maxSlots) {
      throw new HttpError(
        403,
        `Gói ${plan.label} chỉ cho phép tối đa ${plan.maxSlots} tab. Hãy xóa bớt tab hoặc nâng cấp gói.`
      );
    }
  }

  assertCanStart(slot) {
    const user = db.getUser(slot.ownerId);
    const plan = getPlan(user?.plan);
    if (plan.maxSlots === 0) {
      throw new HttpError(403, `Tài khoản chưa có gói dịch vụ hoặc gói đã hết hạn. ${contactInfo()}`);
    }
    if (!this.hasCapacity(slot.meta.id)) {
      throw new HttpError(503, 'Máy chủ đã đầy, vui lòng thử lại sau hoặc liên hệ admin.');
    }
    if (this.countRunning(slot.ownerId, slot.meta.id) >= plan.maxSlots) {
      throw new HttpError(
        403,
        `Gói ${plan.label} chỉ cho phép chạy cùng lúc ${plan.maxSlots} tab. Hãy tắt bớt tab hoặc nâng cấp gói.`
      );
    }
  }

  // Tắt các tab vượt giới hạn gói (giữ lại các tab tạo sớm nhất)
  enforceQuota(ownerId) {
    const user = db.getUser(ownerId);
    const plan = getPlan(user?.plan);
    const running = this.ownedSlots(ownerId)
      .filter((s) => s.meta.running)
      .sort((a, b) => a.createdAt - b.createdAt);
    const excess = running.slice(Math.max(0, plan.maxSlots));
    for (const slot of excess) {
      if (slot.proc) {
        slot.stop();
      } else {
        slot.meta.running = false;
        slot.save();
      }
    }
    if (excess.length > 0) {
      console.log(`[Quota] User ${ownerId}: đã tắt ${excess.length} tab vượt giới hạn gói ${plan.id}`);
      this.sendToOwner(ownerId, {
        type: 'toast',
        message:
          plan.maxSlots === 0
            ? `Tài khoản chưa có gói, đã tắt ${excess.length} tab. ${contactInfo()}`
            : `Gói ${plan.label} chỉ chạy được ${plan.maxSlots} tab, đã tắt ${excess.length} tab vượt giới hạn.`
      });
    }
    return excess.length;
  }

  createSlot({ ownerId, customName, presetId, customGameInfo } = {}) {
    let nextNum = 5;
    while (this.slots.has(`JS${String(nextNum).padStart(5, '0')}`)) {
      nextNum++;
    }
    const id = `JS${String(nextNum).padStart(5, '0')}`;

    let gameInfo;
    if (customGameInfo) {
      gameInfo = customGameInfo;
    } else {
      const chosenPreset = findGameForUser(ownerId, presetId) || BUILTIN_PRESETS[0];
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
      name: customName && customName.trim() ? customName.trim().slice(0, 60) : id,
      running: true,
      inGameStatus: 'Chưa vào game',
      width: 240,
      height: 320,
      fps: DEFAULT_FPS,
      gameInfo,
      automation: {
        autoLoginEnabled: false,
        macros: [],
        periodicKey: { enabled: false, keyCode: -5, intervalSec: 15 },
        scheduledRestart: { enabled: false, everyHours: 6 }
      }
    };

    const instance = new SlotInstance(meta, this, ownerId);
    this.slots.set(id, instance);
    // Tạo mới khi đã đủ số tab đang chạy (của gói hoặc của máy chủ) thì để ở trạng thái tắt
    const plan = getPlan(db.getUser(ownerId)?.plan);
    if (this.countRunning(ownerId, id) >= plan.maxSlots || !this.hasCapacity(id)) {
      meta.running = false;
      instance.save();
      if (!this.hasCapacity(id)) {
        this.sendToOwner(ownerId, { type: 'toast', message: 'Máy chủ đang đầy, tab mới được tạo ở trạng thái tắt.' });
      }
    } else {
      instance.start();
    }
    this.notifyOwner(ownerId);
    return instance;
  }

  deleteSlot(id) {
    const slot = this.slots.get(id);
    if (!slot) {
      throw new HttpError(404, 'Không tìm thấy tab máy treo.');
    }
    slot.destroy();
    this.slots.delete(id);
    db.deleteSlot(id);
    try {
      if (fs.existsSync(slot.slotDir)) {
        fs.rmSync(slot.slotDir, { recursive: true, force: true });
      }
    } catch (e) {}
    this.notifyOwner(slot.ownerId);
  }
}

const slotManager = new SlotManager();

// Gói hết hạn: chuyển về 'none' và tắt toàn bộ tab của user
function checkExpiredPlans() {
  for (const user of db.listExpiredPlans()) {
    db.updateUser(user.id, { plan: 'none', planExpiresAt: null });
    console.log(`[Plan] Gói ${user.plan} của '${user.username}' đã hết hạn`);
    slotManager.sendToOwner(user.id, {
      type: 'toast',
      message: `Gói ${getPlan(user.plan).label} đã hết hạn, các tab đã được tắt. Bấm 💳 để mua gói mới.`
    });
    slotManager.enforceQuota(user.id);
    slotManager.notifyOwner(user.id);
  }
}

// ---------------------------------------------------------------------------
// Ví & mua gói
// ---------------------------------------------------------------------------
const PRODUCTS = loadProducts(DATA_DIR, PLANS);

function publicProduct(p) {
  const plan = getPlan(p.plan);
  return {
    id: p.id,
    plan: p.plan,
    planLabel: plan.label,
    maxSlots: Number.isFinite(plan.maxSlots) ? plan.maxSlots : null,
    days: p.days,
    price: p.price
  };
}

function formatVnd(n) {
  return n.toLocaleString('vi-VN') + 'đ';
}

// Sau khi số dư / gói của user thay đổi: cập nhật mọi tab trình duyệt và nhãn gói trên các slot
function refreshOwner(userId) {
  slotManager.enforceQuota(userId);
  for (const s of slotManager.ownedSlots(userId)) s.broadcastState();
  slotManager.notifyOwner(userId);
}

// Trừ tiền ví + kích hoạt / gia hạn gói trong cùng 1 transaction
function purchaseProduct(userId, productId, { confirmReplace = false } = {}) {
  const product = PRODUCTS.find((p) => p.id === productId);
  if (!product) throw new HttpError(400, 'Gói không tồn tại');

  const result = db.transaction(() => {
    const user = db.getUser(userId);
    const activeOther =
      user.plan !== 'none' && user.plan !== product.plan &&
      (!user.plan_expires_at || user.plan_expires_at > Date.now());
    if (activeOther && !confirmReplace) {
      throw new HttpError(
        409,
        `Bạn đang dùng gói ${getPlan(user.plan).label}. Mua gói ${getPlan(product.plan).label} sẽ thay thế gói hiện tại (thời hạn còn lại không được cộng dồn).`
      );
    }
    try {
      db.addBalance(userId, -product.price, 'purchase', `${product.id} (${getPlan(product.plan).label} ${product.days} ngày)`);
    } catch (e) {
      if (e.code === 'INSUFFICIENT_BALANCE') {
        throw new HttpError(402, `Số dư không đủ: cần ${formatVnd(product.price)}, đang có ${formatVnd(user.balance)}.`);
      }
      throw e;
    }
    const fields = applyPlan(activeOther ? { plan: null } : user, product.plan, product.days);
    db.updateUser(userId, fields);
    db.setPendingProduct(userId, null);
    // Đang bật tự gia hạn thì lần sau gia hạn theo gói vừa mua
    if (user.auto_renew) db.setAutoRenew(userId, product.id);
    return fields;
  });

  const u = db.getUser(userId);
  console.log(`[Billing] '${u.username}' mua ${product.id} giá ${product.price}`);
  slotManager.sendToOwner(userId, {
    type: 'toast',
    message: `✅ Đã kích hoạt gói ${getPlan(product.plan).label} ${product.days} ngày, hết hạn ${new Date(result.planExpiresAt).toLocaleString('vi-VN')}.`
  });
  refreshOwner(userId);
  return u;
}

// Tìm mã nạp trong nội dung chuyển khoản. Ngân hàng hay viết hoa / thêm bớt dấu cách,
// nên bỏ hết ký tự không phải chữ-số rồi tìm PREFIX + 6 ký tự.
const PAY_CODE_RE = new RegExp(`${PAY_PREFIX}[A-Z0-9]{6}`);
function matchPayCode(content) {
  const normalized = String(content || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = normalized.match(PAY_CODE_RE);
  return m ? m[0] : null;
}

// Xử lý 1 giao dịch tiền vào. Trả về 'credited' | 'unmatched' | 'duplicate' | 'ignored'
function handleIncomingTransfer({ provider, txnId, amount, content, raw }) {
  amount = Math.trunc(Number(amount));
  if (!txnId || !Number.isFinite(amount) || amount <= 0) return 'ignored';

  const code = matchPayCode(content);
  const user = code ? db.getUserByPayCode(code) : null;
  const status = db.transaction(() => {
    const inserted = db.recordPayment({
      provider,
      txnId,
      amount,
      content: String(content || '').slice(0, 500),
      userId: user ? user.id : null,
      status: user ? 'credited' : 'unmatched',
      raw: JSON.stringify(raw).slice(0, 4000)
    });
    if (!inserted) return 'duplicate';
    if (!user) return 'unmatched';
    db.addBalance(user.id, amount, 'topup', `${provider} #${txnId}`);
    return 'credited';
  });

  console.log(`[Billing] ${provider} #${txnId} ${amount}đ "${content}" -> ${status}${user ? ` (${user.username})` : ''}`);
  if (status === 'credited') afterTopup(user.id, amount);
  return status;
}

function afterTopup(userId, amount) {
  slotManager.sendToOwner(userId, { type: 'toast', message: `💰 Đã nhận ${formatVnd(amount)} vào ví.` });
  // Khách đã chọn gói trước khi chuyển khoản -> tự mua khi đủ tiền
  const user = db.getUser(userId);
  const pending = PRODUCTS.find((p) => p.id === user.pending_product);
  if (pending && user.balance >= pending.price) {
    try {
      purchaseProduct(userId, pending.id, { confirmReplace: true });
      return;
    } catch (e) {
      console.error('[Billing] Tự mua gói thất bại:', e.message);
    }
  }
  slotManager.notifyOwner(userId);
}

// ---------------------------------------------------------------------------
// Tự gia hạn: trước khi hết hạn RENEW_BEFORE_MS, ví đủ tiền thì tự mua lại gói đã chọn
// (cùng gói nên ngày được cộng nối tiếp, không mất giờ nào). Ví thiếu thì nhắc 1 lần.
// ---------------------------------------------------------------------------
const RENEW_BEFORE_MS = 30 * 60 * 1000;
const renewWarned = new Set(); // `${userId}:${planExpiresAt}` đã nhắc thiếu tiền

function runAutoRenew() {
  for (const user of db.listAutoRenewDue(Date.now() + RENEW_BEFORE_MS)) {
    const product = PRODUCTS.find((p) => p.id === user.auto_renew);
    if (!product) {
      db.setAutoRenew(user.id, null);
      continue;
    }
    if (user.balance >= product.price) {
      try {
        purchaseProduct(user.id, product.id, { confirmReplace: true });
        console.log(`[Billing] Tự gia hạn ${product.id} cho '${user.username}'`);
      } catch (e) {
        console.error(`[Billing] Tự gia hạn cho '${user.username}' lỗi:`, e.message);
      }
      continue;
    }
    const key = `${user.id}:${user.plan_expires_at}`;
    if (!renewWarned.has(key)) {
      renewWarned.add(key);
      slotManager.sendToOwner(user.id, {
        type: 'toast',
        message: `🔁 Không tự gia hạn được: ví còn ${formatVnd(user.balance)}, gói ${getPlan(product.plan).label} ${product.days} ngày cần ${formatVnd(product.price)}. Nạp thêm trước khi hết hạn nhé!`
      });
    }
  }
}

function checkPlans() {
  runAutoRenew();
  checkExpiredPlans();
}
checkPlans();
setInterval(checkPlans, 60 * 1000);

// Casso webhook v2: X-Casso-Signature "t=<timestamp>,v1=<hmac-sha512 hex>"
// ký trên `${t}.${JSON.stringify(body đã sắp xếp key)}` bằng checksum key
function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((o, k) => ((o[k] = sortKeysDeep(v[k])), o), {});
  }
  return v;
}

function verifyCassoRequest(req) {
  const sig = req.headers['x-casso-signature'];
  if (sig && setting('casso_checksum_key')) {
    const parts = Object.fromEntries(String(sig).split(',').map((p) => p.trim().split('=')));
    if (!parts.t || !parts.v1) return false;
    const expected = crypto
      .createHmac('sha512', setting('casso_checksum_key'))
      .update(`${parts.t}.${JSON.stringify(sortKeysDeep(req.body))}`)
      .digest('hex');
    return expected.length === parts.v1.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
  }
  // Webhook kiểu cũ: header secure-token
  const token = req.headers['secure-token'];
  const secureToken = setting('casso_secure_token');
  return Boolean(secureToken && token) && safeEqualStr(token, secureToken);
}

function safeEqualStr(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
setInterval(() => db.purgeExpiredSessions(), 3600 * 1000);

// ---------------------------------------------------------------------------
// Đăng nhập bằng session cookie (HttpOnly, SameSite=Lax)
// ---------------------------------------------------------------------------
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch (e) {
      out[k] = v;
    }
  }
  return out;
}

function getRequestUser(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return db.getSessionUser(token);
}

// Chặn request từ trang web khác (CSRF / WebSocket hijacking)
function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch (e) {
    return false;
  }
}

function setSessionCookie(req, res, token) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Giới hạn số lần đăng nhập/đăng ký sai theo IP: 10 lần / 15 phút
const authAttempts = new Map();
function checkAuthRate(ip) {
  const now = Date.now();
  const rec = authAttempts.get(ip);
  if (!rec || rec.resetAt < now) {
    authAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return true;
  }
  rec.count++;
  return rec.count <= 10;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of authAttempts) if (rec.resetAt < now) authAttempts.delete(ip);
}, 15 * 60 * 1000);

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 6 || pw.length > 200) {
    throw new HttpError(400, 'Mật khẩu phải dài từ 6 ký tự.');
  }
}

// Express & HTTP Server Setup
const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  verifyClient: (info, cb) => {
    if (!isSameOrigin(info.req)) return cb(false, 403, 'Forbidden');
    const user = getRequestUser(info.req);
    if (!user) return cb(false, 401, 'Unauthorized');
    info.req.user = user;
    cb(true);
  }
});

app.use(express.json({ limit: '5mb' }));

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && !isSameOrigin(req)) {
    return res.status(403).json({ error: 'Yêu cầu không hợp lệ' });
  }
  req.user = getRequestUser(req);
  next();
});

// ---- Các route không cần đăng nhập ----
const PUBLIC_FILES = new Set(['/login.html', '/style.css', '/theme.css', '/snow.js']);
app.use((req, res, next) => {
  if (PUBLIC_FILES.has(req.path)) {
    return res.sendFile(path.join(ROOT_DIR, 'public', req.path));
  }
  next();
});

app.get('/api/auth/config', (req, res) => {
  res.json({ allowRegister: ALLOW_REGISTER, loggedIn: Boolean(req.user), contact: contactInfo() });
});

// Cho pm2 / uptime monitor kiểm tra server còn sống
app.get('/healthz', (req, res) => {
  res.json({ ok: true, uptimeSec: Math.round(process.uptime()) });
});

// ---- Webhook báo tiền về (server SePay / Casso gọi, không qua đăng nhập) ----
// SePay: cấu hình webhook kiểu xác thực "API Key", header "Authorization: Apikey <SEPAY_API_KEY>"
app.post('/webhooks/sepay', (req, res) => {
  const sepayKey = setting('sepay_api_key');
  if (!sepayKey) return res.status(503).json({ success: false, message: 'SePay chưa được cấu hình' });
  const auth = String(req.headers.authorization || '');
  const key = auth.replace(/^Apikey\s+/i, '');
  if (!auth.toLowerCase().startsWith('apikey ') || !safeEqualStr(key, sepayKey)) {
    return res.status(401).json({ success: false, message: 'Sai API key' });
  }
  const b = req.body || {};
  if (b.transferType && b.transferType !== 'in') return res.json({ success: true, status: 'ignored' });
  const status = handleIncomingTransfer({
    provider: 'sepay',
    txnId: b.id,
    amount: b.transferAmount,
    content: [b.content, b.code, b.description].filter(Boolean).join(' '),
    raw: b
  });
  res.json({ success: true, status });
});

// Casso: hỗ trợ webhook v2 (X-Casso-Signature + checksum key) và kiểu cũ (secure-token)
app.post('/webhooks/casso', (req, res) => {
  if (!setting('casso_secure_token') && !setting('casso_checksum_key')) {
    return res.status(503).json({ error: 1, message: 'Casso chưa được cấu hình' });
  }
  if (!verifyCassoRequest(req)) return res.status(401).json({ error: 1, message: 'Sai chữ ký' });
  const data = req.body?.data;
  const list = Array.isArray(data) ? data : data ? [data] : [];
  const results = list.map((t) =>
    handleIncomingTransfer({
      provider: 'casso',
      txnId: t.id ?? t.tid ?? t.reference,
      amount: t.amount,
      content: t.description,
      raw: t
    })
  );
  res.json({ error: 0, results });
});

app.post('/api/auth/login', (req, res) => {
  if (!checkAuthRate(req.ip)) {
    return res.status(429).json({ error: 'Thử quá nhiều lần, vui lòng đợi 15 phút.' });
  }
  const { username, password } = req.body || {};
  const user = db.getUserByName(String(username || '').trim());
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu.' });
  }
  if (user.disabled) {
    return res.status(403).json({ error: 'Tài khoản đã bị khóa.' });
  }
  setSessionCookie(req, res, db.createSession(user.id));
  res.json({ me: publicUser(user, slotManager) });
});

app.post('/api/auth/register', handle((req, res) => {
  if (!ALLOW_REGISTER) {
    throw new HttpError(403, 'Máy chủ đang tắt đăng ký tài khoản mới.');
  }
  if (!checkAuthRate(req.ip)) {
    throw new HttpError(429, 'Thử quá nhiều lần, vui lòng đợi 15 phút.');
  }
  const username = String(req.body?.username || '').trim();
  const password = req.body?.password;
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(400, 'Tên đăng nhập 3–32 ký tự, chỉ gồm chữ, số và . _ -');
  }
  validatePassword(password);
  if (db.getUserByName(username)) {
    throw new HttpError(409, 'Tên đăng nhập đã có người dùng.');
  }
  const user = db.createUser({ username, password });
  setSessionCookie(req, res, db.createSession(user.id));
  res.json({ me: publicUser(user, slotManager) });
}));

app.post('/api/auth/logout', (req, res) => {
  db.deleteSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ---- Từ đây trở xuống bắt buộc đăng nhập ----
app.use((req, res, next) => {
  if (req.user) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Cần đăng nhập' });
  }
  res.redirect('/login.html');
});

function requireAdmin(req, res, next) {
  if (req.user.role === 'admin') return next();
  if (req.path.startsWith('/api/') || req.baseUrl.startsWith('/api/')) {
    return res.status(403).json({ error: 'Chỉ admin mới được dùng chức năng này' });
  }
  res.redirect('/');
}

app.use(['/admin.html', '/admin.js'], requireAdmin);
app.use(express.static(path.join(ROOT_DIR, 'public')));

// Multer setup for .jar upload (max 20 MB)
const upload = multer({
  dest: UPLOAD_TMP_DIR,
  limits: { fileSize: 20 * 1024 * 1024 }
});

function removeUpload(req) {
  if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
}

function getPublicPresetsList(userId) {
  return getAvailableGames(userId).map((p) => ({
    id: p.id,
    label: p.isUserUploaded ? `📦 ${p.label} (Đã tải lên)` : p.label,
    fileName: p.fileName,
    isUserUploaded: Boolean(p.isUserUploaded)
  }));
}

// Lấy slot theo :id, chỉ chủ sở hữu (hoặc admin) mới được thao tác
function ownedSlot(req) {
  const slot = slotManager.getSlot(req.params.id);
  if (!slot || (slot.ownerId !== req.user.id && req.user.role !== 'admin')) {
    throw new HttpError(404, 'Không tìm thấy máy treo');
  }
  return slot;
}

// Lưu file .jar vừa tải lên vào kho game riêng của user
function canUpload(user) {
  return user.role === 'admin' || ALLOW_USER_UPLOAD;
}

function storeUploadedJar(req, user) {
  if (!canUpload(req.user)) {
    throw new HttpError(403, 'Chỉ admin được tải file .jar lên. Hãy chọn game có sẵn trong kho.');
  }
  if (!req.file) throw new HttpError(400, 'Vui lòng chọn file .jar');
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  if (!originalName.toLowerCase().endsWith('.jar')) {
    throw new HttpError(400, 'Chỉ chấp nhận file định dạng .jar');
  }
  const ownGames = db.listGames(user.id);
  if (
    user.role !== 'admin' &&
    ownGames.length >= MAX_USER_GAMES &&
    !ownGames.some((g) => g.file_name === originalName)
  ) {
    throw new HttpError(403, `Kho game riêng tối đa ${MAX_USER_GAMES} file, hãy dùng lại game đã tải lên.`);
  }

  const parsed = parseJarManifest(req.file.path, originalName);
  const safeDiskName = `${Date.now()}_${originalName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const sharedJarPath = path.join(USER_GAMES_DIR, safeDiskName);
  fs.copyFileSync(req.file.path, sharedJarPath);

  const userPresetId = 'user_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
  db.saveGame({
    id: userPresetId,
    ownerId: user.id,
    label: `${parsed.name} (${originalName})`,
    fileName: originalName,
    diskPath: sharedJarPath,
    defaultName: parsed.name,
    defaultVendor: parsed.vendor
  });
  return { parsed, originalName, sharedJarPath, userPresetId };
}

// Gói lỗi cho handler đồng bộ: HttpError -> status tương ứng
function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (err) {
      removeUpload(req);
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      res.status(400).json({ error: err.message });
    }
  };
}

// REST API Endpoints
app.get('/api/me', (req, res) => {
  res.json({ me: publicUser(req.user, slotManager) });
});

app.post('/api/me/password', handle((req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!verifyPassword(String(currentPassword || ''), req.user.password_hash)) {
    throw new HttpError(400, 'Mật khẩu hiện tại không đúng.');
  }
  validatePassword(newPassword);
  db.updateUser(req.user.id, { passwordHash: hashPassword(newPassword) });
  // Đăng xuất các thiết bị khác, giữ phiên hiện tại
  db.deleteUserSessions(req.user.id);
  setSessionCookie(req, res, db.createSession(req.user.id));
  res.json({ ok: true });
}));

// ---- Ví: xem số dư, mã nạp, thông tin chuyển khoản, mua gói ----
app.get('/api/billing', (req, res) => {
  res.json({
    enabled: billingEnabled(),
    me: publicUser(req.user, slotManager),
    payCode: billingEnabled() ? db.ensurePayCode(req.user.id, PAY_PREFIX) : null,
    bank: billingEnabled() ? bankInfo() : null,
    contact: contactInfo(),
    products: PRODUCTS.map(publicProduct),
    ledger: db.listLedger(req.user.id, 20).map((l) => ({
      delta: l.delta,
      balanceAfter: l.balance_after,
      reason: l.reason,
      note: l.note,
      createdAt: l.created_at
    }))
  });
});

app.post('/api/billing/buy', handle((req, res) => {
  const { productId, confirmReplace } = req.body || {};
  const user = purchaseProduct(req.user.id, productId, { confirmReplace: confirmReplace === true });
  res.json({ me: publicUser(user, slotManager) });
}));

// Bật / tắt tự gia hạn (productId = null để tắt)
app.post('/api/billing/auto-renew', handle((req, res) => {
  const { productId } = req.body || {};
  if (productId !== null && !PRODUCTS.some((p) => p.id === productId)) {
    throw new HttpError(400, 'Gói không tồn tại');
  }
  db.setAutoRenew(req.user.id, productId);
  res.json({ me: publicUser(db.getUser(req.user.id), slotManager) });
}));

// Chọn gói sẽ tự mua ngay khi tiền chuyển khoản về đủ (productId = null để hủy)
app.post('/api/billing/pending', handle((req, res) => {
  const { productId } = req.body || {};
  if (productId !== null && !PRODUCTS.some((p) => p.id === productId)) {
    throw new HttpError(400, 'Gói không tồn tại');
  }
  db.setPendingProduct(req.user.id, productId);
  res.json({ me: publicUser(db.getUser(req.user.id), slotManager) });
}));

app.get('/api/bootstrap', (req, res) => {
  res.json({
    me: publicUser(req.user, slotManager),
    config: { canUpload: canUpload(req.user), contact: contactInfo(), billing: billingEnabled() },
    slots: slotManager.getSlotsPublicFor(req.user.id),
    presets: getPublicPresetsList(req.user.id)
  });
});

// Create a new slot / tab (with optional presetId)
app.post('/api/slots', handle((req, res) => {
  slotManager.assertCanCreate(req.user);
  const { name, presetId } = req.body || {};
  const slot = slotManager.createSlot({ ownerId: req.user.id, customName: name, presetId });
  res.json({
    slot: slot.getPublicState(),
    slots: slotManager.getSlotsPublicFor(req.user.id),
    presets: getPublicPresetsList(req.user.id)
  });
}));

// Create a new tab and immediately run an uploaded .jar file
app.post('/api/slots/create-with-jar', upload.single('jarFile'), handle((req, res) => {
  slotManager.assertCanCreate(req.user);
  const { parsed, originalName, sharedJarPath, userPresetId } = storeUploadedJar(req, req.user);
  removeUpload(req);

  const slot = slotManager.createSlot({
    ownerId: req.user.id,
    customName: req.body?.name || '',
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
    slots: slotManager.getSlotsPublicFor(req.user.id),
    presets: getPublicPresetsList(req.user.id)
  });
}));

// Delete / close a tab
app.delete('/api/slots/:id', handle((req, res) => {
  const slot = ownedSlot(req);
  slotManager.deleteSlot(slot.meta.id);
  const remaining = slotManager.getSlotsPublicFor(req.user.id);
  res.json({
    slots: remaining,
    activeSlot: remaining[0] || null
  });
}));

// Rename or update in-game status (gói & thời hạn chỉ admin đổi được qua /api/admin)
app.patch('/api/slots/:id', handle((req, res) => {
  const slot = ownedSlot(req);
  const { name, inGameStatus } = req.body || {};
  if (typeof name === 'string' && name.trim()) {
    slot.meta.name = name.trim().slice(0, 60);
  }
  if (typeof inGameStatus === 'string' && IN_GAME_STATUSES.has(inGameStatus)) {
    slot.meta.inGameStatus = inGameStatus;
  }

  slot.save();
  slot.broadcastState();
  res.json({ slot: slot.getPublicState(), slots: slotManager.getSlotsPublicFor(slot.ownerId) });
}));

// Start / Stop / Restart slot
app.post('/api/slots/:id/power', handle((req, res) => {
  const slot = ownedSlot(req);
  const { action } = req.body || {};
  const wantsStart = action === 'start' || action === 'restart' || (action === 'toggle' && !slot.proc);
  if (wantsStart && !slot.meta.running) slotManager.assertCanStart(slot);

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

  slotManager.sendToOwner(slot.ownerId, { type: 'account', me: publicUser(db.getUser(slot.ownerId), slotManager) });
  res.json({ slot: slot.getPublicState(), slots: slotManager.getSlotsPublicFor(slot.ownerId) });
}));

// Switch game to a preset or previously uploaded user game
app.post('/api/slots/:id/preset', handle((req, res) => {
  const slot = ownedSlot(req);
  const { presetId } = req.body || {};
  const preset = findGameForUser(slot.ownerId, presetId);
  if (!preset) throw new HttpError(400, 'Game đã chọn không hợp lệ');

  const jarPath = preset.diskPath;
  if (!fs.existsSync(jarPath)) {
    throw new HttpError(404, 'File game mẫu chưa có trên máy chủ');
  }
  if (!slot.meta.running) slotManager.assertCanStart(slot);

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
  slot.save();
  slot.restart();
  res.json({
    slot: slot.getPublicState(),
    slots: slotManager.getSlotsPublicFor(slot.ownerId)
  });
}));

// Upload custom .jar file for a slot & save to the owner's game library
app.post('/api/slots/:id/upload-jar', upload.single('jarFile'), handle((req, res) => {
  const slot = ownedSlot(req);
  if (!slot.meta.running) slotManager.assertCanStart(slot);
  const owner = db.getUser(slot.ownerId);
  const { parsed, originalName, userPresetId } = storeUploadedJar(req, owner);

  const destJar = path.join(slot.slotDir, 'custom_game.jar');
  fs.copyFileSync(req.file.path, destJar);
  removeUpload(req);

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
  slot.save();
  slot.restart();

  res.json({
    slot: slot.getPublicState(),
    slots: slotManager.getSlotsPublicFor(slot.ownerId),
    presets: getPublicPresetsList(slot.ownerId)
  });
}));

// Update screen resolution & FPS
app.post('/api/slots/:id/screen', handle((req, res) => {
  const slot = ownedSlot(req);

  const width = Math.max(120, Math.min(Number(req.body.width) || 240, 800));
  const height = Math.max(120, Math.min(Number(req.body.height) || 320, 800));
  const fps = Math.max(1, Math.min(Number(req.body.fps) || DEFAULT_FPS, 60));

  slot.meta.width = width;
  slot.meta.height = height;
  slot.meta.fps = fps;
  slot.save();

  slot.sendCommand(`RESIZE ${width} ${height}`);
  slot.applyStreamFps();
  slot.broadcastState();

  res.json({ slot: slot.getPublicState(), slots: slotManager.getSlotsPublicFor(slot.ownerId) });
}));

// Automation & Macro endpoints
app.post('/api/slots/:id/automation', handle((req, res) => {
  const slot = ownedSlot(req);

  const { autoLoginEnabled, watchdogEnabled, macros, periodicKey, scheduledRestart } = req.body || {};
  if (!slot.meta.automation) {
    slot.meta.automation = { autoLoginEnabled: false, macros: [] };
  }

  if (typeof autoLoginEnabled === 'boolean') {
    slot.meta.automation.autoLoginEnabled = autoLoginEnabled;
  }
  if (typeof watchdogEnabled === 'boolean') {
    slot.meta.automation.watchdogEnabled = watchdogEnabled;
  }
  if (Array.isArray(macros)) {
    slot.meta.automation.macros = sanitizeMacros(macros);
  }
  if (periodicKey && typeof periodicKey === 'object') {
    slot.meta.automation.periodicKey = {
      enabled: Boolean(periodicKey.enabled),
      keyCode: toInt(periodicKey.keyCode) ?? -5,
      intervalSec: Math.max(1, Math.min(toInt(periodicKey.intervalSec) ?? 15, 86400))
    };
  }
  if (scheduledRestart && typeof scheduledRestart === 'object') {
    slot.meta.automation.scheduledRestart = {
      enabled: Boolean(scheduledRestart.enabled),
      everyHours: Math.max(1, Math.min(toInt(scheduledRestart.everyHours) ?? 6, 720))
    };
  }

  slot.setupAutomationTimers();
  slot.save();
  slot.broadcastState();

  res.json({ slot: slot.getPublicState(), slots: slotManager.getSlotsPublicFor(slot.ownerId) });
}));

app.post('/api/slots/:id/macros/:macroId/play', handle((req, res) => {
  const slot = ownedSlot(req);
  slot.playMacro(req.params.macroId);
  res.json({ ok: true });
}));

app.post('/api/slots/:id/macros/stop', handle((req, res) => {
  const slot = ownedSlot(req);
  slot.stopMacro();
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Admin: quản lý user, gói, thời hạn
// ---------------------------------------------------------------------------
app.use('/api/admin', requireAdmin);

function adminUserView(u) {
  const pub = publicUser(u, slotManager);
  return { ...pub, disabled: Boolean(u.disabled), createdAt: u.created_at };
}

app.get('/api/admin/overview', (req, res) => {
  res.json({
    capacity: { running: slotManager.countRunningTotal(), max: MAX_TOTAL_RUNNING },
    users: db.listUsers().map(adminUserView)
  });
});

// Kích hoạt / gia hạn gói khi khách mua: cùng gói còn hạn thì cộng dồn ngày
function applyPlan(user, plan, days) {
  if (!PLANS[plan]) throw new HttpError(400, 'Gói không hợp lệ');
  if (plan === 'none') return { plan, planExpiresAt: null };
  const base =
    user.plan === plan && user.plan_expires_at && user.plan_expires_at > Date.now()
      ? user.plan_expires_at
      : Date.now();
  return { plan, planExpiresAt: base + days * 24 * 3600 * 1000 };
}

// Admin chỉ cần: đặt lại mật khẩu (khách quên) và khóa / mở khóa tài khoản
app.patch('/api/admin/users/:id', handle((req, res) => {
  const user = db.getUser(Number(req.params.id));
  if (!user) throw new HttpError(404, 'Không tìm thấy user');
  const { password, disabled } = req.body || {};
  if (user.id === req.user.id && disabled === true) {
    throw new HttpError(400, 'Không thể tự khóa tài khoản của chính mình');
  }
  const fields = {};
  if (password !== undefined && password !== '') {
    validatePassword(password);
    fields.passwordHash = hashPassword(password);
  }
  if (typeof disabled === 'boolean') fields.disabled = disabled ? 1 : 0;

  const updated = db.updateUser(user.id, fields);
  if (fields.passwordHash || fields.disabled) {
    db.deleteUserSessions(user.id);
    slotManager.closeOwnerSockets(user.id);
  }
  if (fields.disabled) {
    for (const s of slotManager.ownedSlots(user.id)) if (s.meta.running) s.stop();
  }
  res.json({ user: adminUserView(updated) });
}));

app.get('/api/admin/payments', (req, res) => {
  res.json({
    payments: db.listPayments(100).map((p) => ({
      id: p.id,
      provider: p.provider,
      txnId: p.txn_id,
      amount: p.amount,
      content: p.content,
      status: p.status,
      username: p.username || null,
      createdAt: p.created_at
    }))
  });
});

// Cài đặt thanh toán & liên hệ. Key bí mật không bao giờ gửi về trình duyệt, chỉ báo đã đặt hay chưa.
app.get('/api/admin/settings', (req, res) => {
  const values = {};
  const secrets = {};
  for (const [key, def] of Object.entries(PAYMENT_SETTINGS)) {
    if (def.secret) secrets[key] = Boolean(setting(key));
    else values[key] = setting(key);
  }
  res.json({ values, secrets, payPrefix: PAY_PREFIX, billingEnabled: billingEnabled() });
});

// Body: { key: value }. Ô thường: chuỗi rỗng = xóa. Key bí mật: bỏ qua nếu không gửi, "" = xóa.
app.put('/api/admin/settings', handle((req, res) => {
  const body = req.body || {};
  const clean = {
    contact_info: (v) => String(v).trim().slice(0, 200),
    bank_id: (v) => String(v).trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20),
    bank_account_no: (v) => String(v).replace(/\D/g, '').slice(0, 30),
    // VietQR cần tên không dấu, in hoa
    bank_account_name: (v) =>
      String(v).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'D')
        .toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 50)
  };
  for (const [key, def] of Object.entries(PAYMENT_SETTINGS)) {
    if (!(key in body)) continue;
    const raw = body[key];
    if (raw === null || raw === undefined) continue;
    const value = def.secret ? String(raw).trim().slice(0, 300) : clean[key](raw);
    db.setSetting(key, value === '' ? null : value, { secret: def.secret });
  }
  console.log(`[Settings] Admin '${req.user.username}' cập nhật cài đặt thanh toán: ${Object.keys(body).join(', ')}`);
  res.json({ ok: true, billingEnabled: billingEnabled() });
}));

// Gán giao dịch "chưa khớp" (khách ghi sai nội dung) cho đúng user rồi cộng tiền
app.post('/api/admin/payments/:id/assign', handle((req, res) => {
  const payment = db.getPayment(Number(req.params.id));
  if (!payment) throw new HttpError(404, 'Không tìm thấy giao dịch');
  if (payment.status !== 'unmatched') throw new HttpError(400, 'Giao dịch này đã được cộng tiền');
  const user = db.getUserByName(String(req.body?.username || '').trim());
  if (!user) throw new HttpError(404, 'Không tìm thấy user');
  db.transaction(() => {
    db.markPaymentCredited(payment.id, user.id);
    db.addBalance(user.id, payment.amount, 'topup', `${payment.provider} #${payment.txn_id} (admin gán)`);
  });
  console.log(`[Billing] Admin '${req.user.username}' gán giao dịch #${payment.id} cho '${user.username}'`);
  afterTopup(user.id, payment.amount);
  res.json({ ok: true });
}));

// Admin cộng / trừ ví thủ công (hoàn tiền, khuyến mãi, chỉnh sai sót)
app.post('/api/admin/users/:id/balance', handle((req, res) => {
  const user = db.getUser(Number(req.params.id));
  if (!user) throw new HttpError(404, 'Không tìm thấy user');
  const delta = toInt(req.body?.delta);
  if (!delta) throw new HttpError(400, 'Số tiền không hợp lệ');
  const note = String(req.body?.note || '').slice(0, 200) || `admin ${req.user.username}`;
  try {
    db.addBalance(user.id, delta, 'admin', note);
  } catch (e) {
    if (e.code === 'INSUFFICIENT_BALANCE') throw new HttpError(400, 'Số dư sau khi trừ sẽ bị âm');
    throw e;
  }
  console.log(`[Billing] Admin '${req.user.username}' chỉnh ví '${user.username}' ${delta} (${note})`);
  if (delta > 0) afterTopup(user.id, delta);
  else slotManager.notifyOwner(user.id);
  res.json({ user: adminUserView(db.getUser(user.id)) });
}));

// Multiplexed WebSocket Connection for Parallel Multi-Screen Streaming & Input
wss.on('connection', (ws, req) => {
  const userId = req.user.id;
  ws.userId = userId;
  const owned = slotManager.ownedSlots(userId);
  ws.focusedSlotId = owned[0]?.meta.id || null;
  ws.ecoMode = true;
  ws.lastFrameTimes = new Map();
  ws.pageHidden = false;
  ws.hiddenSlots = new Set();
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  slotManager.wsClients.add(ws);
  slotManager.updateStreamRates(userId);

  // Send initial states & cached frames for the user's slots so side-by-side grid renders immediately
  for (const slot of owned) {
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

  const getOwned = (id) => {
    const s = slotManager.getSlot(id);
    return s && s.ownerId === userId ? s : null;
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    if (msg.type === 'focus' || msg.type === 'subscribe') {
      if (msg.slotId && getOwned(msg.slotId)) {
        ws.focusedSlotId = msg.slotId;
      }
      if (typeof msg.ecoMode === 'boolean') {
        ws.ecoMode = msg.ecoMode;
      }
      slotManager.updateStreamRates(userId);
      const target = getOwned(ws.focusedSlotId);
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

    // Trình duyệt bị ẩn / thu nhỏ, hoặc tab nào đang bật "Ẩn hình" -> không cần stream
    if (msg.type === 'visibility') {
      ws.pageHidden = Boolean(msg.pageHidden);
      ws.hiddenSlots = new Set(
        (Array.isArray(msg.hiddenSlots) ? msg.hiddenSlots : []).filter((id) => typeof id === 'string').slice(0, 200)
      );
      slotManager.updateStreamRates(userId);
      return;
    }

    const targetSlot = getOwned(msg.slotId || ws.focusedSlotId);
    if (!targetSlot) return;

    switch (msg.type) {
      case 'KEY_DOWN':
      case 'KEY_UP':
      case 'KEY_PRESS': {
        const kc = toInt(msg.keyCode);
        if (kc !== null) targetSlot.sendCommand(`${msg.type} ${kc}`);
        break;
      }
      case 'POINTER_DOWN':
      case 'POINTER_DRAG':
      case 'POINTER_UP':
      case 'CLICK': {
        const x = toInt(msg.x);
        const y = toInt(msg.y);
        if (x !== null && y !== null) targetSlot.sendCommand(`${msg.type} ${x} ${y}`);
        break;
      }
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
    slotManager.updateStreamRates(userId);
  });
});

// Watchdog: định kỳ kiểm tra sức khỏe các tab đang chạy, tự khởi động lại tab bị đơ / mất kết nối lâu
setInterval(() => {
  const now = Date.now();
  for (const slot of slotManager.slots.values()) {
    try {
      slot.runWatchdog(now);
    } catch (e) {
      console.error(`[Watchdog ${slot.meta.id}]`, e.message);
    }
  }
}, WATCHDOG.checkEveryMs);

// Heartbeat: máy khách sleep / rớt mạng mà không đóng kết nối thì sau ~30-60s bị ngắt,
// tránh server tưởng vẫn có người xem và tiếp tục stream hình tốn CPU.
setInterval(() => {
  for (const ws of slotManager.wsClients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (e) {}
  }
}, 30 * 1000);

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

// ---------------------------------------------------------------------------
// Sao lưu hằng ngày vào data/backups/<ngày>/: DB, khóa mã hóa, RMS các slot, game đã tải lên.
// Nên chép thêm thư mục này ra máy khác / cloud (cùng ổ đĩa thì hỏng ổ là mất cả).
// ---------------------------------------------------------------------------
function runBackup() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const dest = path.join(BACKUP_DIR, day);
  try {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    db.backupTo(path.join(dest, 'app.db'));
    const keyFile = path.join(DATA_DIR, 'secret.key');
    if (fs.existsSync(keyFile)) fs.copyFileSync(keyFile, path.join(dest, 'secret.key'));
    fs.cpSync(SLOTS_DIR, path.join(dest, 'slots'), {
      recursive: true,
      filter: (src) => !src.endsWith('custom_game.jar')
    });
    fs.cpSync(USER_GAMES_DIR, path.join(dest, 'user_games'), { recursive: true });

    const days = fs.readdirSync(BACKUP_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    for (const old of days.slice(0, Math.max(0, days.length - BACKUP_KEEP_DAYS))) {
      fs.rmSync(path.join(BACKUP_DIR, old), { recursive: true, force: true });
    }
    console.log(`[Backup] Đã sao lưu vào ${dest}`);
  } catch (e) {
    console.error('[Backup] Lỗi sao lưu:', e.message);
  }
}
setTimeout(runBackup, 60 * 1000);
setInterval(runBackup, 24 * 3600 * 1000);

server.listen(PORT, HOST, () => {
  console.log(`[CONFIG] Sức chứa: ${MAX_TOTAL_RUNNING} tab chạy cùng lúc (MAX_TOTAL_RUNNING), upload .jar: ${ALLOW_USER_UPLOAD ? 'mọi user' : 'chỉ admin'}`);
  console.log(`[AUTH] Admin mặc định: user='${process.env.ACCESS_USER || 'admin'}', mật khẩu ở ACCESS_PASSWORD hoặc data/access.txt (lần chạy đầu)`);
  console.log(`[AUTH] Đăng ký tài khoản mới: ${ALLOW_REGISTER ? 'BẬT' : 'TẮT'} (ALLOW_REGISTER)`);
  console.log(
    billingEnabled()
      ? `[Billing] Nạp tiền: ${bankInfo().id} ${bankInfo().accountNo}, mã nạp ${PAY_PREFIX}xxxxxx, webhook: ${[setting('sepay_api_key') && '/webhooks/sepay', (setting('casso_secure_token') || setting('casso_checksum_key')) && '/webhooks/casso'].filter(Boolean).join(', ') || 'CHƯA CẤU HÌNH'}`
      : '[Billing] Chưa bật nạp tiền — nhập ngân hàng ở /admin.html (Cài đặt thanh toán)'
  );
  console.log(`=====================================================`);
  console.log(`🚀 TREO GAME JAVA Server running at http://localhost:${PORT}`);
  console.log(`=====================================================`);
});
