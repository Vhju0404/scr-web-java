#!/usr/bin/env bash
set -e

echo "====================================================="
echo "🚀 CÀI ĐẶT TREO GAME JAVA 24/7 TRÊN VPS (UBUNTU/DEBIAN)"
echo "====================================================="

# 1. Cài đặt Java Headless (không cần card màn hình hay giao diện Desktop)
sudo apt-get update -y
sudo apt-get install -y curl unzip openjdk-8-jre-headless || sudo apt-get install -y default-jre-headless

# 2. Cài đặt Node.js (nếu chưa có)
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# 3. Cài đặt thư viện của dự án và PM2 để treo server 24/7
npm install
sudo npm install -g pm2

# 4. Khởi chạy server với PM2
pm2 delete treo-game-java 2>/dev/null || true
pm2 start server.js --name "treo-game-java"
pm2 save

echo "====================================================="
echo "✅ ĐÃ CHẠY XONG! Mở trình duyệt truy cập: http://<IP-VPS-CỦA-BẠN>:3000"
echo "💡 Xem log: pm2 logs treo-game-java | Tắt: pm2 stop treo-game-java"
echo "====================================================="
