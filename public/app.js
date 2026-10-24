/**
 * CLOUD J2ME PRO STUDIO — PARALLEL MULTI-TAB & MULTI-BOX SYNC ENGINE
 * - Razor-sharp 2x HiDPI Supersampled Canvas + SVG Smart Sharpen Filter (Zero blurry fonts)
 * - Persistent Eco Mode toggle switch + Per-tab 0% CPU Background Farming ("Ẩn hình")
 * - Multi-Tab Sync ("Đồng bộ đa tab"): 1 click/key controls all synced accounts simultaneously
 * - Quick Command Chips, Instant PNG Screenshot, Spotlight Zoom & Live FPS HUD
 */

const SHARPNESS_MODES = [
  { id: 'hd-sharp', label: 'Siêu nét HD' },
  { id: 'pixelated', label: 'Pixel 1:1' },
  { id: 'smooth', label: 'Mượt dịu' }
];

const DEFAULT_QUICK_CHIPS = ['ak', 'tdlt', 'khu 1', 'ts', 'khu 2', 'nhặt đồ'];

// Icon SVG nét mảnh (thay emoji trên nút), dùng: icon('power')
const ICON_PATHS = {
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  expand: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  play: '<path d="m7 4 13 8-13 8z"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 8 10 8a17.5 17.5 0 0 1-2.16 3.19M6.6 6.6A17.4 17.4 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M2 2l20 20"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M7 15h10"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>'
};

function powerLabel(isRunning) {
  return isRunning ? `${icon('power', 'ico ico-sm')} Tắt` : `${icon('play', 'ico ico-sm')} Bật`;
}

function streamLabel(hidden) {
  return hidden ? `${icon('eye', 'ico ico-sm')} Hiện` : `${icon('eyeOff', 'ico ico-sm')} Ẩn hình`;
}

function icon(name, cls = 'ico') {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
}

// Hết phiên đăng nhập -> quay về trang đăng nhập
const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await nativeFetch(...args);
  if (res.status === 401) location.replace('/login.html');
  return res;
};

const state = {
  me: null,
  config: { canUpload: false, contact: '', billing: false },
  billing: null,
  billingTopupOpen: false,
  slots: [],
  presets: [],
  focusedSlotId: '',
  inspectorOpen: true,
  ecoMode: localStorage.getItem('j2me_eco_mode') !== 'false',
  syncAllMode: false,
  syncedSlotIds: new Set(),
  gridSize: localStorage.getItem('j2me_grid_size') || 'normal',
  sharpnessIdx: Number(localStorage.getItem('j2me_sharpness_idx') || 0),
  showAllKeypads: localStorage.getItem('j2me_show_keypads') !== 'false',
  quickChips: loadQuickChips(),
  ws: null,

  // Per-slot UI & Canvas references:
  // Map<slotId, { card, canvas, ctx, img, logicalW, logicalH, pointerDown, showNumpad, streamHidden, spotlight, frameCount, lastFpsTs, currentFps }>
  slotViews: new Map(),
  pendingFrames: new Map(),
  rafScheduled: false,

  // Macro recording state (records on currently focused slot)
  recording: false,
  recordedSteps: [],
  lastRecordTs: 0,

  // New Tab Modal selected file
  newTabSelectedFile: null
};

function loadQuickChips() {
  try {
    const saved = JSON.parse(localStorage.getItem('j2me_quick_chips') || 'null');
    if (Array.isArray(saved) && saved.length > 0) return saved;
  } catch (e) {}
  return [...DEFAULT_QUICK_CHIPS];
}

function saveQuickChips() {
  localStorage.setItem('j2me_quick_chips', JSON.stringify(state.quickChips));
}

// ============================================================================
// INITIALIZATION
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
  initThemeAndWallpaper();
  initTopbarControls();
  initQuickChipsBar();
  initInspectorControls();
  initModals();
  initAccountModal();
  initBillingModal();
  initGlobalKeyboard();

  // Điện thoại: bảng cài đặt tab là tấm trượt che màn hình -> mặc định đóng, bấm ⚙ mới mở
  if (window.matchMedia('(max-width: 640px)').matches) {
    state.inspectorOpen = false;
    updateInspectorVisibility();
  }

  await fetchBootstrap();
  connectWebSocket();

  // Periodic remaining time & FPS HUD refresh
  setInterval(() => {
    updateInspectorRemainingTime();
    renderAccount();
  }, 30000);
  setInterval(updateAllFpsBadges, 1000);
});

async function fetchBootstrap() {
  try {
    const res = await fetch('/api/bootstrap');
    const data = await res.json();
    state.me = data.me || null;
    state.config = data.config || { canUpload: false, contact: '' };
    document.body.classList.toggle('no-upload', !state.config.canUpload);
    state.slots = data.slots || [];
    state.presets = data.presets || [];
    renderAccount();

    for (const s of state.slots) {
      state.syncedSlotIds.add(s.id);
    }

    if (state.slots.length > 0 && !state.slots.some((s) => s.id === state.focusedSlotId)) {
      state.focusedSlotId = state.slots[0].id;
    }

    renderPresetsDropdowns();
    renderAllDeviceCards();
    renderSubbarPills();
    updateClusterStats();
    renderInspectorForFocusedSlot();
  } catch (err) {
    showToast('Không thể tải dữ liệu máy chủ: ' + err.message);
  }
}

// ============================================================================
// MULTIPLEXED WEBSOCKET & HI-DPI SUPERSAMPLED rAF RENDERER
// ============================================================================
function connectWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}`);
  state.ws = ws;

  ws.onopen = () => {
    sendVisibility();
    sendWs({
      type: 'focus',
      slotId: state.focusedSlotId,
      ecoMode: state.ecoMode
    });
  };

  ws.onmessage = (evt) => {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch (e) {
      return;
    }

    switch (msg.type) {
      case 'frame': {
        if (document.hidden && state.ecoMode) return;
        const view = state.slotViews.get(msg.slotId);
        if (view) {
          view.frameCount = (view.frameCount || 0) + 1;
          if (view.streamHidden) return; // 0% CPU Background Farming Mode
        }
        state.pendingFrames.set(msg.slotId, msg.data);
        scheduleFramePaint();
        break;
      }
      case 'state': {
        if (msg.slot) {
          upsertSlotState(msg.slot);
        }
        break;
      }
      case 'slots_updated': {
        if (Array.isArray(msg.slots)) {
          state.slots = msg.slots;
          for (const s of state.slots) {
            if (!state.syncedSlotIds.has(s.id)) {
              state.syncedSlotIds.add(s.id);
            }
          }
          if (state.slots.length > 0 && !state.slots.some((s) => s.id === state.focusedSlotId)) {
            state.focusedSlotId = state.slots[0].id;
          }
          renderAllDeviceCards();
          renderSubbarPills();
          updateClusterStats();
          renderInspectorForFocusedSlot();
        }
        break;
      }
      case 'textbox': {
        const slot = state.slots.find((s) => s.id === msg.slotId);
        if (slot) {
          slot.activeTextBox = msg.data;
          updateCardTextBoxUI(msg.slotId, msg.data);
        }
        break;
      }
      case 'socket': {
        const slot = state.slots.find((s) => s.id === msg.slotId);
        if (slot) {
          slot.socketState = msg.data;
          if (msg.slotId === state.focusedSlotId) {
            updateInspectorSocketInfo(slot);
          }
        }
        break;
      }
      case 'toast': {
        if (msg.message) showToast(msg.message);
        break;
      }
      case 'account': {
        if (msg.me) {
          state.me = msg.me;
          renderAccount();
        }
        break;
      }
      default:
        break;
    }
  };

  ws.onclose = () => {
    // fetch tự chuyển về trang đăng nhập nếu phiên đã hết hạn
    setTimeout(async () => {
      try {
        const res = await fetch('/api/me');
        if (res.status === 401) return;
      } catch (e) {}
      connectWebSocket();
    }, 2000);
  };
}

// Báo server tab nào không cần hình (đang "Ẩn hình", hoặc cả trang bị ẩn khi bật Siêu nhẹ)
// để emulator ngừng mã hóa khung hình cho các tab đó -> nhẹ CPU, tab đang xem mượt hơn
function sendVisibility() {
  const hiddenSlots = [];
  for (const [slotId, view] of state.slotViews.entries()) {
    if (view.streamHidden) hiddenSlots.push(slotId);
  }
  sendWs({ type: 'visibility', pageHidden: document.hidden && state.ecoMode, hiddenSlots });
}

document.addEventListener('visibilitychange', sendVisibility);

function sendWs(payload) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
  }
}

/**
 * Coalesces incoming base64 PNG frames across all tabs into a single requestAnimationFrame pass
 */
function scheduleFramePaint() {
  if (state.rafScheduled) return;
  state.rafScheduled = true;

  requestAnimationFrame(() => {
    state.rafScheduled = false;
    for (const [slotId, b64] of state.pendingFrames.entries()) {
      state.pendingFrames.delete(slotId);
      const view = state.slotViews.get(slotId);
      if (!view || view.streamHidden) continue;
      view.img.src = 'data:image/png;base64,' + b64;
    }
  });
}

function updateAllFpsBadges() {
  for (const [slotId, view] of state.slotViews.entries()) {
    const slot = state.slots.find((s) => s.id === slotId);
    const fpsEl = view.card.querySelector('[data-role="fps-badge"]');
    if (!fpsEl) continue;

    if (!slot || !slot.running) {
      fpsEl.textContent = 'OFF';
    } else if (view.streamHidden) {
      fpsEl.textContent = '0% CPU';
    } else {
      const fps = view.frameCount || 0;
      view.frameCount = 0;
      fpsEl.textContent = `${fps} FPS`;
    }
  }
}

function upsertSlotState(updatedSlot) {
  const idx = state.slots.findIndex((s) => s.id === updatedSlot.id);
  if (idx >= 0) {
    state.slots[idx] = updatedSlot;
  } else {
    state.slots.push(updatedSlot);
    state.syncedSlotIds.add(updatedSlot.id);
    renderAllDeviceCards();
  }

  updateSingleDeviceCardUI(updatedSlot);
  renderSubbarPills();
  updateClusterStats();

  if (updatedSlot.id === state.focusedSlotId) {
    renderInspectorForFocusedSlot();
  }
}

// ============================================================================
// MULTI-TAB SYNC ROUTER ("ĐỒNG BỘ THAO TÁC ĐA TAB")
// ============================================================================
function getTargetSlotIds(originSlotId) {
  if (state.syncAllMode && state.syncedSlotIds.has(originSlotId)) {
    const activeTargets = state.slots
      .filter((s) => s.running && state.syncedSlotIds.has(s.id))
      .map((s) => s.id);
    if (activeTargets.length > 0) return activeTargets;
  }
  return [originSlotId];
}

function dispatchInputToTargets(originSlotId, payloadBuilder) {
  const targets = getTargetSlotIds(originSlotId);
  for (const tid of targets) {
    sendWs(payloadBuilder(tid));
  }
}

// ============================================================================
// PARALLEL MULTI-SCREEN GRID RENDERING
// ============================================================================
function renderAllDeviceCards() {
  const grid = document.getElementById('devicesGrid');
  grid.setAttribute('data-grid-size', state.gridSize);

  const currentIds = new Set(state.slots.map((s) => s.id));
  for (const existingId of state.slotViews.keys()) {
    if (!currentIds.has(existingId)) {
      state.slotViews.delete(existingId);
    }
  }

  grid.innerHTML = '';

  for (const slot of state.slots) {
    const cardEl = buildDeviceCard(slot);
    grid.appendChild(cardEl);
  }

  // Append "+ Mở thêm tab mới" card at the end of the row
  const addCard = document.createElement('div');
  addCard.className = 'add-slot-card';
  addCard.innerHTML = `
    <div class="add-slot-plus">${icon('plus')}</div>
    <div class="add-slot-title">Thêm tab treo</div>
    <div class="add-slot-desc">Chạy thêm một nick nữa, song song 24/7</div>
  `;
  addCard.addEventListener('click', () => openNewTabModal());
  grid.appendChild(addCard);
}

function buildDeviceCard(slot) {
  const prevView = state.slotViews.get(slot.id);
  const showNumpad = prevView ? prevView.showNumpad : false;
  const streamHidden = prevView ? prevView.streamHidden : false;
  const spotlight = prevView ? prevView.spotlight : false;
  const isSynced = state.syncedSlotIds.has(slot.id);

  const card = document.createElement('article');
  const classes = ['device-card'];
  if (slot.id === state.focusedSlotId) classes.push('focused');
  if (state.syncAllMode && isSynced) classes.push('synced-card');
  if (spotlight) classes.push('spotlight-card');
  card.className = classes.join(' ');
  card.dataset.slotId = slot.id;

  const isRunning = Boolean(slot.running);
  const gameName = slot.gameInfo?.name || 'Game.jar';
  const logicalW = slot.width || 240;
  const logicalH = slot.height || 320;

  card.innerHTML = `
    <!-- Card Top Header -->
    <div class="device-card-header">
      <div class="device-title-group">
        <span class="status-dot ${isRunning ? 'running' : 'stopped'}" data-role="dot"></span>
        <span class="device-slot-name" data-role="name">${escapeHtml(slot.name || slot.id)}</span>
        <span class="device-game-pill" data-role="game">${escapeHtml(gameName)}</span>
      </div>
      <div class="device-header-actions">
        <button class="card-icon-btn sync-badge-btn ${isSynced ? 'active' : ''}" data-action="toggle-slot-sync" title="Bật/tắt nhận lệnh Đồng bộ đa tab cho ${slot.id}">${icon('link')}</button>
        <button class="card-icon-btn" data-action="spotlight" title="Phóng to tab này">${icon('expand')}</button>
        <button class="card-icon-btn" data-action="screenshot" title="Chụp ảnh màn hình tab này">${icon('camera')}</button>
        <button class="card-icon-btn settings-btn ${slot.id === state.focusedSlotId && state.inspectorOpen ? 'active' : ''}" data-action="open-settings" title="Mở cài đặt riêng cho tab ${slot.id}">${icon('sliders')}</button>
        <button class="card-icon-btn delete-btn" data-action="delete-slot" title="Đóng / Xóa tab này">${icon('x')}</button>
      </div>
    </div>

    <!-- Quick Action Strip -->
    <div class="device-quick-strip">
      <div class="quick-strip-btns">
        <button class="q-btn ${isRunning ? 'power-on' : 'power-off'}" data-action="toggle-power">
${powerLabel(isRunning)}</button>
        <button class="q-btn upload-only" data-action="quick-upload" title="Tải file .jar từ máy lên tab này">${icon('upload', 'ico ico-sm')} .jar</button>
        <button class="q-btn" data-action="restart" title="Khởi động lại game trên tab này">${icon('refresh', 'ico ico-sm')} Reset</button>
        <button class="q-btn ${streamHidden ? 'active-toggle' : ''}" data-action="toggle-stream-hide" title="Ẩn hình để treo ngầm 0% CPU trình duyệt (Game vẫn chạy 100% trên VPS)">
${streamLabel(streamHidden)}</button>
        <button class="q-btn" data-action="toggle-keypad" title="Ẩn/Hiện phím bấm của tab này">${icon('keyboard', 'ico ico-sm')} Phím</button>
      </div>
      <div class="device-hud-right">
        <span class="fps-badge" data-role="fps-badge">${isRunning ? 'LIVE' : 'OFF'}</span>
      </div>
      <input type="file" accept=".jar" data-role="quick-jar-input" hidden />
    </div>

    <!-- Screen Canvas Area -->
    <div class="device-screen-wrap">
      <!-- 2x Supersampled Backing Store (480x640 for 240x320) so scaled text is never blurry -->
      <canvas class="device-canvas" width="${logicalW * 2}" height="${logicalH * 2}"></canvas>

      <div class="device-off-overlay ${isRunning ? 'hidden' : ''}" data-role="off-overlay">
        <div class="overlay-ico">${icon('power')}</div>
        <div><strong>Máy treo đang tắt</strong></div>
        <button class="btn-emerald" data-action="start-now">Bật máy</button>
      </div>

      <div class="device-hidden-stream-overlay ${streamHidden && isRunning ? '' : 'hidden'}" data-role="hidden-stream-overlay">
        <div class="overlay-ico">${icon('eyeOff')}</div>
        <div><strong>Đang treo ngầm trên VPS</strong></div>
        <div class="overlay-sub">Game vẫn chạy, chỉ tắt hình để nhẹ máy</div>
        <button class="btn-emerald" data-action="resume-stream">Hiện lại màn hình</button>
      </div>
    </div>

    <!-- Auto-appearing Native J2ME TextBox Input Bar -->
    <div class="device-textbox-bar ${slot.activeTextBox?.active ? '' : 'hidden'}" data-role="textbox-bar">
      <div class="tb-label" data-role="textbox-title">Nhập vào game:</div>
      <div class="tb-row">
        <input type="text" class="input-field" data-role="textbox-input" placeholder="Nhập tài khoản / mật khẩu..." />
        <button class="btn-emerald" data-action="textbox-ok">OK</button>
      </div>
    </div>

    <!-- Compact J2ME Keypad -->
    <div class="device-keypad ${state.showAllKeypads ? '' : 'hidden'}" data-role="keypad">
      <div class="dpad-row">
        <button class="k-btn" data-key="-6">Chọn Trái</button>
        <button class="k-btn" data-key="-1">▲ Lên</button>
        <button class="k-btn" data-key="-7">Chọn Phải</button>
        <button class="k-btn" data-key="-3">◀ Trái</button>
        <button class="k-btn k-ok" data-key="-5">OK / Giữa</button>
        <button class="k-btn" data-key="-4">Phải ▶</button>
        <button class="k-btn" data-action="toggle-numpad">123 Phím số</button>
        <button class="k-btn" data-key="-2">▼ Xuống</button>
        <button class="k-btn" data-action="focus-send-text">⌨ Gõ chữ</button>
      </div>

      <div class="numpad-grid ${showNumpad ? '' : 'hidden'}" data-role="numpad">
        <button class="k-btn" data-key="49">1</button>
        <button class="k-btn" data-key="50">2 ABC</button>
        <button class="k-btn" data-key="51">3 DEF</button>
        <button class="k-btn" data-key="52">4 GHI</button>
        <button class="k-btn" data-key="53">5 JKL</button>
        <button class="k-btn" data-key="54">6 MNO</button>
        <button class="k-btn" data-key="55">7 PQRS</button>
        <button class="k-btn" data-key="56">8 TUV</button>
        <button class="k-btn" data-key="57">9 WXYZ</button>
        <button class="k-btn" data-key="42">* Sao</button>
        <button class="k-btn" data-key="48">0</button>
        <button class="k-btn" data-key="35"># Thăng</button>
      </div>
    </div>
  `;

  const canvas = card.querySelector('.device-canvas');
  const ctx = canvas.getContext('2d', { alpha: false });

  const view = {
    card,
    canvas,
    ctx,
    img: new Image(),
    logicalW,
    logicalH,
    pointerDown: false,
    showNumpad,
    streamHidden,
    spotlight,
    frameCount: 0
  };

  view.img.onload = () => {
    view.logicalW = view.img.width || 240;
    view.logicalH = view.img.height || 320;

    // Use 2x Supersampled Canvas Backing Store so non-integer CSS sizes remain razor sharp
    const targetW = view.logicalW * 2;
    const targetH = view.logicalH * 2;
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    // Nearest-neighbor 2x upscale into backing buffer preserves crisp 1px bitmap font edges!
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(view.img, 0, 0, targetW, targetH);
  };

  state.slotViews.set(slot.id, view);
  wireDeviceCardEvents(slot.id, view);
  return card;
}

function wireDeviceCardEvents(slotId, view) {
  const { card, canvas } = view;

  // Clicking anywhere on the card focuses this tab and updates the Inspector for this tab
  card.addEventListener('mousedown', (e) => {
    if (e.target.closest('[data-action="delete-slot"]')) return;
    if (state.focusedSlotId !== slotId) {
      selectSlot(slotId, { openInspector: false });
    }
  });

  // Card action buttons
  card.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'open-settings') {
      e.stopPropagation();
      selectSlot(slotId, { openInspector: true });
    } else if (action === 'toggle-slot-sync') {
      e.stopPropagation();
      if (state.syncedSlotIds.has(slotId)) {
        state.syncedSlotIds.delete(slotId);
      } else {
        state.syncedSlotIds.add(slotId);
      }
      const isSynced = state.syncedSlotIds.has(slotId);
      btn.classList.toggle('active', isSynced);
      card.classList.toggle('synced-card', state.syncAllMode && isSynced);
      showToast(
        isSynced
          ? `🔗 Đã thêm ${slotId} vào nhóm Đồng bộ đa tab`
          : `Đã tách ${slotId} khỏi nhóm Đồng bộ`
      );
    } else if (action === 'spotlight') {
      e.stopPropagation();
      view.spotlight = !view.spotlight;
      card.classList.toggle('spotlight-card', view.spotlight);
    } else if (action === 'screenshot') {
      e.stopPropagation();
      takeSlotScreenshot(slotId);
    } else if (action === 'delete-slot') {
      e.stopPropagation();
      await handleDeleteSlot(slotId);
    } else if (action === 'toggle-power') {
      e.stopPropagation();
      await toggleSlotPower(slotId, 'toggle');
    } else if (action === 'start-now') {
      e.stopPropagation();
      await toggleSlotPower(slotId, 'start');
    } else if (action === 'restart') {
      e.stopPropagation();
      await toggleSlotPower(slotId, 'restart');
    } else if (action === 'toggle-stream-hide' || action === 'resume-stream') {
      e.stopPropagation();
      view.streamHidden = action === 'resume-stream' ? false : !view.streamHidden;
      const hideOverlay = card.querySelector('[data-role="hidden-stream-overlay"]');
      const hideBtn = card.querySelector('[data-action="toggle-stream-hide"]');
      if (hideOverlay) hideOverlay.classList.toggle('hidden', !view.streamHidden);
      if (hideBtn) {
        hideBtn.classList.toggle('active-toggle', view.streamHidden);
        hideBtn.innerHTML = streamLabel(view.streamHidden);
      }
      sendVisibility();
      if (!view.streamHidden) {
        sendWs({ type: 'focus', slotId, ecoMode: state.ecoMode });
      }
    } else if (action === 'quick-upload') {
      e.stopPropagation();
      const fileInput = card.querySelector('[data-role="quick-jar-input"]');
      if (fileInput) fileInput.click();
    } else if (action === 'toggle-keypad') {
      e.stopPropagation();
      const kp = card.querySelector('[data-role="keypad"]');
      if (kp) kp.classList.toggle('hidden');
    } else if (action === 'toggle-numpad') {
      e.stopPropagation();
      const np = card.querySelector('[data-role="numpad"]');
      if (np) {
        np.classList.toggle('hidden');
        view.showNumpad = !np.classList.contains('hidden');
      }
    } else if (action === 'focus-send-text') {
      e.stopPropagation();
      selectSlot(slotId, { openInspector: true });
      switchInspectorTab('auto');
      const input = document.getElementById('sendTextInput');
      if (input) input.focus();
    } else if (action === 'textbox-ok') {
      e.stopPropagation();
      submitCardTextBox(slotId);
    }
  });

  // Quick .jar upload input directly on card
  const quickJarInput = card.querySelector('[data-role="quick-jar-input"]');
  if (quickJarInput) {
    quickJarInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) {
        await uploadJarToSlot(slotId, file);
        quickJarInput.value = '';
      }
    });
  }

  // Native TextBox Enter key inside card
  const tbInput = card.querySelector('[data-role="textbox-input"]');
  if (tbInput) {
    tbInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        submitCardTextBox(slotId);
      }
    });
  }

  // Virtual Keypad buttons inside card (Supports Multi-Tab Sync!)
  card.querySelectorAll('.k-btn[data-key]').forEach((btn) => {
    const keyCode = Number(btn.dataset.key);
    const startKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectSlot(slotId, { openInspector: false });
      btn.classList.add('pressed');
      dispatchInputToTargets(slotId, (tid) => ({ type: 'KEY_DOWN', slotId: tid, keyCode }));
      recordStepIfActive(slotId, { action: 'KEY_PRESS', keyCode });
    };
    const endKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.classList.remove('pressed');
      dispatchInputToTargets(slotId, (tid) => ({ type: 'KEY_UP', slotId: tid, keyCode }));
    };

    btn.addEventListener('mousedown', startKey);
    btn.addEventListener('mouseup', endKey);
    btn.addEventListener('mouseleave', () => btn.classList.remove('pressed'));
    btn.addEventListener('touchstart', startKey, { passive: false });
    btn.addEventListener('touchend', endKey, { passive: false });
  });

  // Canvas Pointer / Touch Input mapped accurately to logicalW x logicalH
  const getCanvasCoords = (evt) => {
    const rect = canvas.getBoundingClientRect();
    const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
    const clientY = evt.touches ? evt.touches[0].clientY : evt.clientY;
    const lw = view.logicalW || 240;
    const lh = view.logicalH || 320;
    const x = Math.max(0, Math.min(lw - 1, Math.round(((clientX - rect.left) / rect.width) * lw)));
    const y = Math.max(0, Math.min(lh - 1, Math.round(((clientY - rect.top) / rect.height) * lh)));
    return { x, y };
  };

  canvas.addEventListener('mousedown', (e) => {
    e.preventDefault();
    selectSlot(slotId, { openInspector: false });
    view.pointerDown = true;
    const { x, y } = getCanvasCoords(e);
    dispatchInputToTargets(slotId, (tid) => ({ type: 'POINTER_DOWN', slotId: tid, x, y }));
    recordStepIfActive(slotId, { action: 'CLICK', x, y });
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!view.pointerDown) return;
    const { x, y } = getCanvasCoords(e);
    dispatchInputToTargets(slotId, (tid) => ({ type: 'POINTER_DRAG', slotId: tid, x, y }));
  });

  window.addEventListener('mouseup', (e) => {
    if (!view.pointerDown) return;
    view.pointerDown = false;
    const { x, y } = getCanvasCoords(e);
    dispatchInputToTargets(slotId, (tid) => ({ type: 'POINTER_UP', slotId: tid, x, y }));
  });

  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    selectSlot(slotId, { openInspector: false });
    view.pointerDown = true;
    const { x, y } = getCanvasCoords(e);
    dispatchInputToTargets(slotId, (tid) => ({ type: 'POINTER_DOWN', slotId: tid, x, y }));
    recordStepIfActive(slotId, { action: 'CLICK', x, y });
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    if (!view.pointerDown) return;
    e.preventDefault();
    const { x, y } = getCanvasCoords(e);
    dispatchInputToTargets(slotId, (tid) => ({ type: 'POINTER_DRAG', slotId: tid, x, y }));
  }, { passive: false });

  canvas.addEventListener('touchend', () => {
    if (!view.pointerDown) return;
    view.pointerDown = false;
    dispatchInputToTargets(slotId, (tid) => ({ type: 'POINTER_UP', slotId: tid, x: 0, y: 0 }));
  });
}

function takeSlotScreenshot(slotId) {
  const view = state.slotViews.get(slotId);
  if (!view || !view.canvas) return;

  const link = document.createElement('a');
  const now = new Date();
  const ts = `${now.getHours()}h${now.getMinutes()}m${now.getSeconds()}s`;
  link.download = `CloudJ2ME_${slotId}_${ts}.png`;
  link.href = view.canvas.toDataURL('image/png');
  link.click();
  showToast(`📸 Đã lưu ảnh chụp màn hình của tab ${slotId}!`);
}

function updateSingleDeviceCardUI(slot) {
  const view = state.slotViews.get(slot.id);
  if (!view) return;
  const { card } = view;

  const isRunning = Boolean(slot.running);
  const dot = card.querySelector('[data-role="dot"]');
  if (dot) dot.className = `status-dot ${isRunning ? 'running' : 'stopped'}`;

  const nameEl = card.querySelector('[data-role="name"]');
  if (nameEl) nameEl.textContent = slot.name || slot.id;

  const gameEl = card.querySelector('[data-role="game"]');
  if (gameEl) gameEl.textContent = slot.gameInfo?.name || 'Game.jar';

  const powerBtn = card.querySelector('[data-action="toggle-power"]');
  if (powerBtn) {
    powerBtn.className = `q-btn ${isRunning ? 'power-on' : 'power-off'}`;
    powerBtn.innerHTML = powerLabel(isRunning);
  }

  const offOverlay = card.querySelector('[data-role="off-overlay"]');
  if (offOverlay) offOverlay.classList.toggle('hidden', isRunning);

  const hideOverlay = card.querySelector('[data-role="hidden-stream-overlay"]');
  if (hideOverlay) hideOverlay.classList.toggle('hidden', !(view.streamHidden && isRunning));

  updateCardTextBoxUI(slot.id, slot.activeTextBox);
}

function updateCardTextBoxUI(slotId, tb) {
  const view = state.slotViews.get(slotId);
  if (!view) return;
  const bar = view.card.querySelector('[data-role="textbox-bar"]');
  const titleEl = view.card.querySelector('[data-role="textbox-title"]');
  const inputEl = view.card.querySelector('[data-role="textbox-input"]');
  if (!bar || !inputEl) return;

  if (tb && tb.active) {
    bar.classList.remove('hidden');
    titleEl.textContent = `${tb.title || 'Nhập vào game'}:`;
    inputEl.type = tb.password ? 'password' : 'text';
    inputEl.value = tb.text || '';
    if (slotId === state.focusedSlotId) {
      setTimeout(() => inputEl.focus(), 50);
    }
  } else {
    bar.classList.add('hidden');
  }
}

function submitCardTextBox(slotId) {
  const view = state.slotViews.get(slotId);
  if (!view) return;
  const inputEl = view.card.querySelector('[data-role="textbox-input"]');
  if (!inputEl) return;

  const text = inputEl.value;
  dispatchInputToTargets(slotId, (tid) => ({ type: 'TEXTBOX_SUBMIT', slotId: tid, text }));
  recordStepIfActive(slotId, { action: 'TEXTBOX_SUBMIT', text });

  const bar = view.card.querySelector('[data-role="textbox-bar"]');
  if (bar) bar.classList.add('hidden');
}

// ============================================================================
// QUICK COMMAND CHIPS BAR ("⚡ LỆNH NHANH")
// ============================================================================
function initQuickChipsBar() {
  renderQuickChips();
  document.getElementById('btnAddQuickChip').addEventListener('click', () => {
    const cmd = prompt('Nhập lệnh chat / mật khẩu / từ khóa muốn tạo nút bấm nhanh:');
    if (cmd && cmd.trim()) {
      state.quickChips.push(cmd.trim());
      saveQuickChips();
      renderQuickChips();
      showToast(`⚡ Đã thêm nút lệnh nhanh "${cmd.trim()}"`);
    }
  });
}

function renderQuickChips() {
  const wrap = document.getElementById('quickChipsWrap');
  if (!wrap) return;

  wrap.innerHTML = state.quickChips
    .map(
      (chip, idx) => `
      <span class="quick-chip" data-chip-idx="${idx}" title="Bấm để gửi '${escapeHtml(chip)}' vào game">
        <span>${escapeHtml(chip)}</span>
        <span class="quick-chip-del" data-del-chip="${idx}" title="Xóa lệnh này">✕</span>
      </span>
    `
    )
    .join('');

  wrap.querySelectorAll('.quick-chip').forEach((el) => {
    el.addEventListener('click', (e) => {
      const delBtn = e.target.closest('[data-del-chip]');
      if (delBtn) {
        e.stopPropagation();
        const removeIdx = Number(delBtn.dataset.delChip);
        state.quickChips.splice(removeIdx, 1);
        saveQuickChips();
        renderQuickChips();
        return;
      }

      const idx = Number(el.dataset.chipIdx);
      const text = state.quickChips[idx];
      if (!text) return;

      dispatchInputToTargets(state.focusedSlotId, (tid) => ({
        type: 'TEXT',
        slotId: tid,
        text
      }));
      recordStepIfActive(state.focusedSlotId, { action: 'TEXT', text });
      showToast(
        state.syncAllMode
          ? `🔗 Đã gửi "${text}" vào tất cả các tab đồng bộ!`
          : `⚡ Đã gửi "${text}" vào ${state.focusedSlotId}`
      );
    });
  });
}

// ============================================================================
// SELECTING A TAB & UPDATING CONTEXTUAL PER-TAB INSPECTOR
// ============================================================================
function selectSlot(slotId, { openInspector = false } = {}) {
  state.focusedSlotId = slotId;
  if (openInspector) {
    state.inspectorOpen = true;
    updateInspectorVisibility();
  }

  for (const [id, view] of state.slotViews.entries()) {
    const isFocused = id === slotId;
    view.card.classList.toggle('focused', isFocused);
    const sBtn = view.card.querySelector('[data-action="open-settings"]');
    if (sBtn) {
      sBtn.classList.toggle('active', isFocused && state.inspectorOpen);
    }
  }

  renderSubbarPills();
  renderInspectorForFocusedSlot();

  sendWs({
    type: 'focus',
    slotId: state.focusedSlotId,
    ecoMode: state.ecoMode
  });
}

function renderSubbarPills() {
  const bar = document.getElementById('slotPillsBar');
  if (!bar) return;

  bar.innerHTML = state.slots
    .map((slot) => {
      const active = slot.id === state.focusedSlotId ? 'active' : '';
      const dot = slot.running ? 'running' : 'stopped';
      return `
        <button class="slot-mini-pill ${active}" data-pill-slot="${slot.id}">
          <span class="status-dot ${dot}"></span>
          <span>${escapeHtml(slot.name || slot.id)}</span>
        </button>
      `;
    })
    .join('');

  bar.querySelectorAll('[data-pill-slot]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.pillSlot;
      selectSlot(id, { openInspector: true });
      const view = state.slotViews.get(id);
      if (view) {
        view.card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  });
}

function updateClusterStats() {
  const runningCount = state.slots.filter((s) => s.running).length;
  const el = document.getElementById('runningSlotsCount');
  if (el) el.textContent = `${runningCount}/${state.slots.length}`;
}

function renderInspectorForFocusedSlot() {
  const slot = state.slots.find((s) => s.id === state.focusedSlotId);
  // Không có tab nào thì ẩn hẳn bảng cài đặt (tránh hiện dữ liệu mẫu)
  document.getElementById('inspectorPanel')?.classList.toggle('no-slot', !slot);
  if (!slot) return;

  document.querySelectorAll('.accent-slot-id').forEach((el) => {
    el.textContent = slot.name || slot.id;
  });

  document.getElementById('inspStatusDot').className = `status-dot ${slot.running ? 'running' : 'stopped'}`;
  document.getElementById('inspSlotName').textContent = slot.name || slot.id;
  document.getElementById('inspGameName').textContent = slot.gameInfo?.name || 'Game.jar';

  const pwrBtn = document.getElementById('inspBtnTogglePower');
  if (pwrBtn) {
    pwrBtn.innerHTML = slot.running ? `${icon('power', 'ico ico-sm')} Tắt máy` : `${icon('play', 'ico ico-sm')} Bật máy`;
  }

  const auto = slot.automation || {};
  document.getElementById('chkAutoLogin').checked = Boolean(auto.autoLoginEnabled);
  document.getElementById('chkWatchdog').checked = auto.watchdogEnabled !== false;
  document.getElementById('chkPeriodicKey').checked = Boolean(auto.periodicKey?.enabled);
  document.getElementById('selPeriodicKeyCode').value = String(auto.periodicKey?.keyCode ?? -5);
  document.getElementById('inpPeriodicSec').value = auto.periodicKey?.intervalSec || 15;
  document.getElementById('chkScheduledRestart').checked = Boolean(auto.scheduledRestart?.enabled);
  document.getElementById('inpRestartHours').value = auto.scheduledRestart?.everyHours || 6;

  const stopMacroBtn = document.getElementById('btnStopMacro');
  if (stopMacroBtn) {
    stopMacroBtn.classList.toggle('hidden', !slot.playingMacroId);
  }

  renderMacroListForSlot(slot);

  const gi = slot.gameInfo || {};
  document.getElementById('metaGameName').textContent = gi.name || '--';
  document.getElementById('metaVendor').textContent = gi.vendor || '--';
  document.getElementById('metaFileName').textContent = gi.fileName || '--';
  document.getElementById('metaFileSize').textContent = gi.fileSize
    ? (gi.fileSize / 1024).toFixed(1) + ' KB'
    : '--';
  document.getElementById('metaUploadedAt').textContent = gi.uploadedAt || '--';

  const presetSel = document.getElementById('presetSelect');
  if (presetSel && gi.presetId) {
    presetSel.value = gi.presetId;
  }

  document.getElementById('inpWidth').value = slot.width || 240;
  document.getElementById('inpHeight').value = slot.height || 320;
  document.getElementById('inpFps').value = slot.fps || 12;

  document.getElementById('infoSlotId').textContent = slot.id;
  document.getElementById('infoSlotPlan').textContent = slot.plan || 'Dùng thử';
  updateInspectorSocketInfo(slot);
  updateInspectorRemainingTime();
}

function updateInspectorSocketInfo(slot) {
  const el = document.getElementById('infoSocketState');
  if (!el) return;
  const sock = slot.socketState || {};
  if (sock.activeSockets > 0) {
    el.textContent = `Đang kết nối (${sock.activeSockets} socket)`;
    el.className = 'text-emerald';
  } else {
    el.textContent = slot.running ? 'Đang chờ đăng nhập' : 'Đã dừng';
    el.className = '';
  }
}

function updateInspectorRemainingTime() {
  const slot = state.slots.find((s) => s.id === state.focusedSlotId);
  const el = document.getElementById('infoRemainingTime');
  if (!slot || !el) return;

  if (!slot.expiresAt) {
    el.textContent = 'Không giới hạn';
    return;
  }
  el.textContent = formatRemaining(slot.expiresAt);
}

function formatRemaining(expiresAt) {
  const diffMs = Math.max(0, expiresAt - Date.now());
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const mins = totalMinutes % 60;

  return days > 0 ? `${days} ngày ${hours} giờ` : `${hours} giờ ${mins} phút`;
}

// ============================================================================
// ACCOUNT (gói dịch vụ, đổi mật khẩu, đăng xuất)
// ============================================================================
function renderAccount() {
  const me = state.me;
  if (!me) return;
  const quota = me.maxSlots === null ? `${me.slotCount} tab` : `${me.slotCount}/${me.maxSlots} tab`;
  const expires = me.planExpiresAt
    ? `${new Date(me.planExpiresAt).toLocaleString('vi-VN')} (còn ${formatRemaining(me.planExpiresAt)})`
    : 'Không giới hạn';

  document.getElementById('accountUsername').textContent = me.username;
  document.getElementById('accountPlanPill').textContent = `${me.planLabel} · ${quota}`;
  document.getElementById('accUsername').textContent = me.username;
  document.getElementById('accPlan').textContent = me.planLabel;
  document.getElementById('accSlots').textContent = `${quota}, đang chạy ${me.runningCount}`;
  document.getElementById('accExpires').textContent = expires;
  document.getElementById('btnGoAdmin').classList.toggle('hidden', me.role !== 'admin');

  const infoQuota = document.getElementById('infoPlanQuota');
  if (infoQuota) infoQuota.textContent = `${me.planLabel}: ${quota}. Hết hạn: ${expires}.`;

  const topBalance = document.getElementById('topBalance');
  if (topBalance) topBalance.textContent = formatVnd(me.balance || 0);

  const banner = document.getElementById('planBanner');
  if (banner) {
    banner.classList.toggle('hidden', me.maxSlots !== 0);
    banner.innerHTML = `<strong>Tài khoản chưa có gói dịch vụ</strong> (hoặc gói đã hết hạn) nên chưa thể mở tab treo game.
         <button class="btn-emerald" data-open-billing>💳 Xem bảng giá & mua gói</button>`;
  }

  if (state.billing && !document.getElementById('billingModal').classList.contains('hidden')) {
    loadBilling();
  }
}

function formatVnd(n) {
  return Number(n || 0).toLocaleString('vi-VN') + 'đ';
}

// ============================================================================
// BILLING (ví, mua gói, chuyển khoản VietQR — tiền về qua webhook SePay/Casso)
// ============================================================================
async function loadBilling() {
  try {
    const res = await fetch('/api/billing');
    const data = await res.json();
    state.billing = data;
    if (data.me) state.me = data.me;
    renderBilling();
  } catch (err) {
    showToast('Không tải được thông tin ví: ' + err.message);
  }
}

function hasOtherActivePlan(product) {
  const me = state.me;
  return (
    me.plan !== 'none' && me.plan !== product.plan &&
    (!me.planExpiresAt || me.planExpiresAt > Date.now())
  );
}

function renderBilling() {
  const b = state.billing;
  const me = state.me;
  if (!b || !me) return;

  document.getElementById('billBalance').textContent = formatVnd(me.balance);
  document.getElementById('billPlan').textContent = me.planLabel;
  document.getElementById('billExpiry').textContent = me.planExpiresAt
    ? `hết hạn ${new Date(me.planExpiresAt).toLocaleString('vi-VN')}`
    : '';
  document.getElementById('topBalance').textContent = formatVnd(me.balance);

  const disabled = document.getElementById('billDisabled');
  disabled.classList.toggle('hidden', b.enabled);
  disabled.textContent = `Chưa bật nạp tiền tự động. ${b.contact || ''}`;

  document.getElementById('billProducts').innerHTML = b.products
    .map((p) => {
      const slots = p.maxSlots === null ? 'Không giới hạn tab' : `${p.maxSlots} tab chạy cùng lúc`;
      return `
      <button class="billing-product ${me.pendingProduct === p.id ? 'selected' : ''}" data-product="${escapeHtml(p.id)}" ${b.enabled ? '' : 'disabled'}>
        <span class="bp-name">${escapeHtml(p.planLabel)} · ${p.days} ngày</span>
        <span class="bp-meta">${slots}</span>
        <span class="bp-price">${formatVnd(p.price)}</span>
      </button>`;
    })
    .join('');

  const renewSel = document.getElementById('billAutoRenew');
  renewSel.innerHTML =
    '<option value="">Tắt</option>' +
    b.products
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.planLabel)} · ${p.days} ngày · ${formatVnd(p.price)}</option>`)
      .join('');
  renewSel.value = me.autoRenew || '';

  const pending = b.products.find((p) => p.id === me.pendingProduct);
  const missingForPending = pending ? pending.price - me.balance : 0;
  if (pending && missingForPending > 0) {
    const missing = missingForPending;
    showPayBox(missing, `2. Chuyển khoản ${formatVnd(missing)} để mua ${pending.planLabel} ${pending.days} ngày`, true);
  } else if (state.billingTopupOpen) {
    showPayBox(0, '2. Nạp tiền vào ví (nhập số tiền tùy ý trong app ngân hàng)', false);
  } else {
    document.getElementById('billPayBox').classList.add('hidden');
  }

  const reasonLabel = { topup: 'Nạp tiền', purchase: 'Mua gói', admin: 'Admin điều chỉnh' };
  const ledger = document.getElementById('billLedger');
  ledger.innerHTML = b.ledger.length
    ? b.ledger
        .map(
          (l) => `
      <div class="bl-row">
        <span>${new Date(l.createdAt).toLocaleString('vi-VN')} · ${escapeHtml(reasonLabel[l.reason] || l.reason)}
          <span class="muted-text">${escapeHtml(l.note || '')}</span></span>
        <span class="${l.delta > 0 ? 'bl-plus' : 'bl-minus'}">${l.delta > 0 ? '+' : ''}${formatVnd(l.delta)}</span>
      </div>`
        )
        .join('')
    : '<div class="muted-text">Chưa có giao dịch nào.</div>';
}

function showPayBox(amount, title, isPending) {
  const b = state.billing;
  if (!b.enabled) return;
  const params = new URLSearchParams({ addInfo: b.payCode, accountName: b.bank.accountName });
  if (amount > 0) params.set('amount', String(amount));
  document.getElementById('billQr').src =
    `https://img.vietqr.io/image/${encodeURIComponent(b.bank.id)}-${encodeURIComponent(b.bank.accountNo)}-compact2.png?${params}`;
  document.getElementById('billPayTitle').textContent = title;
  document.getElementById('billBank').textContent = b.bank.id;
  document.getElementById('billAccNo').textContent = b.bank.accountNo;
  document.getElementById('billAccName').textContent = b.bank.accountName || '--';
  document.getElementById('billAmount').textContent = amount > 0 ? String(amount) : 'Tùy ý';
  document.getElementById('billCode').textContent = b.payCode;
  document.getElementById('billCancelPending').classList.toggle('hidden', !isPending);
  document.getElementById('billHint').innerHTML =
    'Quét mã QR bằng app ngân hàng, giữ nguyên <strong>nội dung chuyển khoản</strong>. Tiền về ví sau khoảng 10–60 giây' +
    (isPending ? ', gói sẽ được kích hoạt tự động.' : '.');
  document.getElementById('billPayBox').classList.remove('hidden');
}

async function buyProduct(product) {
  const me = state.me;
  const replace = hasOtherActivePlan(product);
  if (replace && !confirm(`Bạn đang dùng gói ${me.planLabel}. Mua ${product.planLabel} sẽ THAY THẾ gói hiện tại, thời hạn còn lại không được cộng dồn. Tiếp tục?`)) {
    return;
  }

  if (me.balance >= product.price) {
    if (!confirm(`Mua ${product.planLabel} ${product.days} ngày với giá ${formatVnd(product.price)} (trừ vào ví)?`)) return;
    const res = await fetch('/api/billing/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: product.id, confirmReplace: replace })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.error || 'Mua gói thất bại');
      return;
    }
    state.me = data.me;
    renderAccount();
    await loadBilling();
    return;
  }

  // Chưa đủ tiền: ghi nhớ gói đã chọn, server tự mua khi tiền chuyển khoản về
  const res = await fetch('/api/billing/pending', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId: product.id })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(data.error || 'Không chọn được gói');
    return;
  }
  state.me = data.me;
  state.billingTopupOpen = false;
  renderBilling();
}

function initBillingModal() {
  const modal = document.getElementById('billingModal');
  const open = async () => {
    modal.classList.remove('hidden');
    await loadBilling();
  };
  document.getElementById('btnOpenBillingModal').addEventListener('click', open);
  document.getElementById('planBanner').addEventListener('click', (e) => {
    if (e.target.closest('[data-open-billing]')) open();
  });
  document.getElementById('btnCloseBillingModal').addEventListener('click', () => modal.classList.add('hidden'));

  document.getElementById('billProducts').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-product]');
    const product = state.billing?.products.find((p) => p.id === btn?.dataset.product);
    if (product) buyProduct(product);
  });

  document.getElementById('billShowTopup').addEventListener('click', async () => {
    state.billingTopupOpen = true;
    if (state.me?.pendingProduct) {
      await fetch('/api/billing/pending', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: null })
      });
    }
    await loadBilling();
  });

  document.getElementById('billAutoRenew').addEventListener('change', async (e) => {
    const productId = e.target.value || null;
    const res = await fetch('/api/billing/auto-renew', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.error || 'Không lưu được');
      return;
    }
    state.me = data.me;
    showToast(productId ? '🔁 Đã bật tự gia hạn. Nhớ giữ đủ tiền trong ví nhé!' : 'Đã tắt tự gia hạn');
  });

  document.getElementById('billCancelPending').addEventListener('click', async () => {
    await fetch('/api/billing/pending', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: null })
    });
    await loadBilling();
  });

  modal.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const text = document.getElementById(btn.dataset.copy).textContent;
    try {
      await navigator.clipboard.writeText(text);
      showToast(`Đã chép: ${text}`);
    } catch (err) {
      showToast('Không chép được, hãy bôi đen để chép tay');
    }
  });
}

function initAccountModal() {
  const modal = document.getElementById('accountModal');
  document.getElementById('btnOpenAccountModal').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/me');
      const data = await res.json();
      if (data.me) {
        state.me = data.me;
        renderAccount();
      }
    } catch (e) {}
    modal.classList.remove('hidden');
  });
  document.getElementById('btnCloseAccountModal').addEventListener('click', () =>
    modal.classList.add('hidden')
  );

  document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentPassword = document.getElementById('pwCurrent').value;
    const newPassword = document.getElementById('pwNew').value;
    const res = await fetch('/api/me/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.error || 'Không đổi được mật khẩu');
      return;
    }
    e.target.reset();
    showToast('Đã đổi mật khẩu. Các thiết bị khác đã bị đăng xuất.');
  });

  document.getElementById('btnLogout').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    location.replace('/login.html');
  });
}

// ============================================================================
// INSPECTOR PANEL ACTIONS & SUB-TABS
// ============================================================================
function initInspectorControls() {
  document.getElementById('btnCloseInspector').addEventListener('click', () => {
    state.inspectorOpen = false;
    updateInspectorVisibility();
  });

  document.getElementById('btnToggleInspector').addEventListener('click', () => {
    state.inspectorOpen = !state.inspectorOpen;
    updateInspectorVisibility();
  });

  document.querySelectorAll('.insp-tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      switchInspectorTab(tabBtn.dataset.insptab);
    });
  });

  document.getElementById('inspBtnTogglePower').addEventListener('click', () => {
    toggleSlotPower(state.focusedSlotId, 'toggle');
  });

  document.getElementById('inspBtnRestart').addEventListener('click', () => {
    toggleSlotPower(state.focusedSlotId, 'restart');
  });

  document.getElementById('inspBtnRename').addEventListener('click', async () => {
    const slot = state.slots.find((s) => s.id === state.focusedSlotId);
    if (!slot) return;
    const newName = prompt('Nhập tên mới cho tab máy treo này:', slot.name || slot.id);
    if (newName && newName.trim()) {
      await patchSlot(slot.id, { name: newName.trim() });
      showToast(`Đã đổi tên thành "${newName.trim()}"`);
    }
  });

  document.getElementById('inspBtnDeleteSlot').addEventListener('click', () => {
    handleDeleteSlot(state.focusedSlotId);
  });

  // Send Text to Focused Slot (or all synced slots if Sync is ON)
  const sendTextFn = () => {
    const inp = document.getElementById('sendTextInput');
    const text = inp.value;
    if (!text) return;
    dispatchInputToTargets(state.focusedSlotId, (tid) => ({
      type: 'TEXT',
      slotId: tid,
      text
    }));
    recordStepIfActive(state.focusedSlotId, { action: 'TEXT', text });
    inp.value = '';
    showToast(
      state.syncAllMode
        ? `🔗 Đã gửi văn bản vào tất cả các tab đồng bộ!`
        : `Đã gửi văn bản vào ${state.focusedSlotId}`
    );
  };
  document.getElementById('btnSendText').addEventListener('click', sendTextFn);
  document.getElementById('sendTextInput').addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') sendTextFn();
  });

  // Macro Recorder Controls
  document.getElementById('btnStartRecord').addEventListener('click', startMacroRecording);
  document.getElementById('btnCancelRecording').addEventListener('click', stopMacroRecordingUI);
  document.getElementById('btnSaveRecording').addEventListener('click', saveRecordedMacro);
  document.getElementById('btnStopMacro').addEventListener('click', async () => {
    await fetch(`/api/slots/${state.focusedSlotId}/macros/stop`, { method: 'POST' });
  });

  document.getElementById('btnSaveAutomation').addEventListener('click', async () => {
    await saveAutomationForFocusedSlot();
    showToast(`Đã lưu cấu hình tự động cho ${state.focusedSlotId}`);
  });

  // Upload .JAR in Inspector
  const dropzone = document.getElementById('uploadDropzone');
  const jarInput = document.getElementById('jarUploadInput');
  dropzone.addEventListener('click', () => jarInput.click());
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = e.dataTransfer?.files?.[0];
    if (file) await uploadJarToSlot(state.focusedSlotId, file);
  });
  jarInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file) {
      await uploadJarToSlot(state.focusedSlotId, file);
      jarInput.value = '';
    }
  });

  document.getElementById('btnApplyPreset').addEventListener('click', async () => {
    const presetId = document.getElementById('presetSelect').value;
    if (!presetId) return;
    await applyPresetToSlot(state.focusedSlotId, presetId);
  });

  document.querySelectorAll('.res-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.getElementById('inpWidth').value = chip.dataset.w;
      document.getElementById('inpHeight').value = chip.dataset.h;
    });
  });

  document.getElementById('btnApplyScreen').addEventListener('click', async () => {
    const width = Number(document.getElementById('inpWidth').value) || 240;
    const height = Number(document.getElementById('inpHeight').value) || 320;
    const fps = Number(document.getElementById('inpFps').value) || 12;
    const res = await fetch(`/api/slots/${state.focusedSlotId}/screen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ width, height, fps })
    });
    const data = await res.json();
    if (data.slot) {
      upsertSlotState(data.slot);
      showToast(`Đã cập nhật màn hình ${width}×${height} @ ${fps}FPS`);
    }
  });

  document.querySelectorAll('.status-tag-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await patchSlot(state.focusedSlotId, { inGameStatus: btn.dataset.igstatus });
      showToast(`Đã đổi trạng thái: ${btn.dataset.igstatus}`);
    });
  });

}

function switchInspectorTab(tabName) {
  document.querySelectorAll('.insp-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.insptab === tabName);
  });
  document.querySelectorAll('.insp-tab-pane').forEach((p) => {
    p.classList.toggle('active', p.id === `inspPane-${tabName}`);
  });
}

function updateInspectorVisibility() {
  const panel = document.getElementById('inspectorPanel');
  const toggleBtn = document.getElementById('btnToggleInspector');
  panel.classList.toggle('collapsed', !state.inspectorOpen);
  toggleBtn.classList.toggle('active', state.inspectorOpen);

  for (const [id, view] of state.slotViews.entries()) {
    const sBtn = view.card.querySelector('[data-action="open-settings"]');
    if (sBtn) {
      sBtn.classList.toggle('active', id === state.focusedSlotId && state.inspectorOpen);
    }
  }
}

// ============================================================================
// MACRO RECORDING & AUTOMATION (PER TAB)
// ============================================================================
function startMacroRecording() {
  state.recording = true;
  state.recordedSteps = [];
  state.lastRecordTs = Date.now();

  document.getElementById('recordingBanner').classList.remove('hidden');
  document.getElementById('recStepCount').textContent = '0 bước';
  document.getElementById('recMacroName').value = '';
  showToast(`Đang ghi thao tác trên tab ${state.focusedSlotId}. Hãy bấm vào màn hình game!`);
}

function stopMacroRecordingUI() {
  state.recording = false;
  state.recordedSteps = [];
  document.getElementById('recordingBanner').classList.add('hidden');
}

function recordStepIfActive(slotId, stepData) {
  if (!state.recording || slotId !== state.focusedSlotId) return;
  const now = Date.now();
  const delay = Math.max(80, Math.min(now - state.lastRecordTs, 10000));
  state.lastRecordTs = now;

  state.recordedSteps.push({
    ...stepData,
    delay
  });
  document.getElementById('recStepCount').textContent = `${state.recordedSteps.length} bước`;
}

async function saveRecordedMacro() {
  if (state.recordedSteps.length === 0) {
    showToast('Chưa ghi được bước thao tác nào!');
    return;
  }

  const slot = state.slots.find((s) => s.id === state.focusedSlotId);
  if (!slot) return;

  const name =
    document.getElementById('recMacroName').value.trim() ||
    `Kịch bản #${(slot.automation?.macros?.length || 0) + 1}`;
  const type = document.getElementById('recMacroType').value;

  const macros = Array.isArray(slot.automation?.macros) ? [...slot.automation.macros] : [];
  macros.push({
    id: 'm_' + Date.now(),
    name,
    type,
    steps: state.recordedSteps,
    loop: type === 'loop',
    intervalSec: 30
  });

  stopMacroRecordingUI();
  await saveAutomationForFocusedSlot(macros);
  showToast(`Đã lưu kịch bản "${name}" cho tab ${slot.id}`);
}

function renderMacroListForSlot(slot) {
  const listEl = document.getElementById('macroList');
  const badgeEl = document.getElementById('macroCountBadge');
  const macros = slot.automation?.macros || [];
  badgeEl.textContent = `${macros.length} kịch bản`;

  if (macros.length === 0) {
    listEl.innerHTML = `<div style="font-size:11.5px;color:var(--text-muted);text-align:center;padding:8px;">Chưa có kịch bản nào trên tab này.</div>`;
    return;
  }

  listEl.innerHTML = macros
    .map(
      (m) => `
      <div class="macro-item" data-macro-id="${escapeHtml(m.id)}">
        <div class="macro-item-top">
          <div>
            <span class="macro-name">${escapeHtml(m.name)}</span>
            <span style="font-size:10.5px;color:var(--text-secondary);">(${m.steps?.length || 0} bước • ${m.type === 'login' ? 'Đăng nhập' : 'Treo máy'})</span>
          </div>
          <div class="macro-btns">
            <button class="q-btn" data-maction="play">▶ Chạy</button>
            <button class="q-btn" data-maction="delete" style="color:var(--danger);">✕</button>
          </div>
        </div>
        <div class="macro-loop-row">
          <label style="display:flex;align-items:center;gap:5px;cursor:pointer;">
            <input type="checkbox" data-maction="toggle-loop" ${m.loop ? 'checked' : ''} />
            <span>Tự lặp lại mỗi</span>
          </label>
          <input type="number" class="input-field num-sm" data-maction="interval" value="${m.intervalSec || 30}" min="3" max="3600" />
          <span>giây</span>
        </div>
      </div>
    `
    )
    .join('');

  listEl.querySelectorAll('.macro-item').forEach((itemEl) => {
    const macroId = itemEl.dataset.macroId;
    itemEl.querySelector('[data-maction="play"]').addEventListener('click', async () => {
      await fetch(`/api/slots/${slot.id}/macros/${macroId}/play`, { method: 'POST' });
    });

    itemEl.querySelector('[data-maction="delete"]').addEventListener('click', async () => {
      const updated = (slot.automation?.macros || []).filter((m) => m.id !== macroId);
      await saveAutomationForFocusedSlot(updated);
    });

    const loopChk = itemEl.querySelector('[data-maction="toggle-loop"]');
    const intInp = itemEl.querySelector('[data-maction="interval"]');
    const updateLoopCfg = async () => {
      const updated = (slot.automation?.macros || []).map((m) =>
        m.id === macroId
          ? { ...m, loop: loopChk.checked, intervalSec: Math.max(3, Number(intInp.value) || 30) }
          : m
      );
      await saveAutomationForFocusedSlot(updated);
    };
    loopChk.addEventListener('change', updateLoopCfg);
    intInp.addEventListener('change', updateLoopCfg);
  });
}

async function saveAutomationForFocusedSlot(overrideMacros) {
  const slot = state.slots.find((s) => s.id === state.focusedSlotId);
  if (!slot) return;

  const payload = {
    autoLoginEnabled: document.getElementById('chkAutoLogin').checked,
    watchdogEnabled: document.getElementById('chkWatchdog').checked,
    macros: overrideMacros || slot.automation?.macros || [],
    periodicKey: {
      enabled: document.getElementById('chkPeriodicKey').checked,
      keyCode: Number(document.getElementById('selPeriodicKeyCode').value),
      intervalSec: Math.max(1, Number(document.getElementById('inpPeriodicSec').value) || 15)
    },
    scheduledRestart: {
      enabled: document.getElementById('chkScheduledRestart').checked,
      everyHours: Math.max(1, Number(document.getElementById('inpRestartHours').value) || 6)
    }
  };

  const res = await fetch(`/api/slots/${slot.id}/automation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (data.slot) upsertSlotState(data.slot);
}

// ============================================================================
// SLOT API HELPERS
// ============================================================================
async function toggleSlotPower(slotId, action = 'toggle') {
  try {
    const res = await fetch(`/api/slots/${slotId}/power`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Không thể điều khiển tab');
    if (data.slot) upsertSlotState(data.slot);
  } catch (err) {
    showToast(err.message);
  }
}

async function uploadJarToSlot(slotId, file) {
  if (!file.name.toLowerCase().endsWith('.jar')) {
    showToast('Vui lòng chọn file có đuôi .jar!');
    return;
  }

  showToast(`Đang tải "${file.name}" lên tab ${slotId}...`);
  const fd = new FormData();
  fd.append('jarFile', file);

  try {
    const res = await fetch(`/api/slots/${slotId}/upload-jar`, {
      method: 'POST',
      body: fd
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Tải file thất bại');

    if (data.presets) {
      state.presets = data.presets;
      renderPresetsDropdowns();
    }
    if (data.slot) {
      upsertSlotState(data.slot);
    }
    showToast(`Đã nạp thành công "${file.name}" vào tab ${slotId}!`);
  } catch (err) {
    showToast('Lỗi nạp file .jar: ' + err.message);
  }
}

async function applyPresetToSlot(slotId, presetId) {
  try {
    const res = await fetch(`/api/slots/${slotId}/preset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presetId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Không thể đổi game');
    if (data.slot) {
      upsertSlotState(data.slot);
      showToast(`Đã chuyển game cho tab ${slotId}!`);
    }
  } catch (err) {
    showToast(err.message);
  }
}

async function handleDeleteSlot(slotId) {
  const slot = state.slots.find((s) => s.id === slotId);
  if (!confirm(`Bạn có chắc muốn đóng và xóa tab "${slot?.name || slotId}" không?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/slots/${slotId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Không thể xóa tab');
    state.slots = data.slots || [];
    if (!state.slots.some((s) => s.id === state.focusedSlotId)) {
      state.focusedSlotId = state.slots[0]?.id || '';
    }
    renderAllDeviceCards();
    renderSubbarPills();
    updateClusterStats();
    renderInspectorForFocusedSlot();
    showToast(`Đã xóa tab ${slotId}`);
  } catch (err) {
    showToast(err.message);
  }
}

async function patchSlot(slotId, body) {
  const res = await fetch(`/api/slots/${slotId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data.slot) upsertSlotState(data.slot);
}

function renderPresetsDropdowns() {
  const html = state.presets
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`)
    .join('');

  const s1 = document.getElementById('presetSelect');
  const s2 = document.getElementById('newTabPresetSelect');
  if (s1) s1.innerHTML = html;
  if (s2) s2.innerHTML = html;
}

// ============================================================================
// TOPBAR CONTROLS: ECO MODE SWITCH, MULTI-TAB SYNC SWITCH, SHARPNESS & SIZES
// ============================================================================
function initTopbarControls() {
  // 1. Eco Mode Toggle Switch (Persisted in localStorage)
  const ecoBtn = document.getElementById('btnToggleEco');
  const ecoText = document.getElementById('ecoStatusText');

  const syncEcoUI = () => {
    ecoBtn.classList.toggle('active', state.ecoMode);
    ecoText.textContent = state.ecoMode ? 'BẬT' : 'TẮT';
    document.body.classList.toggle('eco-mode-on', state.ecoMode);
  };
  syncEcoUI();

  ecoBtn.addEventListener('click', () => {
    state.ecoMode = !state.ecoMode;
    localStorage.setItem('j2me_eco_mode', String(state.ecoMode));
    syncEcoUI();
    sendWs({
      type: 'focus',
      slotId: state.focusedSlotId,
      ecoMode: state.ecoMode
    });
    showToast(
      state.ecoMode
        ? '⚡ Chế độ Siêu nhẹ: BẬT (Giảm tải các tab phụ & tắt hiệu ứng nặng)'
        : '🔥 Chế độ Siêu nhẹ: TẮT (Mọi tab đều chạy tối đa FPS)'
    );
  });

  // 2. Multi-Tab Sync Toggle Switch ("Đồng bộ đa tab")
  const syncBtn = document.getElementById('btnToggleSync');
  const syncText = document.getElementById('syncStatusText');

  syncBtn.addEventListener('click', () => {
    state.syncAllMode = !state.syncAllMode;
    syncBtn.classList.toggle('active', state.syncAllMode);
    syncText.textContent = state.syncAllMode ? 'BẬT' : 'TẮT';

    for (const [id, view] of state.slotViews.entries()) {
      view.card.classList.toggle('synced-card', state.syncAllMode && state.syncedSlotIds.has(id));
    }

    showToast(
      state.syncAllMode
        ? '🔗 ĐỒNG BỘ ĐA TAB: BẬT! Bấm chuột/phím ở 1 tab sẽ điều khiển tất cả các tab có biểu tượng 🔗'
        : 'Đã tắt Đồng bộ đa tab (Điều khiển từng tab độc lập)'
    );
  });

  // 3. Exact Integer Grid Sizes (Compact / 1:1 Native / Normal / Large / 2x HD)
  document.querySelectorAll('.size-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.size === state.gridSize);
    btn.addEventListener('click', () => {
      state.gridSize = btn.dataset.size;
      localStorage.setItem('j2me_grid_size', state.gridSize);
      document.querySelectorAll('.size-btn').forEach((b) =>
        b.classList.toggle('active', b.dataset.size === state.gridSize)
      );
      document.getElementById('devicesGrid').setAttribute('data-grid-size', state.gridSize);
    });
  });

  // 4. Font Sharpness Mode Selector
  const sharpBtn = document.getElementById('btnCycleSharpness');
  const sharpLabel = document.getElementById('sharpnessLabel');

  const applySharpnessUI = () => {
    const mode = SHARPNESS_MODES[state.sharpnessIdx] || SHARPNESS_MODES[0];
    document.body.setAttribute('data-sharpness', mode.id);
    sharpLabel.textContent = mode.label;
  };
  applySharpnessUI();

  sharpBtn.addEventListener('click', () => {
    state.sharpnessIdx = (state.sharpnessIdx + 1) % SHARPNESS_MODES.length;
    localStorage.setItem('j2me_sharpness_idx', String(state.sharpnessIdx));
    applySharpnessUI();
    const mode = SHARPNESS_MODES[state.sharpnessIdx];
    showToast(`✨ Chế độ chữ trong game: ${mode.label}`);
  });

  // 5. Toggle All Virtual Keypads
  const kpBtn = document.getElementById('btnToggleAllKeypads');
  const kpText = document.getElementById('allKeypadsText');
  kpText.textContent = state.showAllKeypads ? 'Hiện' : 'Ẩn';

  kpBtn.addEventListener('click', () => {
    state.showAllKeypads = !state.showAllKeypads;
    localStorage.setItem('j2me_show_keypads', String(state.showAllKeypads));
    kpText.textContent = state.showAllKeypads ? 'Hiện' : 'Ẩn';
    document.querySelectorAll('[data-role="keypad"]').forEach((el) => {
      el.classList.toggle('hidden', !state.showAllKeypads);
    });
  });
}

// ============================================================================
// LIGHT / DARK THEME & CUSTOM WALLPAPER STUDIO
// ============================================================================
function initThemeAndWallpaper() {
  // Giao diện mới "Đêm tuyết": chuyển 1 lần cho người đang dùng nền mặc định cũ
  if (!localStorage.getItem('j2me_theme_v2')) {
    localStorage.setItem('j2me_theme_v2', '1');
    if ((localStorage.getItem('j2me_bg_preset') || 'cyber-jade') === 'cyber-jade') {
      localStorage.setItem('j2me_bg_preset', 'winter-night');
      localStorage.setItem('j2me_bg_dim', '30');
      localStorage.setItem('j2me_bg_blur', '0');
    }
  }

  const savedTheme = localStorage.getItem('j2me_theme') || 'dark';
  const savedBgPreset = localStorage.getItem('j2me_bg_preset') || 'winter-night';
  const savedCustomBg = localStorage.getItem('j2me_custom_bg') || '';
  const savedDim = localStorage.getItem('j2me_bg_dim') || '30';
  const savedBlur = localStorage.getItem('j2me_bg_blur') || '0';

  const chkSnow = document.getElementById('chkSnow');
  if (chkSnow && window.isSnowEnabled) {
    chkSnow.checked = window.isSnowEnabled();
    chkSnow.addEventListener('change', () => window.setSnowEnabled(chkSnow.checked));
  }

  applyThemeMode(savedTheme);
  applyBgPreset(savedBgPreset);
  if (savedCustomBg) {
    applyCustomWallpaper(savedCustomBg);
  }
  applyOverlaySliders(savedDim, savedBlur);

  document.getElementById('btnThemeSwitch').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    applyThemeMode(next);
    showToast(next === 'light' ? '☀️ Đã chuyển sang Giao diện Sáng' : '🌙 Đã chuyển sang Giao diện Tối');
  });

  document.querySelectorAll('[data-set-theme]').forEach((card) => {
    card.addEventListener('click', () => {
      applyThemeMode(card.dataset.setTheme);
    });
  });

  document.querySelectorAll('[data-bg-preset]').forEach((card) => {
    card.addEventListener('click', () => {
      localStorage.removeItem('j2me_custom_bg');
      document.getElementById('wallpaperLayer').style.backgroundImage = '';
      applyBgPreset(card.dataset.bgPreset);
    });
  });

  document.getElementById('btnApplyCustomBgUrl').addEventListener('click', () => {
    const url = document.getElementById('customBgUrlInput').value.trim();
    if (!url) return;
    applyCustomWallpaper(url);
    showToast('Đã áp dụng hình nền tùy chỉnh!');
  });

  const bgFileInp = document.getElementById('customBgFileInput');
  document.getElementById('btnPickCustomBgFile').addEventListener('click', () => bgFileInp.click());
  bgFileInp.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      applyCustomWallpaper(reader.result);
      showToast('Đã áp dụng ảnh nền từ máy của bạn!');
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('btnClearCustomBg').addEventListener('click', () => {
    localStorage.removeItem('j2me_custom_bg');
    document.getElementById('wallpaperLayer').style.backgroundImage = '';
    document.getElementById('customBgUrlInput').value = '';
    applyBgPreset(localStorage.getItem('j2me_bg_preset') || 'winter-night');
    showToast('Đã khôi phục phông nền mặc định');
  });

  const dimSlider = document.getElementById('bgDimSlider');
  const blurSlider = document.getElementById('bgBlurSlider');
  dimSlider.value = savedDim;
  blurSlider.value = savedBlur;

  const onSliderChange = () => {
    applyOverlaySliders(dimSlider.value, blurSlider.value);
  };
  dimSlider.addEventListener('input', onSliderChange);
  blurSlider.addEventListener('input', onSliderChange);
}

function applyThemeMode(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('j2me_theme', theme);

  const iconEl = document.getElementById('themeSwitchIcon');
  const labelEl = document.getElementById('themeSwitchLabel');
  if (iconEl) iconEl.innerHTML = icon(theme === 'light' ? 'sun' : 'moon');
  if (labelEl) labelEl.textContent = theme === 'light' ? 'Sáng' : 'Tối';

  document.querySelectorAll('[data-set-theme]').forEach((c) => {
    c.classList.toggle('active', c.dataset.setTheme === theme);
  });
}

function applyBgPreset(preset) {
  document.documentElement.setAttribute('data-bg', preset);
  localStorage.setItem('j2me_bg_preset', preset);

  document.querySelectorAll('[data-bg-preset]').forEach((c) => {
    c.classList.toggle('active', c.dataset.bgPreset === preset);
  });
}

function applyCustomWallpaper(urlOrDataUri) {
  const layer = document.getElementById('wallpaperLayer');
  layer.style.backgroundImage = `url("${urlOrDataUri}")`;
  try {
    localStorage.setItem('j2me_custom_bg', urlOrDataUri);
  } catch (e) {}
}

function applyOverlaySliders(dimPercent, blurPx) {
  document.documentElement.style.setProperty('--bg-dim', (Number(dimPercent) / 100).toFixed(2));
  document.documentElement.style.setProperty('--bg-blur', `${blurPx}px`);
  document.getElementById('bgDimVal').textContent = `${dimPercent}%`;
  document.getElementById('bgBlurVal').textContent = `${blurPx}px`;
  localStorage.setItem('j2me_bg_dim', String(dimPercent));
  localStorage.setItem('j2me_bg_blur', String(blurPx));
}

// ============================================================================
// MODALS: NEW TAB, BACKGROUND STUDIO, MANAGE ALL
// ============================================================================
function initModals() {
  const newTabModal = document.getElementById('newTabModal');
  document.getElementById('btnOpenNewTabModal').addEventListener('click', openNewTabModal);
  document.getElementById('btnCloseNewTabModal').addEventListener('click', () =>
    newTabModal.classList.add('hidden')
  );

  document.querySelectorAll('[data-newmode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.newmode;
      document.querySelectorAll('[data-newmode]').forEach((b) =>
        b.classList.toggle('active', b.dataset.newmode === mode)
      );
      document.querySelectorAll('.newtab-mode-pane').forEach((p) =>
        p.classList.toggle('active', p.id === `newTabPane-${mode}`)
      );
    });
  });

  document.getElementById('btnConfirmCreatePresetTab').addEventListener('click', async () => {
    const name = document.getElementById('newTabNameInput').value.trim();
    const presetId = document.getElementById('newTabPresetSelect').value;

    const res = await fetch('/api/slots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, presetId })
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Lỗi tạo tab mới');
      return;
    }
    if (data.slot) {
      newTabModal.classList.add('hidden');
      document.getElementById('newTabNameInput').value = '';
      selectSlot(data.slot.id, { openInspector: true });
      showToast(`🚀 Đã mở thêm tab mới: ${data.slot.name || data.slot.id}`);
    }
  });

  const newTabDropzone = document.getElementById('newTabDropzone');
  const newTabJarInput = document.getElementById('newTabJarInput');
  const newTabFileLabel = document.getElementById('newTabFileLabel');

  newTabDropzone.addEventListener('click', () => newTabJarInput.click());
  newTabJarInput.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) {
      state.newTabSelectedFile = f;
      newTabFileLabel.innerHTML = `Đã chọn: <strong>${escapeHtml(f.name)}</strong> (${(f.size / 1024).toFixed(1)} KB)`;
    }
  });

  document.getElementById('btnConfirmCreateUploadTab').addEventListener('click', async () => {
    if (!state.newTabSelectedFile) {
      showToast('Vui lòng chọn file .jar trước!');
      return;
    }
    const name = document.getElementById('newTabNameInput').value.trim();
    const fd = new FormData();
    fd.append('jarFile', state.newTabSelectedFile);
    fd.append('name', name);

    showToast(`Đang tải "${state.newTabSelectedFile.name}" và khởi tạo tab mới...`);
    const res = await fetch('/api/slots/create-with-jar', {
      method: 'POST',
      body: fd
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Lỗi tạo tab mới');
      return;
    }

    if (data.presets) {
      state.presets = data.presets;
      renderPresetsDropdowns();
    }
    newTabModal.classList.add('hidden');
    state.newTabSelectedFile = null;
    newTabFileLabel.innerHTML = `Bấm để chọn file <strong>.jar</strong> muốn chạy`;
    document.getElementById('newTabNameInput').value = '';

    if (data.slot) {
      selectSlot(data.slot.id, { openInspector: true });
      showToast(`🎉 Đã mở tab mới ${data.slot.id} với game của bạn!`);
    }
  });

  const bgModal = document.getElementById('bgModal');
  document.getElementById('btnOpenBgModal').addEventListener('click', () =>
    bgModal.classList.remove('hidden')
  );
  document.getElementById('btnCloseBgModal').addEventListener('click', () =>
    bgModal.classList.add('hidden')
  );

  const manageModal = document.getElementById('manageModal');
  document.getElementById('btnOpenManageModal').addEventListener('click', () => {
    renderManageSlotsModal();
    manageModal.classList.remove('hidden');
  });
  document.getElementById('btnCloseManageModal').addEventListener('click', () =>
    manageModal.classList.add('hidden')
  );

  document.getElementById('btnStartAllSlots').addEventListener('click', async () => {
    for (const s of state.slots) {
      if (!s.running) await toggleSlotPower(s.id, 'start');
    }
    renderManageSlotsModal();
    showToast('Đã bật tất cả các tab máy treo!');
  });

  document.getElementById('btnStopAllSlots').addEventListener('click', async () => {
    for (const s of state.slots) {
      if (s.running) await toggleSlotPower(s.id, 'stop');
    }
    renderManageSlotsModal();
    showToast('Đã tắt tất cả các tab máy treo!');
  });
}

function openNewTabModal() {
  document.getElementById('newTabModal').classList.remove('hidden');
}

function renderManageSlotsModal() {
  const listEl = document.getElementById('manageSlotsList');
  listEl.innerHTML = state.slots
    .map(
      (s) => `
      <div class="manage-slot-row">
        <div>
          <strong>${escapeHtml(s.name || s.id)}</strong>
          <span style="font-size:12px;color:var(--text-secondary);margin-left:6px;">
            ${escapeHtml(s.gameInfo?.name || 'Game.jar')} • ${s.running ? '🟢 Đang chạy' : '🔴 Đã tắt'}
          </span>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="q-btn" data-mg-power="${s.id}">${s.running ? '⏹ Tắt' : '▶ Bật'}</button>
          <button class="q-btn" data-mg-focus="${s.id}">⚙ Mở cài đặt</button>
        </div>
      </div>
    `
    )
    .join('');

  listEl.querySelectorAll('[data-mg-power]').forEach((b) => {
    b.addEventListener('click', async () => {
      await toggleSlotPower(b.dataset.mgPower, 'toggle');
      renderManageSlotsModal();
    });
  });

  listEl.querySelectorAll('[data-mg-focus]').forEach((b) => {
    b.addEventListener('click', () => {
      document.getElementById('manageModal').classList.add('hidden');
      selectSlot(b.dataset.mgFocus, { openInspector: true });
    });
  });
}

// ============================================================================
// PHYSICAL KEYBOARD MAPPING (ROUTES TO FOCUSED TAB OR ALL SYNCED TABS)
// ============================================================================
function initGlobalKeyboard() {
  const keyMap = {
    ArrowUp: -1,
    ArrowDown: -2,
    ArrowLeft: -3,
    ArrowRight: -4,
    Enter: -5,
    F1: -6,
    F2: -7,
    '0': 48,
    '1': 49,
    '2': 50,
    '3': 51,
    '4': 52,
    '5': 53,
    '6': 54,
    '7': 55,
    '8': 56,
    '9': 57
  };

  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
      return;
    }
    const code = keyMap[e.key];
    if (code !== undefined) {
      e.preventDefault();
      dispatchInputToTargets(state.focusedSlotId, (tid) => ({
        type: 'KEY_DOWN',
        slotId: tid,
        keyCode: code
      }));
      recordStepIfActive(state.focusedSlotId, { action: 'KEY_PRESS', keyCode: code });
    }
  });

  window.addEventListener('keyup', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
      return;
    }
    const code = keyMap[e.key];
    if (code !== undefined) {
      e.preventDefault();
      dispatchInputToTargets(state.focusedSlotId, (tid) => ({
        type: 'KEY_UP',
        slotId: tid,
        keyCode: code
      }));
    }
  });
}

// ============================================================================
// UTILITIES
// ============================================================================
function showToast(msg) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const item = document.createElement('div');
  item.className = 'toast-item';
  item.textContent = msg;
  container.appendChild(item);
  setTimeout(() => {
    item.remove();
  }, 3600);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
