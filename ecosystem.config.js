// Cấu hình PM2: pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [
    {
      name: 'treo-game-java',
      script: 'server.js',
      node_args: '--env-file-if-exists=.env',
      // Mỗi tab là một tiến trình java con; chỉ chạy 1 bản Node để không trùng slot
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '1G',
      kill_timeout: 10000,
      time: true
    }
  ]
};
