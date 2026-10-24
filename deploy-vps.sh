#!/usr/bin/env bash
# Cài đặt bản chạy thật trên VPS Ubuntu/Debian, có HTTPS tự động.
# Dùng: sudo bash deploy-vps.sh ten-mien-cua-ban.com
# (Trỏ bản ghi A của tên miền về IP VPS trước khi chạy để Caddy lấy được chứng chỉ HTTPS.)
set -e

DOMAIN="$1"
if [ -z "$DOMAIN" ]; then
  echo "Dùng: sudo bash deploy-vps.sh ten-mien-cua-ban.com"
  exit 1
fi

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_USER="${SUDO_USER:-$(whoami)}"
cd "$APP_DIR"

echo "====================================================="
echo "🚀 CÀI ĐẶT TREO GAME JAVA — $DOMAIN"
echo "====================================================="

# 1. Java headless + công cụ cơ bản
apt-get update -y
apt-get install -y curl unzip debian-keyring debian-archive-keyring apt-transport-https ufw
apt-get install -y openjdk-8-jre-headless || apt-get install -y default-jre-headless

# 2. Node.js >= 22 (cần node:sqlite và --env-file-if-exists)
if ! command -v node &> /dev/null || [ "$(node -p "process.versions.node.split('.')[0]")" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# 3. Caddy (reverse proxy + HTTPS Let's Encrypt tự động)
if ! command -v caddy &> /dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000
}
EOF
systemctl reload caddy || systemctl restart caddy

# 4. File cấu hình .env (giữ nguyên nếu đã có)
if [ ! -f .env ]; then
  cp .env.example .env
  ADMIN_PW="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 16)"
  sed -i "s#^ACCESS_PASSWORD=.*#ACCESS_PASSWORD=$ADMIN_PW#" .env
  chmod 600 .env
  echo "🔑 Mật khẩu admin lần đầu: $ADMIN_PW (đã ghi trong .env, đổi ngay sau khi đăng nhập)"
fi
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

# 5. Thư viện + PM2 chạy 24/7, tự bật lại khi VPS khởi động lại
sudo -u "$APP_USER" npm ci --omit=dev || sudo -u "$APP_USER" npm install --omit=dev
npm install -g pm2
sudo -u "$APP_USER" pm2 delete treo-game-java 2>/dev/null || true
sudo -u "$APP_USER" pm2 start ecosystem.config.js
sudo -u "$APP_USER" pm2 save
pm2 startup systemd -u "$APP_USER" --hp "$(eval echo ~"$APP_USER")" | tail -1 | bash || true

# 6. Tường lửa: chỉ mở SSH + HTTP/HTTPS (cổng 3000 không lộ ra ngoài)
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "====================================================="
echo "✅ XONG! Truy cập: https://$DOMAIN"
echo "💡 Log: pm2 logs treo-game-java | Khởi động lại: pm2 restart treo-game-java"
echo "💾 Sao lưu tự động hằng ngày ở $APP_DIR/data/backups — nên chép thêm ra nơi khác"
echo "====================================================="
