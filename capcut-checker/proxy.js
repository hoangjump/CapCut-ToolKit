/**
 * Proxy helper — quản lý NHIỀU key proxy, xoay round-robin.
 */

const BASE = 'https://api.mktproxy.com/api';
const TIMEOUT = 15_000;

async function mktFetch(path, opts = {}, apiKey) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const headers = { ...opts.headers };
    if (apiKey) headers['X-API-Key'] = apiKey;
    const res = await fetch(`${BASE}${path}`, { ...opts, headers, signal: ctrl.signal });
    const json = await res.json();
    if (!res.ok || json?.success === false) throw new Error(json?.message || `HTTP ${res.status}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export async function rotateIp(proxyKey) {
  const body = await mktFetch('/proxies/rotate-ip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: proxyKey }),
  });
  return parseProxy(body);
}

export async function getCurrentProxy(proxyKey) {
  const body = await mktFetch(`/proxies/new?key=${encodeURIComponent(proxyKey)}`, { method: 'GET' });
  return parseProxy(body);
}

function parseProxy(body) {
  const d = body?.data ?? {};
  return {
    value: d.value || d.http || d.socks5 || '',
    ip: d.ip || '',
    port: d.port || '',
    user: d.user || '',
    pass: d.pass || '',
    http: d.http || '',
    socks5: d.socks5 || '',
    realIp: d.real_ip || '',
  };
}

export function proxyUrl(p) {
  if (!p || !p.value) return null;
  const parts = p.value.split(':');
  if (parts.length >= 4) return `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
  if (parts.length >= 2) {
    if (p.user && p.pass) return `http://${p.user}:${p.pass}@${parts[0]}:${parts[1]}`;
    return `http://${parts[0]}:${parts[1]}`;
  }
  return null;
}

/**
 * Quản lý pool proxy keys — xoay round-robin.
 */
export class ProxyPool {
  constructor(keys, rotate = true) {
    this.keys = keys;
    this.rotate = rotate;
    this.index = 0;
  }

  get size() { return this.keys.length; }

  /** Lấy proxy cho account tiếp theo: round-robin qua các key, xoay IP mỗi lần. */
  async next() {
    if (this.keys.length === 0) return null;

    const key = this.keys[this.index % this.keys.length];
    this.index++;

    try {
      const p = this.rotate ? await rotateIp(key) : await getCurrentProxy(key);
      const url = proxyUrl(p);
      return {
        url,
        key,
        keyIndex: ((this.index - 1) % this.keys.length) + 1,
        ip: p.realIp || p.ip || p.value,
      };
    } catch (e) {
      return { url: null, key, keyIndex: ((this.index - 1) % this.keys.length) + 1, ip: null, error: e.message };
    }
  }
}
