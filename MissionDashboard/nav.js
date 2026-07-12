/*
  NeoLabs Mission Dashboard — in-page view router.
  Replaces the old iframe shell so the dashboard, finder, and camera share one
  document (and therefore one BLE connection). Old /finder.html and /camera.html
  URLs still resolve to the right view.
*/
(function () {
  'use strict';

  const VIEWS = ['dashboard', 'finder', 'camera'];
  const PATH_TO_VIEW = { '/finder.html': 'finder', '/camera.html': 'camera', '/': 'dashboard', '/index.html': 'dashboard' };
  const VIEW_TO_PATH = { dashboard: '/', finder: '/finder.html', camera: '/camera.html' };

  function viewFromLocation() {
    if (location.hash) {
      const h = location.hash.replace('#', '');
      if (VIEWS.includes(h)) return h;
    }
    return PATH_TO_VIEW[location.pathname] || 'dashboard';
  }

  let current = null;

  function show(view, push) {
    if (!VIEWS.includes(view)) view = 'dashboard';
    if (view === current) return;
    const prev = current;
    current = view;

    VIEWS.forEach(v => {
      const sec = document.getElementById('view-' + v);
      if (sec) {
        sec.classList.toggle('active', v === view);
        // Reveal immediately on activation — the scroll-reveal observer only
        // fires once layout settles, which can leave a freshly shown view
        // (display:none at load) invisible for a beat.
        if (v === view) sec.classList.add('fx-in');
      }
    });
    document.querySelectorAll('.top-nav a').forEach(a => {
      a.classList.toggle('active', a.dataset.view === view);
    });

    if (push) {
      try { history.pushState({ view }, '', VIEW_TO_PATH[view]); } catch (_) {}
    }

    if (prev === 'camera' && window.CameraApp?.onHide) window.CameraApp.onHide();
    if (view === 'finder' && window.FinderApp?.onShow) window.FinderApp.onShow();
    if (view === 'camera' && window.CameraApp?.onShow) window.CameraApp.onShow();

    window.scrollTo(0, 0);
  }

  function bind() {
    document.querySelectorAll('.top-nav a').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        show(a.dataset.view, true);
      });
    });

    window.addEventListener('popstate', () => show(viewFromLocation(), false));

    // Launch Console openers (header + per-view buttons)
    ['hdr-launch', 'open-launch-dashboard', 'open-launch-camera'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', () => window.NeoLaunch?.open());
    });

    // Normalise the initial URL so the active view matches the address bar.
    const initial = viewFromLocation();
    current = null;
    show(initial, false);
    try { history.replaceState({ view: initial }, '', VIEW_TO_PATH[initial]); } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
