const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Bảng giá các gói bán cho khách (giá VND). plan phải là một id trong PLANS (db.js).
// Muốn đổi giá không cần sửa code: tạo data/pricing.json cùng định dạng mảng này.
// ---------------------------------------------------------------------------
const DEFAULT_PRODUCTS = [
  { id: 'basic-7', plan: 'basic', days: 7, price: 20000 },
  { id: 'basic-30', plan: 'basic', days: 30, price: 60000 },
  { id: 'vip-7', plan: 'vip', days: 7, price: 50000 },
  { id: 'vip-30', plan: 'vip', days: 30, price: 150000 }
];

function loadProducts(dataDir, plans) {
  let list = DEFAULT_PRODUCTS;
  const file = path.join(dataDir, 'pricing.json');
  if (fs.existsSync(file)) {
    try {
      const custom = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(custom)) list = custom;
    } catch (e) {
      console.error('[Billing] data/pricing.json lỗi, dùng bảng giá mặc định:', e.message);
    }
  }
  return list.filter((p) => {
    const ok =
      p && typeof p.id === 'string' && plans[p.plan] && p.plan !== 'none' &&
      Number.isInteger(p.days) && p.days > 0 && Number.isInteger(p.price) && p.price > 0;
    if (!ok) console.error('[Billing] Bỏ qua gói không hợp lệ trong bảng giá:', JSON.stringify(p));
    return ok;
  });
}

module.exports = { loadProducts };
