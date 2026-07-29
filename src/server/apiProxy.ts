import { parseProxyLine, type ProxyRecord, type ProxyType, type ProxyStore } from '../proxyStore.js';
import type { UsedIpStore } from '../usedIpStore.js';
import type { SettingsStore } from '../settingsStore.js';
import type { ProxyLeaseRegistry } from '../proxyLeaseRegistry.js';
import type { ProxyConfig } from '../types.js';
import type { RotatedPaymentProxy } from './paymentProxyAllocator.js';
import * as mktproxy from '../mktproxyClient.js';
import { checkProxy } from '../proxyChecker.js';
import { createLogger } from '../logger.js';

const log = createLogger('server');

export interface ApiProxyDeps {
  store: ProxyStore;
  usedIps: UsedIpStore;
  settings: SettingsStore;
  proxyLeases: ProxyLeaseRegistry;
}

/**
 * Mọi thao tác với proxy xoay của mktproxy: whitelist IP máy, xoay tới khi ra IP
 * chưa dùng, dựng ProxyConfig gateway.
 *
 * Tách khỏi createApp vì hai bên cần chúng ở hai thời điểm khác nhau:
 * BrowserManager nhận `resolveFreshApiProxy` NGAY LÚC KHỞI TẠO (trước khi route
 * được đăng ký), còn các route /api/proxies gọi `refreshApiProxy` lúc chạy. Để
 * chung trong createApp thì không tách route ra file khác được.
 */
export function createApiProxyHelpers({ store, usedIps, settings, proxyLeases }: ApiProxyDeps) {
// IP công khai của máy đang chạy app (gọi TRỰC TIẾP, không qua proxy). Dùng để
// whitelist cho proxy auth_type=ip_whitelist.
async function getPublicIp(): Promise<string | null> {
  try {
    const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(8_000) });
    const j = (await res.json()) as { ip?: string };
    return j?.ip || null;
  } catch {
    return null;
  }
}

// Whitelist IP máy cho proxy xoay dạng ip_whitelist (best-effort). Proxy dùng
// userpass thì endpoint này có thể lỗi — bỏ qua, không chặn luồng. Đây chính là
// thứ khắc phục "read ECONNRESET": proxy chỉ nhận kết nối từ IP đã whitelist.
async function ensureWhitelist(itemKey: string): Promise<void> {
  const accountKey = settings.getMktproxyKey();
  const ip = await getPublicIp();
  if (!ip) return;
  if (!accountKey) {
    log.warn('mktproxy: chưa có API key TÀI KHOẢN → không whitelist được IP (proxy ip_whitelist sẽ bị ECONNRESET). Nhập key tài khoản ở card "Mua proxy".');
    return;
  }
  try {
    await mktproxy.updateIpWhitelist(accountKey, itemKey, [ip]);
    log.info(`mktproxy: whitelist IP ${ip} cho đơn ${itemKey.slice(0, 6)}…`);
  } catch (e) {
    log.warn(`mktproxy: whitelist lỗi (${(e as Error).message}) — key TÀI KHOẢN phải đúng (KHÁC key đơn proxy).`);
  }
}

async function refreshApiProxy(proxy: ProxyRecord): Promise<ProxyRecord> {
  if (proxy.apiProvider !== 'mktproxy' || !proxy.apiKey) return proxy;
  if (proxyLeases.isLeased(proxy.id)) {
    log.warn(`mktproxy: proxy ${proxy.id} đang được một phiên sử dụng, bỏ qua rotate`);
    return proxy;
  }
  // Whitelist IP máy trước — proxy ip_whitelist sẽ reset kết nối nếu IP chưa
  // được cho phép (ECONNRESET). Chạy mỗi lần test để bám theo IP hiện tại.
  await ensureWhitelist(proxy.apiKey);
  try {
    // rotate-ip để KÍCH HOẠT egress: proxies/new chỉ đọc cache, đơn có thể chưa
    // "live" nên connect bị reset dù đã whitelist. rotate-ip trong cooldown trả
    // proxy hiện tại (an toàn, không tốn thêm). Fallback proxies/new nếu lỗi.
    let rp = await mktproxy.rotateIp(proxy.apiKey).catch(() => null);
    if (!rp || !rp.value) rp = await mktproxy.getCurrentProxy(proxy.apiKey).catch(() => null);
    if (!rp) return proxy;
    // DÙNG ĐÚNG protocol NCC trả (proxy này là HTTP, không phải socks5) — sai
    // giao thức là ECONNRESET. value thường không kèm user:pass (auth theo IP).
    const proto: ProxyType = rp?.protocol === 'socks5' ? 'socks5' : rp?.protocol === 'http' ? 'http' : proxy.type;
    const line = ((proto === 'socks5' ? rp?.socks5 : rp?.http) || rp?.value || '').trim();
    if (!line) return proxy;
    const parsed = parseProxyLine(line);
    return await store.update(proxy.id, {
      type: proto, host: parsed.host, port: parsed.port, username: parsed.username, password: parsed.password,
    });
  } catch (e) {
    log.warn(`mktproxy: refresh proxy API lỗi (${proxy.id}): ${(e as Error).message}`);
    return proxy;
  }
}

/** Dựng ProxyConfig gateway từ response rotate + cập nhật ảnh chụp record. */
function buildApiConfig(record: ProxyRecord, rp: mktproxy.MktRotatingProxy): ProxyConfig | undefined {
  const proto: ProxyType = rp.protocol === 'socks5' ? 'socks5' : rp.protocol === 'http' ? 'http' : record.type;
  const line = ((proto === 'socks5' ? rp.socks5 : rp.http) || rp.value || '').trim();
  let host = '';
  let port = 0;
  let username: string | undefined;
  let password: string | undefined;
  try {
    const p = parseProxyLine(line);
    host = p.host; port = p.port; username = p.username; password = p.password;
  } catch {
    if (rp.ip && rp.port) { host = rp.ip; port = Number(rp.port); }
    else return undefined;
  }
  void store.update(record.id, { type: proto, host, port, username, password }).catch(() => {});
  return { server: `${proto}://${host}:${port}`, username, password };
}

async function rotatePaymentProxy(record: ProxyRecord): Promise<RotatedPaymentProxy> {
  if (record.apiProvider !== 'mktproxy' || !record.apiKey) {
    throw new Error('Payment strict chỉ sử dụng proxy xoay MKTProxy');
  }
  await ensureWhitelist(record.apiKey);
  let rotated = await mktproxy.rotateIp(record.apiKey).catch(() => null);
  if (!rotated?.value) rotated = await mktproxy.getCurrentProxy(record.apiKey).catch(() => null);
  if (!rotated?.value) throw new Error(`MKTProxy không trả proxy cho đơn ${record.apiKey.slice(0, 6)}…`);
  const proxy = buildApiConfig(record, rotated);
  if (!proxy) throw new Error(`MKTProxy trả cấu hình proxy không hợp lệ cho ${record.apiKey.slice(0, 6)}…`);
  return {
    proxy,
    egressIp: rotated.realIp || rotated.ip,
    retryAfterMs: Math.max(1_000, Number(rotated.second || 5) * 1_000),
  };
}

async function verifyPaymentProxy(
  proxy: ProxyConfig,
  rotated: RotatedPaymentProxy,
  record: ProxyRecord,
): Promise<string | undefined> {
  const parsed = new URL(proxy.server);
  const protocol = parsed.protocol.replace(':', '');
  const type: ProxyType = protocol === 'socks5' ? 'socks5' : protocol === 'https' ? 'https' : 'http';
  const checked = await checkProxy({
    ...record,
    type,
    host: parsed.hostname,
    port: Number(parsed.port),
    username: proxy.username,
    password: proxy.password,
  }, 10_000);
  await store.update(record.id, {
    alive: checked.alive,
    latencyMs: checked.latencyMs,
    checkedAt: new Date().toISOString(),
  });
  if (!checked.alive) throw new Error(`Proxy payment không hoạt động: ${checked.error || 'không kết nối được'}`);
  if (!checked.ip) throw new Error('Proxy payment không trả IP thực tế');
  if (rotated.egressIp && rotated.egressIp !== checked.ip) {
    log.warn(`mktproxy: API báo IP ${rotated.egressIp} nhưng kiểm tra thực tế là ${checked.ip}`);
  }
  log.info(`mktproxy: dành IP payment mới ${checked.ip} từ đơn ${record.apiKey?.slice(0, 6)}…`);
  return checked.ip;
}

/**
 * Rút proxy dạng API cho MỘT profile đăng ký: whitelist IP máy, rồi XOAY
 * (rotate-ip) tới khi egress `real_ip` CHƯA từng dùng reg CapCut (usedIps) →
 * đánh dấu đã dùng → trả config gateway. Tôn trọng cooldown (chờ `second` giây
 * giữa các lần xoay), trần chờ 4 phút; hết cách thì dùng IP hiện tại để không
 * treo. Nhờ vậy mỗi account một IP mới (100 account / 5 proxy ≈ 20 IP/proxy).
 */
async function resolveFreshApiProxy(record: ProxyRecord): Promise<ProxyConfig | undefined> {
  if (record.apiProvider !== 'mktproxy' || !record.apiKey) {
    if (!record.host) return undefined;
    return { server: `${record.type}://${record.host}:${record.port}`, username: record.username, password: record.password };
  }
  await ensureWhitelist(record.apiKey);
  const deadline = Date.now() + 4 * 60_000;
  let last: mktproxy.MktRotatingProxy | null = null;
  for (let i = 0; i < 30 && Date.now() < deadline; i += 1) {
    let rp = await mktproxy.rotateIp(record.apiKey).catch(() => null);
    if (!rp || !rp.value) rp = await mktproxy.getCurrentProxy(record.apiKey).catch(() => null);
    if (!rp || !rp.value) break;
    last = rp;
    const egress = rp.realIp || rp.ip || '';
    if (!egress || !usedIps.has(egress)) {
      await usedIps.add(egress);
      log.info(`mktproxy: dùng IP mới ${egress || '(không rõ)'} cho reg (đơn ${record.apiKey.slice(0, 6)}…, đã dùng ${usedIps.count()})`);
      return buildApiConfig(record, rp);
    }
    const waitS = Math.min(rp.second && rp.second > 0 ? rp.second : 60, 65);
    if (Date.now() + waitS * 1000 >= deadline) break;
    log.info(`mktproxy: IP ${egress} đã dùng reg — chờ ${waitS}s xoay lại (đơn ${record.apiKey.slice(0, 6)}…)`);
    await new Promise((r) => setTimeout(r, waitS * 1000 + 500));
  }
  if (last?.value) {
    await usedIps.add(last.realIp || last.ip);
    log.warn('mktproxy: không lấy được IP mới sau khi chờ — dùng IP hiện tại');
    return buildApiConfig(record, last);
  }
  return undefined;
}
  return { getPublicIp, ensureWhitelist, refreshApiProxy, buildApiConfig, rotatePaymentProxy, verifyPaymentProxy, resolveFreshApiProxy };
}
