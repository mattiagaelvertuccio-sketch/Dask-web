/* desk UI skeleton — live data is AES-GCM encrypted.
   Path and keys come only from the URL fragment (#p= & #k= & optional #t=)
   and are never written to the repo or to logs. */
(function () {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  const statusEl = document.getElementById('status');
  const payloadEl = document.getElementById('payload');

  function setStatus(t) {
    if (statusEl) statusEl.textContent = t;
  }

  function b64urlToBytes(s) {
    const pad = '===='.slice((s.length % 4) || 4);
    const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function parseFragment() {
    const h = (location.hash || '').replace(/^#/, '');
    const p = new URLSearchParams(h);
    return { path: p.get('p') || '', key: p.get('k') || '', token: p.get('t') || '' };
  }

  function repoFromHost() {
    const host = location.hostname;
    if (!host.endsWith('.github.io')) return null;
    const owner = host.slice(0, -'.github.io'.length);
    const parts = location.pathname.split('/').filter(Boolean);
    const first = parts[0] || '';
    const isFile = first.includes('.');
    const repo = !first || isFile ? owner + '.github.io' : first;
    return { owner, repo };
  }

  async function importKey(keyB64) {
    return crypto.subtle.importKey(
      'raw',
      b64urlToBytes(keyB64),
      'AES-GCM',
      false,
      ['decrypt']
    );
  }

  async function decryptBox(box, cryptoKey) {
    const iv = b64urlToBytes(box.iv);
    const ct = b64urlToBytes(box.ct);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ct);
    return JSON.parse(new TextDecoder().decode(pt));
  }

  async function getJson(url, headers) {
    const res = await fetch(url, { cache: 'no-store', headers: headers || {} });
    return res;
  }

  function decodeContents(meta) {
    if (!meta || !meta.content) return null;
    const bin = atob(meta.content.replace(/\n/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  async function loadBox(cfg, cryptoKey) {
    const loc = repoFromHost();
    const headers = {};
    if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token;
    const errors = [];

    if (loc) {
      const api = 'https://api.github.com/repos/' + loc.owner + '/' + loc.repo +
        '/contents/' + cfg.path + '?ref=main';
      try {
        const res = await getJson(api, Object.assign({ Accept: 'application/vnd.github+json' }, headers));
        if (res.ok) {
          const box = decodeContents(await res.json());
          return { box, source: cfg.token ? 'api-auth' : 'api' };
        }
        errors.push('api ' + res.status);
      } catch (e) {
        errors.push('api fail');
      }

      const raw = 'https://raw.githubusercontent.com/' + loc.owner + '/' + loc.repo +
        '/main/' + cfg.path;
      try {
        const res = await getJson(raw);
        if (res.ok) return { box: await res.json(), source: 'raw' };
        errors.push('raw ' + res.status);
      } catch (e) {
        errors.push('raw fail');
      }
    }

    try {
      const res = await getJson(cfg.path);
      if (res.ok) return { box: await res.json(), source: 'pages' };
      errors.push('pages ' + res.status);
    } catch (e) {
      errors.push('pages fail');
    }
    throw new Error(errors.join(', ') || 'no source');
  }

  async function tick(cfg, cryptoKey) {
    const { box, source } = await loadBox(cfg, cryptoKey);
    const data = await decryptBox(box, cryptoKey);
    if (payloadEl) {
      payloadEl.hidden = false;
      payloadEl.textContent = JSON.stringify(data, null, 2);
    }
    const ts = data && data.ts ? String(data.ts) : '';
    setStatus('Live data ok (' + source + (ts ? ', ' + ts : '') + ')');
  }

  async function main() {
    const cfg = parseFragment();
    if (!cfg.key || !cfg.path) {
      setStatus('Skeleton. Open the bookmarked URL that includes the fragment.');
      return;
    }
    let cryptoKey;
    try {
      cryptoKey = await importKey(cfg.key);
    } catch (e) {
      setStatus('Cannot use the key in the fragment.');
      return;
    }
    const interval = cfg.token ? 15000 : 60000;
    async function once() {
      try {
        await tick(cfg, cryptoKey);
      } catch (e) {
        setStatus('Waiting for data.');
      }
    }
    await once();
    setInterval(once, interval);
  }

  main();
})();
