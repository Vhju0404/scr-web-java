/**
 * ADMIN PANEL — thành viên tự nạp tiền / mua gói, admin chỉ xử lý khi cần:
 * giao dịch chuyển sai nội dung, cộng/trừ ví, đặt lại mật khẩu, khóa tài khoản, cài đặt ngân hàng.
 */
const adminState = { users: [], capacity: null, payments: [], search: '' };

document.documentElement.dataset.theme = localStorage.getItem('j2me_theme') || 'dark';

async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined
  });
  if (res.status === 401) {
    location.replace('/login.html');
    throw new Error('Cần đăng nhập');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  return data;
}

async function loadOverview() {
  try {
    const [data, pay] = await Promise.all([api('/api/admin/overview'), api('/api/admin/payments')]);
    Object.assign(adminState, data, { payments: pay.payments });
    render();
  } catch (err) {
    showToast(err.message);
  }
}

function fmtExpiry(ts) {
  if (!ts) return '<span class="muted">--</span>';
  const left = ts - Date.now();
  const days = Math.floor(left / 86400000);
  const hours = Math.floor((left % 86400000) / 3600000);
  return `${new Date(ts).toLocaleDateString('vi-VN')} <span class="muted">(${days > 0 ? days + ' ngày ' : ''}${hours} giờ)</span>`;
}

function render() {
  renderStats();
  renderUnmatched();
  renderUsers();
  renderPayments();
}

function renderStats() {
  const { users, payments } = adminState;
  const paid = users.filter((u) => u.plan !== 'none' && u.role !== 'admin').length;
  const cap = adminState.capacity || { running: 0, max: '?' };
  const since = Date.now() - 30 * 86400000;
  const revenue30 = payments
    .filter((p) => p.status === 'credited' && p.createdAt >= since)
    .reduce((s, p) => s + p.amount, 0);
  document.getElementById('statRow').innerHTML = `
    <div class="stat-pill">👥 ${users.length} thành viên</div>
    <div class="stat-pill">💎 ${paid} đang có gói</div>
    <div class="stat-pill" title="Tổng nạp 30 ngày (trong 100 giao dịch gần nhất)">💰 ${fmtVnd(revenue30)} / 30 ngày</div>
    <div class="stat-pill" title="Tab đang chạy / sức chứa máy chủ (MAX_TOTAL_RUNNING)">🖥 ${cap.running}/${cap.max} tab chạy</div>
  `;
}

function renderUnmatched() {
  const list = adminState.payments.filter((p) => p.status === 'unmatched');
  document.getElementById('unmatchedCard').classList.toggle('hidden', list.length === 0);
  document.getElementById('unmatchedBody').innerHTML = list
    .map(
      (p) => `
      <tr data-payment="${p.id}">
        <td>${new Date(p.createdAt).toLocaleString('vi-VN')}</td>
        <td class="num"><strong>${fmtVnd(p.amount)}</strong></td>
        <td class="wrap">${escapeHtml(p.content)}</td>
        <td><button class="q-btn" data-act="assign">Gán cho user</button></td>
      </tr>`
    )
    .join('');
}

function renderUsers() {
  const q = adminState.search.trim().toLowerCase();
  const users = adminState.users.filter((u) => !q || u.username.toLowerCase().includes(q));
  document.getElementById('userCount').textContent = q ? `(${users.length}/${adminState.users.length})` : '';
  document.getElementById('usersBody').innerHTML = users.length
    ? users
        .map((u) => {
          const quota = u.maxSlots === null ? '∞' : u.maxSlots;
          const isAdmin = u.role === 'admin';
          return `
      <tr data-user="${u.id}">
        <td><strong>${escapeHtml(u.username)}</strong>${isAdmin ? ' <span class="muted">admin</span>' : ''}</td>
        <td><span class="plan-pill">${escapeHtml(u.planLabel)}</span>${u.autoRenew ? ' <span title="Đang bật tự gia hạn">🔁</span>' : ''}</td>
        <td>${fmtExpiry(u.planExpiresAt)}</td>
        <td class="num">${u.runningCount}/${u.slotCount} <span class="muted">(tối đa ${quota})</span></td>
        <td class="num">${fmtVnd(u.balance)}</td>
        <td>${u.disabled ? '<span class="tag-off">Đã khóa</span>' : '<span class="tag-on">Hoạt động</span>'}</td>
        <td>
          <div class="row-actions">
            <button class="q-btn" data-act="balance" title="Cộng/trừ tiền: hoàn tiền, khuyến mãi, chỉnh sai sót">± Ví</button>
            <button class="q-btn" data-act="password" title="Khách quên mật khẩu">🔑 Mật khẩu</button>
            ${isAdmin ? '' : `<button class="q-btn" data-act="toggle-lock">${u.disabled ? '🔓 Mở khóa' : '🔒 Khóa'}</button>`}
          </div>
        </td>
      </tr>`;
        })
        .join('')
    : '<tr><td colspan="7" class="muted">Không có thành viên nào.</td></tr>';
}

function renderPayments() {
  const pays = adminState.payments;
  const unmatched = pays.filter((p) => p.status === 'unmatched').length;
  document.getElementById('paySummary').textContent =
    `(${pays.length} gần nhất${unmatched ? `, ⚠ ${unmatched} chưa khớp` : ''})`;
  document.getElementById('paymentsBody').innerHTML = pays.length
    ? pays
        .map(
          (p) => `
      <tr>
        <td>${new Date(p.createdAt).toLocaleString('vi-VN')}</td>
        <td>${escapeHtml(p.provider)} <span class="muted">#${escapeHtml(p.txnId)}</span></td>
        <td class="num">${fmtVnd(p.amount)}</td>
        <td class="wrap">${escapeHtml(p.content)}</td>
        <td>${p.username ? escapeHtml(p.username) : '<span class="muted">--</span>'}</td>
        <td>${p.status === 'unmatched' ? '<span class="tag-off">Chưa khớp</span>' : '<span class="tag-on">Đã cộng</span>'}</td>
      </tr>`
        )
        .join('')
    : '<tr><td colspan="6" class="muted">Chưa có giao dịch nào.</td></tr>';
}

document.getElementById('userSearch').addEventListener('input', (e) => {
  adminState.search = e.target.value;
  renderUsers();
});

document.getElementById('usersBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  const row = e.target.closest('[data-user]');
  if (!btn || !row) return;
  const id = Number(row.dataset.user);
  const user = adminState.users.find((u) => u.id === id);
  if (!user) return;

  try {
    if (btn.dataset.act === 'balance') {
      const input = prompt(`Cộng (+) hoặc trừ (-) ví của ${user.username}, đơn vị đồng. VD: 50000 hoặc -20000`);
      const delta = Number(String(input || '').replace(/[^\d-]/g, ''));
      if (!delta) return;
      const note = prompt('Ghi chú (hiện trong lịch sử ví của khách):', delta > 0 ? 'Khuyến mãi' : 'Điều chỉnh') || '';
      await api(`/api/admin/users/${id}/balance`, { method: 'POST', body: JSON.stringify({ delta, note }) });
      showToast(`Đã ${delta > 0 ? 'cộng' : 'trừ'} ${fmtVnd(Math.abs(delta))} cho ${user.username}`);
    } else if (btn.dataset.act === 'password') {
      const password = prompt(`Mật khẩu mới cho ${user.username} (≥ 6 ký tự):`);
      if (!password) return;
      await api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ password }) });
      showToast(`Đã đặt lại mật khẩu cho ${user.username}`);
    } else if (btn.dataset.act === 'toggle-lock') {
      if (!user.disabled && !confirm(`Khóa ${user.username}? Mọi tab của họ sẽ bị tắt và bị đăng xuất.`)) return;
      await api(`/api/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ disabled: !user.disabled })
      });
      showToast(user.disabled ? `Đã mở khóa ${user.username}` : `Đã khóa ${user.username}`);
    }
    await loadOverview();
  } catch (err) {
    showToast(err.message);
  }
});

document.getElementById('unmatchedBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act="assign"]');
  const row = e.target.closest('[data-payment]');
  if (!btn || !row) return;
  const p = adminState.payments.find((x) => x.id === Number(row.dataset.payment));
  const username = prompt(`Gán giao dịch ${fmtVnd(p.amount)} ("${p.content}") cho user nào?`);
  if (!username) return;
  try {
    await api(`/api/admin/payments/${p.id}/assign`, { method: 'POST', body: JSON.stringify({ username }) });
    showToast(`Đã cộng ${fmtVnd(p.amount)} cho ${username}`);
    await loadOverview();
  } catch (err) {
    showToast(err.message);
  }
});

document.getElementById('btnRefresh').addEventListener('click', loadOverview);

// ---- Cài đặt thanh toán & liên hệ (tải 1 lần, không nằm trong vòng tự tải lại để không mất chữ đang gõ) ----
const settingsForm = document.getElementById('settingsForm');

async function loadSettings({ autoOpen = false } = {}) {
  try {
    const data = await api('/api/admin/settings');
    for (const [key, value] of Object.entries(data.values)) {
      settingsForm.elements[key].value = value || '';
    }
    for (const [key, isSet] of Object.entries(data.secrets)) {
      const input = settingsForm.elements[key];
      input.value = '';
      input.placeholder = isSet ? '•••••• đã đặt — để trống nếu giữ nguyên' : 'Chưa đặt';
      settingsForm.querySelector(`[data-clear="${key}"]`).classList.toggle('hidden', !isSet);
    }
    document.querySelectorAll('[data-webhook]').forEach((el) => {
      el.textContent = `${location.origin}/webhooks/${el.dataset.webhook}`;
    });
    document.getElementById('billingState').textContent = data.billingEnabled
      ? '— ✅ đang bật nạp tiền'
      : '— ⚠ chưa bật: cần nhập ngân hàng + số tài khoản';
    document.getElementById('payPrefixNote').textContent =
      `Mã nạp của khách có dạng ${data.payPrefix}XXXXXX (đổi tiền tố bằng PAY_PREFIX trong .env).`;
    // Chưa cài ngân hàng thì mở sẵn mục này cho admin điền
    if (autoOpen && !data.billingEnabled) document.getElementById('settingsCard').open = true;
    renderSettingsPreview(data);
  } catch (err) {
    showToast(err.message);
  }
}

function renderSettingsPreview(data) {
  const v = data.values;
  const box = document.getElementById('settingsPreview');
  if (!data.billingEnabled) {
    box.innerHTML = '';
    return;
  }
  const params = new URLSearchParams({ amount: '10000', addInfo: `${data.payPrefix}TEST01`, accountName: v.bank_account_name || '' });
  box.innerHTML = `
    <img alt="QR thử" src="https://img.vietqr.io/image/${encodeURIComponent(v.bank_id)}-${encodeURIComponent(v.bank_account_no)}-compact2.png?${params}" />
    <div>Mã QR thử (10.000đ). Quét bằng app ngân hàng để kiểm tra tên & số tài khoản đúng chưa —<br />
      <strong>đừng chuyển thật</strong> với nội dung ${data.payPrefix}TEST01 (không khớp user nào).</div>`;
}

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  for (const el of settingsForm.elements) {
    if (!el.name) continue;
    // Key bí mật để trống = giữ nguyên
    if (el.type === 'password' && el.value === '') continue;
    body[el.name] = el.value;
  }
  try {
    const res = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(body) });
    showToast(res.billingEnabled ? '✅ Đã lưu — khách đã thấy mã QR nạp tiền' : 'Đã lưu (chưa đủ thông tin ngân hàng để bật nạp tiền)');
    await loadSettings();
  } catch (err) {
    showToast(err.message);
  }
});

settingsForm.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-clear]');
  if (!btn) return;
  if (!confirm('Xóa key này? Webhook tương ứng sẽ ngừng nhận tiền.')) return;
  try {
    await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ [btn.dataset.clear]: '' }) });
    showToast('Đã xóa key');
    await loadSettings();
  } catch (err) {
    showToast(err.message);
  }
});

function showToast(msg) {
  const container = document.getElementById('toastContainer');
  const item = document.createElement('div');
  item.className = 'toast-item';
  item.textContent = msg;
  container.appendChild(item);
  setTimeout(() => item.remove(), 3600);
}

function fmtVnd(n) {
  return Number(n || 0).toLocaleString('vi-VN') + 'đ';
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

loadOverview();
loadSettings({ autoOpen: true });
// Không tự tải lại khi admin đang nhập liệu, tránh mất giá trị đang gõ
setInterval(() => {
  if (!['INPUT', 'SELECT'].includes(document.activeElement?.tagName)) loadOverview();
}, 15000);
