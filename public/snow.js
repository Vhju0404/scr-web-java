/**
 * Tuyết rơi nhẹ phía sau nội dung (canvas #snowCanvas, z-index -1, không đè màn hình game).
 * - Tối đa ~90 bông, vẽ 30 khung/giây, tự dừng khi trang bị ẩn.
 * - Tắt nếu máy bật "giảm chuyển động" hoặc người dùng tắt (localStorage j2me_snow = 'off').
 * - window.setSnowEnabled(bool) để bật/tắt từ giao diện.
 */
(function () {
  const STORAGE_KEY = 'j2me_snow';
  const FRAME_MS = 1000 / 30;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let canvas = null;
  let ctx = null;
  let flakes = [];
  let width = 0;
  let height = 0;
  let rafId = 0;
  let lastFrame = 0;
  let windPhase = 0;

  function userEnabled() {
    try {
      return localStorage.getItem(STORAGE_KEY) !== 'off';
    } catch (e) {
      return true;
    }
  }

  function shouldRun() {
    return userEnabled() && !reduceMotion.matches && !document.hidden;
  }

  function targetCount() {
    return Math.round(Math.min(90, Math.max(25, (width * height) / 16000)));
  }

  function makeFlake(anywhere) {
    const depth = Math.random(); // 0 = xa (nhỏ, chậm, mờ), 1 = gần
    return {
      x: Math.random() * width,
      y: anywhere ? Math.random() * height : -6,
      r: 0.7 + depth * 2.3,
      speed: 0.35 + depth * 1.1,
      sway: Math.random() * Math.PI * 2,
      swaySpeed: 0.006 + Math.random() * 0.012,
      alpha: 0.25 + depth * 0.6
    };
  }

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width;
    canvas.height = height;
    const n = targetCount();
    while (flakes.length < n) flakes.push(makeFlake(true));
    flakes.length = n;
  }

  function draw(now) {
    rafId = requestAnimationFrame(draw);
    if (now - lastFrame < FRAME_MS) return;
    const dt = Math.min(3, (now - lastFrame) / FRAME_MS);
    lastFrame = now;

    windPhase += 0.002 * dt;
    const wind = Math.sin(windPhase) * 0.35;
    const light = document.documentElement.dataset.theme === 'light';
    const rgb = light ? '120, 150, 200' : '255, 255, 255';

    ctx.clearRect(0, 0, width, height);
    for (const f of flakes) {
      f.sway += f.swaySpeed * dt;
      f.y += f.speed * dt;
      f.x += (Math.sin(f.sway) * 0.4 + wind) * dt;
      if (f.y > height + 6 || f.x < -10 || f.x > width + 10) {
        Object.assign(f, makeFlake(false), { x: Math.random() * width });
      }
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${rgb}, ${f.alpha})`;
      ctx.fill();
    }
  }

  function start() {
    if (rafId || !canvas) return;
    canvas.style.display = '';
    lastFrame = performance.now();
    rafId = requestAnimationFrame(draw);
  }

  function stop(hide) {
    cancelAnimationFrame(rafId);
    rafId = 0;
    if (hide && canvas) {
      ctx.clearRect(0, 0, width, height);
      canvas.style.display = 'none';
    }
  }

  function sync() {
    if (shouldRun()) start();
    else stop(!userEnabled() || reduceMotion.matches);
  }

  function init() {
    canvas = document.createElement('canvas');
    canvas.id = 'snowCanvas';
    canvas.setAttribute('aria-hidden', 'true');
    // Ngay sau lớp nền để nằm trên nền nhưng dưới nội dung
    const overlay = document.getElementById('wallpaperOverlay');
    if (overlay) overlay.after(canvas);
    else document.body.prepend(canvas);
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', sync);
    reduceMotion.addEventListener?.('change', sync);
    sync();
  }

  window.setSnowEnabled = function (on) {
    try {
      localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
    } catch (e) {}
    sync();
  };

  window.isSnowEnabled = userEnabled;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
