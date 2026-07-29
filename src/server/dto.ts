import { proxyDisplay, type ProxyRecord } from '../proxyStore.js';

// Dùng chung giữa index.ts và routes/mktproxy.ts. Để trong index.ts thì module
// route phải import ngược lại index — vòng tròn, chạy được nhưng dễ vỡ khi đổi
// thứ tự import.
/** Shape returned to the UI — adds derived display string + status label.
 *  KHÔNG trả apiKey (bí mật) về UI, chỉ cờ isApi để hiển thị nhãn. */
export function toDto(p: ProxyRecord) {
  const { apiKey, ...rest } = p;
  void apiKey;
  return {
    ...rest,
    display: proxyDisplay(p),
    status: p.alive === null ? 'unchecked' : p.alive ? 'live' : 'dead',
    isApi: Boolean(p.apiProvider),
    apiProvider: p.apiProvider,
  };
}
