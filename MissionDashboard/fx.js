/*
  NeoLabs Mission Dashboard — shared visual effects layer.
  Self-contained and defensive: every feature degrades gracefully and honours
  prefers-reduced-motion. Included on the dashboard, finder, and camera pages.
*/
(function () {
  'use strict';

  const reduceMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

  // ── Animated starfield ──────────────────────────────────────────────────
  // A drifting, twinkling star layer with the occasional meteor. Sits behind
  // all content; the static CSS star layer remains as a no-JS fallback.
  function initStarfield() {
    if (reduceMotion) return;
    if (document.getElementById('fx-starfield')) return;
    const canvas = document.createElement('canvas');
    canvas.id = 'fx-starfield';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) { canvas.remove(); return; }

    let stars = [];
    let meteors = [];
    let w = 0, h = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
    let raf = 0;
    let lastMeteor = 0;

    function resize() {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(220, Math.round((w * h) / 9000));
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        z: Math.random() * 0.8 + 0.2,          // depth → size + drift speed
        tw: Math.random() * Math.PI * 2,        // twinkle phase
        sp: Math.random() * 0.6 + 0.2           // twinkle speed
      }));
    }

    function spawnMeteor() {
      const fromLeft = Math.random() > 0.5;
      meteors.push({
        x: fromLeft ? -40 : w + 40,
        y: Math.random() * h * 0.5,
        vx: (fromLeft ? 1 : -1) * (5 + Math.random() * 4),
        vy: 2 + Math.random() * 2,
        life: 1
      });
    }

    function frame(t) {
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        s.tw += s.sp * 0.03;
        const a = 0.35 + Math.sin(s.tw) * 0.35 + s.z * 0.2;
        s.x += s.z * 0.04;                       // slow parallax drift
        if (s.x > w + 2) s.x = -2;
        const r = s.z * 1.3;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${200 + s.z * 40 | 0},${225 + s.z * 20 | 0},255,${a.toFixed(3)})`;
        ctx.fill();
      }

      if (t - lastMeteor > 6500 && Math.random() > 0.985) {
        spawnMeteor();
        lastMeteor = t;
      }
      meteors = meteors.filter(m => m.life > 0 && m.x > -60 && m.x < w + 60);
      for (const m of meteors) {
        m.x += m.vx; m.y += m.vy; m.life -= 0.012;
        const tailX = m.x - m.vx * 4;
        const tailY = m.y - m.vy * 4;
        const grad = ctx.createLinearGradient(m.x, m.y, tailX, tailY);
        grad.addColorStop(0, `rgba(159,212,255,${Math.max(0, m.life)})`);
        grad.addColorStop(1, 'rgba(159,212,255,0)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(tailX, tailY);
        ctx.stroke();
      }
      raf = requestAnimationFrame(frame);
    }

    resize();
    window.addEventListener('resize', debounce(resize, 200));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
      else if (!raf) raf = requestAnimationFrame(frame);
    });
    raf = requestAnimationFrame(frame);
  }

  // ── Scroll-reveal entrance ──────────────────────────────────────────────
  // Cards rise and fade in as they enter the viewport, with a small stagger.
  function initReveal() {
    const targets = document.querySelectorAll('main > section, main > .card, main > .grid-2, main > .grid-4, main > .rocket-badge');
    if (!targets.length) return;
    if (reduceMotion || !('IntersectionObserver' in window)) {
      targets.forEach(el => el.classList.add('fx-in'));
      return;
    }
    targets.forEach(el => el.classList.add('fx-reveal'));
    let batch = 0;
    const io = new IntersectionObserver((entries) => {
      const showing = entries.filter(e => e.isIntersecting);
      showing.forEach((entry, i) => {
        const el = entry.target;
        el.style.transitionDelay = Math.min(i * 70, 320) + 'ms';
        el.classList.add('fx-in');
        io.unobserve(el);
      });
      batch++;
    }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
    targets.forEach(el => io.observe(el));
  }

  // ── Number count-up ─────────────────────────────────────────────────────
  // Public helper: animate an element's number from its current value to a new
  // one. Used by render code for hero metrics. Falls back to a direct set.
  const countupState = new WeakMap();
  function countUp(el, to, opts) {
    if (!el) return;
    opts = opts || {};
    const decimals = opts.decimals || 0;
    const suffix = opts.suffix || '';
    const prefix = opts.prefix || '';
    const fmt = v => prefix + v.toFixed(decimals) + suffix;
    if (reduceMotion || !Number.isFinite(to)) {
      el.textContent = Number.isFinite(to) ? fmt(to) : (to == null ? '—' : to);
      return;
    }
    const prev = countupState.get(el);
    const from = Number.isFinite(prev) ? prev : 0;
    if (from === to) { el.textContent = fmt(to); countupState.set(el, to); return; }
    countupState.set(el, to);
    const dur = Math.min(900, 320 + Math.abs(to - from) * 4);
    const start = performance.now();
    const ease = p => 1 - Math.pow(1 - p, 3);
    function step(now) {
      const p = Math.max(0, Math.min(1, (now - start) / dur));
      const v = from + (to - from) * ease(p);
      el.textContent = fmt(v);
      if (p < 1 && countupState.get(el) === to) requestAnimationFrame(step);
      else if (countupState.get(el) === to) el.textContent = fmt(to);
    }
    requestAnimationFrame(step);
  }

  function debounce(fn, ms) {
    let t;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  function start() {
    initStarfield();
    initReveal();
  }

  window.NeoFX = { countUp, reduceMotion };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
