const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Các gói dịch vụ. maxSlots = số tab tối đa được tạo / chạy cùng lúc.
// Tài khoản mới ở gói 'none' (không có tab) cho tới khi admin cấp gói.
// Gói trả phí hết hạn sẽ tự về 'none' và mọi tab bị tắt.
// ---------------------------------------------------------------------------
const PLANS = {
  none: { id: 'none', label: 'Chưa có gói', maxSlots: 0 },
  basic: { id: 'basic', label: 'Cơ bản', maxSlots: 3 },
  vip: { id: 'vip', label: 'VIP Cloud', maxSlots: 10 },
  unlimited: { id: 'unlimited', label: 'Không giới hạn', maxSlots: Infinity }
};

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

function getPlan(id) {
  return PLANS[id] || PLANS.none;
}

// ---------------------------------------------------------------------------
// Mã hóa dữ liệu slot (macro có thể chứa mật khẩu acc game): AES-256-GCM,
// lưu dạng "enc:v1:<base64(iv|tag|ciphertext)>". Dữ liệu cũ dạng JSON thường vẫn đọc được.
// ---------------------------------------------------------------------------
const ENC_PREFIX = 'enc:v1:';

function encryptText(key, text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return ENC_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

function decryptText(key, stored) {
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  const raw = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Mật khẩu: scrypt + salt ngẫu nhiên, lưu dạng "scrypt$<salt>$<hash>"
// ---------------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'base64');
  const expected = Buffer.from(parts[2], 'base64');
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

class AppDb {
  // key: Buffer 32 byte dùng để mã hóa dữ liệu slot
  constructor(file, key) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.key = key;
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        plan TEXT NOT NULL DEFAULT 'none',
        plan_expires_at INTEGER,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS slots (
        id TEXT PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        meta TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        file_name TEXT NOT NULL,
        disk_path TEXT NOT NULL,
        default_name TEXT,
        default_vendor TEXT,
        created_at INTEGER NOT NULL
      );

      -- Giao dịch chuyển khoản nhận từ SePay / Casso. UNIQUE(provider, txn_id) chống cộng tiền 2 lần.
      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        txn_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        content TEXT,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        raw TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (provider, txn_id)
      );

      -- Sổ cái số dư: mọi thay đổi ví (nạp, mua gói, admin chỉnh) đều ghi lại
      CREATE TABLE IF NOT EXISTS ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        delta INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        reason TEXT NOT NULL,
        note TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id, id);

      -- Cài đặt admin chỉnh trong web (ngân hàng, liên hệ, key webhook)
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Thêm cột ví cho DB tạo từ bản trước
    const userCols = new Set(this.db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
    if (!userCols.has('balance')) this.db.exec('ALTER TABLE users ADD COLUMN balance INTEGER NOT NULL DEFAULT 0');
    if (!userCols.has('pay_code')) this.db.exec('ALTER TABLE users ADD COLUMN pay_code TEXT');
    if (!userCols.has('pending_product')) this.db.exec('ALTER TABLE users ADD COLUMN pending_product TEXT');
    // Gói tự gia hạn từ ví khi sắp hết hạn (null = tắt)
    if (!userCols.has('auto_renew')) this.db.exec('ALTER TABLE users ADD COLUMN auto_renew TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_pay_code ON users(pay_code)');

    // Bỏ gói dùng thử cũ: mọi gói không còn tồn tại chuyển về 'none'
    const planIds = Object.keys(PLANS).map((p) => `'${p}'`).join(', ');
    this.db.exec(`UPDATE users SET plan = 'none', plan_expires_at = NULL WHERE plan NOT IN (${planIds})`);

    this.stmt = {
      userById: this.db.prepare('SELECT * FROM users WHERE id = ?'),
      userByName: this.db.prepare('SELECT * FROM users WHERE username = ?'),
      countUsers: this.db.prepare('SELECT COUNT(*) AS n FROM users'),
      listUsers: this.db.prepare(`
        SELECT u.*, (SELECT COUNT(*) FROM slots s WHERE s.owner_id = u.id) AS slot_count
        FROM users u ORDER BY u.id`),
      insertUser: this.db.prepare(`
        INSERT INTO users (username, password_hash, role, plan, plan_expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`),
      deleteUser: this.db.prepare('DELETE FROM users WHERE id = ?'),
      expiredPlans: this.db.prepare(
        "SELECT * FROM users WHERE plan != 'none' AND plan_expires_at IS NOT NULL AND plan_expires_at < ?"
      ),

      insertSession: this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
      sessionUser: this.db.prepare(`
        SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`),
      deleteSession: this.db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
      deleteUserSessions: this.db.prepare('DELETE FROM sessions WHERE user_id = ?'),
      purgeSessions: this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),

      listSlots: this.db.prepare('SELECT * FROM slots ORDER BY created_at, id'),
      upsertSlot: this.db.prepare(`
        INSERT INTO slots (id, owner_id, meta, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET meta = excluded.meta, owner_id = excluded.owner_id`),
      deleteSlot: this.db.prepare('DELETE FROM slots WHERE id = ?'),
      countSlots: this.db.prepare('SELECT COUNT(*) AS n FROM slots'),

      listGames: this.db.prepare('SELECT * FROM games WHERE owner_id = ? ORDER BY created_at DESC'),
      gameById: this.db.prepare('SELECT * FROM games WHERE id = ?'),
      gameByOwnerFile: this.db.prepare('SELECT * FROM games WHERE owner_id = ? AND file_name = ?'),
      deleteGame: this.db.prepare('DELETE FROM games WHERE id = ?'),
      insertGame: this.db.prepare(`
        INSERT INTO games (id, owner_id, label, file_name, disk_path, default_name, default_vendor, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    };
  }

  // Lồng nhau được: chỉ lớp ngoài cùng BEGIN/COMMIT
  transaction(fn) {
    if (this.txDepth) {
      this.txDepth++;
      try {
        return fn();
      } finally {
        this.txDepth--;
      }
    }
    this.txDepth = 1;
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.txDepth = 0;
    }
  }

  // Sao lưu nhất quán khi server đang chạy (không cần dừng ghi)
  backupTo(file) {
    this.db.prepare('VACUUM INTO ?').run(file);
  }

  // ---- Users ----
  countUsers() {
    return this.stmt.countUsers.get().n;
  }

  getUser(id) {
    return this.stmt.userById.get(id) || null;
  }

  getUserByName(username) {
    return this.stmt.userByName.get(String(username)) || null;
  }

  listUsers() {
    return this.stmt.listUsers.all();
  }

  createUser({ username, password, role = 'user', plan = 'none', planExpiresAt = null }) {
    const r = this.stmt.insertUser.run(
      username,
      hashPassword(password),
      role,
      PLANS[plan] ? plan : 'none',
      planExpiresAt,
      Date.now()
    );
    return this.getUser(Number(r.lastInsertRowid));
  }

  updateUser(id, fields) {
    const cols = {
      passwordHash: 'password_hash',
      role: 'role',
      plan: 'plan',
      planExpiresAt: 'plan_expires_at',
      disabled: 'disabled'
    };
    const sets = [];
    const vals = [];
    for (const [k, col] of Object.entries(cols)) {
      if (fields[k] !== undefined) {
        sets.push(`${col} = ?`);
        vals.push(fields[k]);
      }
    }
    if (sets.length) {
      this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    }
    return this.getUser(id);
  }

  deleteUser(id) {
    this.stmt.deleteUser.run(id);
  }

  listExpiredPlans(now = Date.now()) {
    return this.stmt.expiredPlans.all(now);
  }

  // ---- Sessions ----
  createSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.stmt.insertSession.run(sha256(token), userId, Date.now() + SESSION_TTL_MS);
    return token;
  }

  getSessionUser(token) {
    if (!token) return null;
    return this.stmt.sessionUser.get(sha256(token), Date.now()) || null;
  }

  deleteSession(token) {
    if (token) this.stmt.deleteSession.run(sha256(token));
  }

  deleteUserSessions(userId) {
    this.stmt.deleteUserSessions.run(userId);
  }

  purgeExpiredSessions() {
    this.stmt.purgeSessions.run(Date.now());
  }

  // ---- Slots ----
  listSlots() {
    return this.stmt.listSlots.all().map((r) => ({
      id: r.id,
      ownerId: r.owner_id,
      createdAt: r.created_at,
      meta: JSON.parse(decryptText(this.key, r.meta))
    }));
  }

  countSlots() {
    return this.stmt.countSlots.get().n;
  }

  saveSlot(id, ownerId, meta, createdAt = Date.now()) {
    this.stmt.upsertSlot.run(id, ownerId, encryptText(this.key, JSON.stringify(meta)), createdAt);
  }

  deleteSlot(id) {
    this.stmt.deleteSlot.run(id);
  }

  // ---- Cài đặt (key bí mật được mã hóa như dữ liệu slot) ----
  getSetting(key) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? decryptText(this.key, row.value) : null;
  }

  // value = null -> xóa (quay về giá trị trong .env)
  setSetting(key, value, { secret = false } = {}) {
    if (value === null) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      return;
    }
    const stored = secret ? encryptText(this.key, String(value)) : String(value);
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, stored);
  }

  // ---- Ví & thanh toán ----
  // Mã nạp tiền riêng của user, ghi trong nội dung chuyển khoản (vd. TREO7K3QX9)
  ensurePayCode(userId, prefix) {
    const user = this.getUser(userId);
    if (user.pay_code) return user.pay_code;
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // bỏ 0/O, 1/I dễ nhầm
    for (;;) {
      let code = prefix;
      for (const b of crypto.randomBytes(6)) code += alphabet[b % alphabet.length];
      if (!this.getUserByPayCode(code)) {
        this.db.prepare('UPDATE users SET pay_code = ? WHERE id = ?').run(code, userId);
        return code;
      }
    }
  }

  getUserByPayCode(code) {
    return this.db.prepare('SELECT * FROM users WHERE pay_code = ?').get(code) || null;
  }

  setPendingProduct(userId, productId) {
    this.db.prepare('UPDATE users SET pending_product = ? WHERE id = ?').run(productId, userId);
  }

  setAutoRenew(userId, productId) {
    this.db.prepare('UPDATE users SET auto_renew = ? WHERE id = ?').run(productId, userId);
  }

  // User bật tự gia hạn có gói hết hạn trước mốc `before` (gồm cả gói đã hết hạn)
  listAutoRenewDue(before) {
    return this.db
      .prepare("SELECT * FROM users WHERE auto_renew IS NOT NULL AND plan != 'none' AND plan_expires_at IS NOT NULL AND plan_expires_at < ?")
      .all(before);
  }

  // Cộng/trừ ví và ghi sổ cái. Trừ quá số dư -> lỗi INSUFFICIENT_BALANCE.
  addBalance(userId, delta, reason, note = null) {
    return this.transaction(() => {
      const user = this.getUser(userId);
      if (!user) throw new Error('Không tìm thấy user');
      const after = user.balance + delta;
      if (after < 0) {
        const err = new Error('Số dư không đủ');
        err.code = 'INSUFFICIENT_BALANCE';
        throw err;
      }
      this.db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(after, userId);
      this.db
        .prepare('INSERT INTO ledger (user_id, delta, balance_after, reason, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(userId, delta, after, reason, note, Date.now());
      return after;
    });
  }

  listLedger(userId, limit = 30) {
    return this.db.prepare('SELECT * FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit);
  }

  // Trả về false nếu giao dịch này đã được ghi (webhook gửi lại)
  recordPayment({ provider, txnId, amount, content, userId, status, raw }) {
    try {
      this.db
        .prepare(`INSERT INTO payments (provider, txn_id, amount, content, user_id, status, raw, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(provider, String(txnId), amount, content, userId, status, raw, Date.now());
      return true;
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return false;
      throw e;
    }
  }

  listPayments(limit = 100) {
    return this.db
      .prepare(`SELECT p.id, p.provider, p.txn_id, p.amount, p.content, p.user_id, p.status, p.created_at,
                       u.username
                FROM payments p LEFT JOIN users u ON u.id = p.user_id
                ORDER BY p.id DESC LIMIT ?`)
      .all(limit);
  }

  getPayment(id) {
    return this.db.prepare('SELECT * FROM payments WHERE id = ?').get(id) || null;
  }

  markPaymentCredited(id, userId) {
    this.db.prepare("UPDATE payments SET status = 'credited', user_id = ? WHERE id = ?").run(userId, id);
  }

  // ---- Games do người dùng tải lên ----
  listGames(ownerId) {
    return this.stmt.listGames.all(ownerId);
  }

  getGame(id) {
    return this.stmt.gameById.get(id) || null;
  }

  // Một user tải lại cùng tên file thì thay bản cũ trong kho (giống catalog.json cũ)
  saveGame({ id, ownerId, label, fileName, diskPath, defaultName, defaultVendor }) {
    const old = this.stmt.gameByOwnerFile.get(ownerId, fileName);
    if (old) this.stmt.deleteGame.run(old.id);
    this.stmt.insertGame.run(id, ownerId, label, fileName, diskPath, defaultName, defaultVendor, Date.now());
  }
}

module.exports = { AppDb, PLANS, getPlan, hashPassword, verifyPassword };
