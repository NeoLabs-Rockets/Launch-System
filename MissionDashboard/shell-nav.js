let shellNavInitDone = false;

function initShellNavigation() {
  if (shellNavInitDone) return;
  shellNavInitDone = true;
  const nav = document.querySelector('.top-nav');
  const main = document.querySelector('main');
  if (!nav || !main) {
    shellNavInitDone = false;
    return;
  }

  const shell = document.createElement('section');
  shell.className = 'shell-view';
  shell.innerHTML = '<iframe class="shell-frame" title="Mission tool"></iframe>';
  main.appendChild(shell);
  const frame = shell.querySelector('iframe');

  nav.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (!link) return;
    const url = new URL(link.href, location.href);
    if (!['/finder.html', '/camera.html', '/'].includes(url.pathname)) return;
    event.preventDefault();
    if (url.pathname === '/') showDashboard(true);
    else showTool(url.pathname, true);
  });

  window.addEventListener('popstate', () => {
    if (location.pathname === '/finder.html' || location.pathname === '/camera.html') showTool(location.pathname, false);
    else showDashboard(false);
  });

  frame.addEventListener('load', () => {
    try {
      frame.contentDocument.body.classList.add('embedded-tool');
      frame.contentDocument.querySelectorAll('.top-nav a').forEach(a => {
        a.addEventListener('click', event => {
          const url = new URL(a.href, location.href);
          if (!['/finder.html', '/camera.html', '/'].includes(url.pathname)) return;
          event.preventDefault();
          if (url.pathname === '/') showDashboard(true);
          else showTool(url.pathname, true);
        });
      });
    } catch (_) {}
  });

  function showTool(path, push) {
    document.body.classList.add('shell-tool-open');
    if (frame.getAttribute('src') !== path) frame.src = path;
    setActive(path);
    if (push) history.pushState({}, '', path);
  }

  function showDashboard(push) {
    document.body.classList.remove('shell-tool-open');
    setActive('/');
    if (push) history.pushState({}, '', '/');
  }

  function setActive(path) {
    nav.querySelectorAll('a').forEach(a => {
      const url = new URL(a.href, location.href);
      a.classList.toggle('active', url.pathname === path);
    });
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initShellNavigation);
} else {
  initShellNavigation();
}
window.addEventListener('load', initShellNavigation);
setTimeout(initShellNavigation, 0);
