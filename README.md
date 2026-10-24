# Treo Game Java

Web cho thuê treo game J2ME 24/7. Cần Node.js >= 22.9 và Java 8+.

## Chạy thử trên máy
```
npm install
npm start
```
Mở http://localhost:3000. Cấu hình bằng file `.env` (chép từ `.env.example`), không bắt buộc khi chạy thử.

## Đưa lên VPS (Ubuntu/Debian)
1. Trỏ bản ghi A của tên miền về IP VPS.
2. Chép thư mục dự án lên VPS rồi chạy: `sudo bash deploy-vps.sh ten-mien.com`

Script cài Java, Node 22, PM2 (tự bật lại khi reboot), Caddy (HTTPS tự động), tường lửa (chỉ mở 22/80/443),
tạo `.env` với mật khẩu admin ngẫu nhiên. Sửa `.env` rồi `pm2 restart treo-game-java` để áp dụng.

## Tài khoản & gói
- Admin tạo ở lần chạy đầu từ `ACCESS_USER` / `ACCESS_PASSWORD` (hoặc mật khẩu tự sinh trong `data/access.txt`).
- Khách tự đăng ký (`ALLOW_REGISTER`), tài khoản mới **chưa có gói** nên chưa mở được tab.
  Admin cấp gói + số ngày ở `/admin.html`. Gói hết hạn tự tắt mọi tab của khách.
- Gói khai báo trong `db.js` (`PLANS`): `basic` 3 tab, `vip` 10 tab, `unlimited` (admin).
- `CONTACT_INFO`: thông tin liên hệ mua gói, hiện cho khách chưa có gói.

## Nạp tiền tự động (VietQR + SePay / Casso)
1. Điền `BANK_ID`, `BANK_ACCOUNT_NO`, `BANK_ACCOUNT_NAME` trong `.env` → nút 💳 hiện cho khách.
2. Kết nối tài khoản ngân hàng với **SePay** hoặc **Casso**, tạo webhook:
   - SePay: URL `https://ten-mien/webhooks/sepay`, xác thực **API Key**, dán key vào `SEPAY_API_KEY`.
   - Casso: URL `https://ten-mien/webhooks/casso`, dán khóa bảo mật vào `CASSO_CHECKSUM_KEY`
     (webhook kiểu cũ: `CASSO_SECURE_TOKEN`). Bấm "Test webhook" bên Casso để kiểm tra chữ ký.
3. `pm2 restart treo-game-java`.

Luồng: khách chọn gói → web hiện mã VietQR đúng số tiền còn thiếu, nội dung là mã nạp riêng (vd. `TREO7K3QX9`)
→ tiền về, webhook cộng ví → tự mua gói đã chọn. Mua cùng gói thì cộng dồn ngày; đổi gói khác thì thay thế.
Mỗi giao dịch chỉ cộng 1 lần. Khách ghi sai nội dung → giao dịch "Chưa khớp" ở `/admin.html`, bấm "Gán cho user".
Admin cộng/trừ ví thủ công bằng nút "± Ví". Bảng giá: `pricing.js` hoặc `data/pricing.json`.

## An toàn
- **Chỉ admin được tải file `.jar`** (file jar là code Java chạy thẳng trên máy chủ).
  Chỉ bật `ALLOW_USER_UPLOAD=true` khi mỗi slot đã chạy trong sandbox riêng.
- `MAX_TOTAL_RUNNING`: tổng số tab chạy cùng lúc trên máy chủ (mặc định tự tính theo RAM, ~160MB/tab).
- Dữ liệu slot (gồm macro có mật khẩu acc game) được mã hóa AES-256-GCM bằng `SECRET_KEY`
  hoặc `data/secret.key`. **Mất khóa = mất dữ liệu slot.**

## Sao lưu
Server tự sao lưu mỗi ngày vào `data/backups/<ngày>/` (DB, khóa mã hóa, RMS, game tải lên), giữ `BACKUP_KEEP_DAYS` ngày.
Nên chép thư mục này ra máy khác / cloud định kỳ. Khôi phục: dừng server, chép `app.db`, `secret.key`, `slots/`, `user_games/` về `data/`.

## Emulator & tốc độ hình
- Source emulator (FreeJ2ME headless) nằm ở `emulator-src/`. Sửa `HeadlessRunner.java` rồi chạy
  `bash tools/build-emulator.sh` để cập nhật `emulator/freej2me-headless.jar` (bản cũ: `.jar.bak`).
- Game luôn chạy đủ tốc độ của nó; chỉ tốc độ **stream hình** thay đổi theo người xem:
  tab đang chọn = FPS của tab (mặc định 20, chỉnh trong "File .JAR & Màn hình"),
  tab nền trong lưới = 4 FPS, tab "Ẩn hình" / không ai mở web = 0 (không tốn CPU mã hóa hình).

## Vá game
`presets/NgocRongOnline-2.5.0.jar` đã vá lỗi đơ khi bấm "Cấu hình" (bản gốc: `.jar.orig`).
Công cụ vá: `tools/PatchNroConfigMenu.java`.

## Dừng
Ctrl+C khi chạy tay, hoặc `pm2 stop treo-game-java`. Tránh `taskkill /IM java.exe` (tắt mọi chương trình Java trên máy).
