export function zar(cents) {
  const value = Number(cents || 0) / 100;
  return `R${value.toFixed(2)}`;
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export function createApi() {
  let token = '';
  try { token = sessionStorage.getItem('fc_access') || ''; } catch { /* private mode */ }
  return {
    token,
    async call(pathname, opts = {}) {
      const headers = { ...(opts.headers || {}) };
      if (opts.json !== undefined) headers['content-type'] = 'application/json';
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(pathname, {
        method: opts.method || 'GET',
        headers,
        credentials: 'include',
        body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
      });
      if (res.status === 401 && !opts.retried && !pathname.startsWith('/api/auth/')) {
        const refresh = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
        if (refresh.ok) {
          const data = await refresh.json();
          token = data.accessToken || '';
          try { sessionStorage.setItem('fc_access', token); } catch { /* ignore */ }
          return this.call(pathname, { ...opts, retried: true });
        }
      }
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
      if (!res.ok) {
        const error = new Error(data?.error || 'Something went wrong.');
        error.status = res.status;
        throw error;
      }
      if (data?.accessToken) {
        token = data.accessToken;
        try { sessionStorage.setItem('fc_access', token); } catch { /* ignore */ }
      }
      return data;
    },
    setToken(value) {
      token = value || '';
      try {
        if (token) sessionStorage.setItem('fc_access', token);
        else sessionStorage.removeItem('fc_access');
      } catch { /* ignore */ }
    },
  };
}
