import { ProxyAgent } from 'proxy-agent';
import { request } from 'node:https';
import { proxyUrl, type ProxyRecord } from './proxyStore.js';

export interface CheckResult {
  alive: boolean;
  latencyMs?: number;
  ip?: string;
  error?: string;
}

/** Endpoint trả về IP gọi đến — dùng để xác nhận proxy thực sự định tuyến. */
const CHECK_URL = process.env.PROXY_CHECK_URL ?? 'https://api.ipify.org?format=json';

/**
 * `proxy-agent` hợp nhất transport cho mọi scheme: nó đọc URL proxy và tự chọn
 * http/https/socks. Ta ép nó luôn dùng đúng proxy đang test qua `getProxyForUrl`
 * (thay vì đọc biến môi trường HTTP(S)_PROXY mặc định).
 */
function agentFor(p: ProxyRecord): ProxyAgent {
  const url = proxyUrl(p);
  return new ProxyAgent({ getProxyForUrl: () => url });
}

/**
 * Gửi 1 GET qua proxy tới CHECK_URL bằng module `https` (proxy-agent cắm vào
 * http/https, KHÔNG dùng được với fetch/undici). Live = 2xx trong timeout.
 */
export function checkProxy(p: ProxyRecord, timeoutMs = 10_000): Promise<CheckResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const agent = agentFor(p);
    const done = (r: CheckResult) => {
      agent.destroy();
      resolve(r);
    };
    const req = request(
      CHECK_URL,
      { agent, timeout: timeoutMs, method: 'GET' },
      (res) => {
        const latencyMs = Date.now() - start;
        const status = res.statusCode ?? 0;
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (status < 200 || status >= 300) {
            done({ alive: false, latencyMs, error: `HTTP ${status}` });
            return;
          }
          let ip: string | undefined;
          try {
            ip = (JSON.parse(body) as { ip?: string }).ip;
          } catch {
            // body không phải JSON — vẫn Live vì đã có 2xx
          }
          done({ alive: true, latencyMs, ip });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Timeout sau ${timeoutMs}ms`)));
    req.on('error', (err) => done({ alive: false, error: err.message }));
    req.end();
  });
}
