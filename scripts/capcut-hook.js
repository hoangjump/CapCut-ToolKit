/**
 * F12 — Hook TẤT CẢ XHR + Fetch trên capcut.com
 * Dán → Enter → hook tự chạy. Sau đó bấm quanh UI (Credits, Upgrade…)
 * hoặc F5 reload trang để bắt từ đầu.
 *
 * Lọc bỏ noise (monitor/collect/mcs/sentry) — chỉ hiện API thật.
 */
(function() {
  const NOISE = ['monitor_browser', '/collect', 'mcs-normal', 'sentry', 'growthcollect', 'log/collect', 'batch/?biz'];
  const skip = (url) => NOISE.some(n => url.includes(n));

  // ====== HOOK XMLHttpRequest ======
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url) {
    this._hUrl = String(url);
    this._hMethod = String(method).toUpperCase();
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(body) {
    const url = this._hUrl;
    if (url && !skip(url)) {
      const short = url.split('?')[0].replace(/https?:\/\/[^/]+/, '');

      this.addEventListener('load', function() {
        let parsed;
        try { parsed = JSON.parse(this.responseText); } catch {}
        if (parsed) {
          console.groupCollapsed(`%c✦ XHR ${this._hMethod} ${short}  → ${this.status}`, 'color:#4caf50;font-weight:bold');
          console.log('Full URL:', url);
          if (body) { try { console.log('Request body:', JSON.parse(body)); } catch { console.log('Request body:', body); } }
          console.log('Response:', parsed);
          if (parsed.data) console.log('%c→ data:', 'color:#ff9800;font-weight:bold', parsed.data);
          console.groupEnd();
        }
      });
    }
    return origSend.apply(this, arguments);
  };

  // ====== HOOK fetch ======
  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (skip(url)) return origFetch.apply(this, arguments);

    const method = init?.method || 'GET';
    const short = url.split('?')[0].replace(/https?:\/\/[^/]+/, '');
    const bodyRaw = init?.body;

    return origFetch.apply(this, arguments).then(res => {
      const clone = res.clone();
      clone.text().then(text => {
        let parsed;
        try { parsed = JSON.parse(text); } catch {}
        if (parsed) {
          console.groupCollapsed(`%c✦ FETCH ${method} ${short}  → ${res.status}`, 'color:#9c27b0;font-weight:bold');
          console.log('Full URL:', url);
          if (bodyRaw) { try { console.log('Request body:', JSON.parse(bodyRaw)); } catch { console.log('Request body:', bodyRaw); } }
          console.log('Response:', parsed);
          if (parsed.data) console.log('%c→ data:', 'color:#ff9800;font-weight:bold', parsed.data);
          console.groupEnd();
        }
      }).catch(() => {});
      return res;
    });
  };

  console.log('%c[Hook] ✓ Đã hook XHR + Fetch (lọc noise).', 'color:lime;font-weight:bold;font-size:14px');
  console.log('%c[Hook] Bấm vào ✦ Credits, Upgrade, hoặc F5 reload trang.', 'color:#aaa;font-size:12px');
})();
