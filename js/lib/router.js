export function createRouter({ render, windowObj = window }) {
  function pathFrom(urlPath) {
    const path = urlPath.replace(/\/$/, '') || '/';
    const order = path.match(/^\/order\/([^/]+)$/);
    if (path === '/') return { name: 'menu' };
    if (path === '/cart') return { name: 'cart' };
    if (path === '/checkout') return { name: 'checkout' };
    if (order) return { name: 'order', id: decodeURIComponent(order[1]) };
    return { name: 'notfound' };
  }

  function current() {
    return pathFrom(windowObj.location.pathname);
  }

  function go(path, { replace = false } = {}) {
    if (replace) windowObj.history.replaceState({}, '', path);
    else windowObj.history.pushState({}, '', path);
    render(pathFrom(windowObj.location.pathname));
  }

  function start() {
    try {
      const redirect = windowObj.sessionStorage?.getItem('redirect');
      if (redirect) {
        windowObj.sessionStorage.removeItem('redirect');
        windowObj.history.replaceState({}, '', redirect);
      }
    } catch {
      /* ignore */
    }
    windowObj.addEventListener('popstate', () => render(current()));
    windowObj.document.addEventListener('click', (event) => {
      const link = event.target.closest?.('a[data-link]');
      if (!link) return;
      const href = link.getAttribute('href');
      if (!href || href.startsWith('http') || href.startsWith('tel:')) return;
      event.preventDefault();
      go(href);
    });
    render(current());
  }

  return { go, current, pathFrom, start };
}
