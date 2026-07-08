# Bộ nhớ dự án — CapCut Auto

Ghi chú tích luỹ cho các phiên làm việc sau. Cập nhật khi có phát hiện mới.

## Kiến trúc

- Electron app: `electron/main.ts` chạy Express **in-process** (`startServer`) rồi
  `loadURL(server.url)`. Server phục vụ **`web/dist`** (UI React mới) nếu có, fallback
  `public/index.html` (UI vanilla cũ). Xem `resolveDefaultPublicDir()` trong
  `src/server/index.ts`.
- UI mới: `web/` = Vite + React + TS + Tailwind v3 + component shadcn-style (Radix).
  4 tab: Quản lý proxy, Hồ sơ, Mail, Project + LogDrawer (SSE `/api/logs/stream`).
  API client: `web/src/lib/api.ts`. Backend/API giữ nguyên khi port UI.
- Engine automation: Camoufox (Firefox vá) qua Playwright. Flow ở `src/flows/`.

## Build / đóng gói (macOS)

- `npm run desktop:pack` = `tsc` (backend) + `build:web` (Vite) + `electron-builder --dir`.
- **asar: false** — vì camoufox-js đọc `webgl_data.db` qua better-sqlite3 (C++ native),
  mở file trực tiếp không qua lớp asar của Electron.
- Trước khi pack phải **tắt app đang mở** (`pkill -f "CapCut Auto"`) nếu không
  electron-builder lỗi `ENOTEMPTY` khi xoá `release/mac-arm64`.
- Build Windows: KHÔNG copy node_modules từ Mac (native module theo nền tảng:
  impit-*, better-sqlite3). Có CI `.github/workflows/desktop-release.yml` build cả
  mac+win khi push tag `v*.*.*`.

## Header native

- `electron/main.ts`: mac `titleBarStyle:'hiddenInset'` + trafficLightPosition; win
  `'hidden'` + `titleBarOverlay`. Header web là vùng kéo (`.drag`), control `.no-drag`,
  chừa lề trái ~84px cho traffic lights trên mac.

## mktproxy.com — QUAN TRỌNG: HAI loại key khác nhau

- **Key SERVER** (`mkt_...`) → header `X-API-Key`: `/balance`, `/buy-proxy`, `/orders`,
  và **header** của `/update-ip-whitelist`. Lưu ở `settings.mktproxyApiKey`.
- **Key PROXY** (hex 24 ký tự, vd `6a4a...`) → query/body `key`, KHÔNG header:
  `/proxies/new`, `/proxies/current`, `/proxies/rotate-ip`, và `key` trong **body**
  của `/update-ip-whitelist`. Lưu trong ProxyRecord.apiKey (proxy dạng API).
- Đừng nhầm: dùng key PROXY làm X-API-Key → `Invalid API key`.

### Proxy xoay auth_type=ip_whitelist (vd "Proxy Rotate VN"):
- Là **HTTP** (`protocol:"http"`), **không user/pass**, auth theo IP nguồn.
- Flow chạy được (đã verify gọi API thật):
  1. whitelist IP máy: `POST /update-ip-whitelist` header X-API-Key=key SERVER,
     body `{key: key PROXY, ip_whitelist:[ip máy]}`.
  2. **`POST /proxies/rotate-ip {key: key PROXY}` để KÍCH HOẠT egress** — chỉ gọi
     `proxies/new` (đọc cache) thì đơn chưa live → connect ECONNRESET.
  3. connect gateway host:port (HTTP) TỪ IP đã whitelist.
- Whitelist có độ trễ propagate (~vài chục giây) — Test ngay sau khi thêm có thể
  fail lần đầu, thử lại.
- Lưu proxy phải theo ĐÚNG `protocol` NCC trả (đừng ép socks5 → ECONNRESET).

### Tự xoay IP mỗi profile (đăng ký hàng loạt)
- `BrowserManager` nhận hook `deps.resolveApiProxy` (do createApp cấp). Khi pool RÚT
  một proxy `apiProvider='mktproxy'` → gọi `refreshApiProxy` (whitelist + rotate-ip)
  → mỗi profile tạm/đăng ký một IP MỚI. Bỏ qua recheck liveness tĩnh cho proxy API.
- Pool leasing tự serialize: 1 proxy API + concurrency>1 → các profile chờ nhau
  (proxy xoay không thể cho 2 IP khác nhau cùng lúc). Reg mất vài phút > cooldown
  60s của rotate-ip nên con sau luôn có IP mới.
- Để dùng: Project → bật "Rút proxy từ kho theo tag", tag = `mktproxy` (hoặc trống
  = mọi proxy Live), "Số lượng cần tạo" = số account, "Số proxy chạy song song" =
  concurrency (= số proxy). 100 account / 5 proxy ≈ 20/proxy (batch tự chia).

### Mỗi IP chỉ reg 1 lần (used-ips.json)
- `src/usedIpStore.ts` (UsedIpStore) lưu egress `real_ip` đã dùng reg CapCut.
- `resolveFreshApiProxy` (server): whitelist → rotate-ip tới khi `real_ip` CHƯA
  dùng (usedIps) → đánh dấu → trả config gateway. Tôn trọng cooldown (chờ `second`
  giây giữa các lần xoay), trần 4 phút, hết cách thì dùng IP hiện tại.
- browserManager pool draw proxy API → gọi resolveFreshApiProxy (mỗi profile 1 IP
  mới). Nút Test vẫn dùng refreshApiProxy (không đụng used-ips).
- Đánh dấu IP "đã dùng" tại lúc RÚT (kể cả reg fail) — vì CapCut đã thấy IP đó.

## Flow capcut-signin (đã ổn định)

- `reachDashboard()` sau OTP: vòng lặp poll xử onboarding không cố định thứ tự —
  bấm "Open CapCut" / "Skip" (quét mọi iframe, click 4s rồi dispatchEvent), chỉ coi
  là vào dashboard khi hết nút onboarding + thấy `.LvHeaderUpgradeVipNew`.
- `addLocatorHandler` đóng popup dùng `{ noWaitAfter: true }` (X modal vai trò bấm
  không tắt → mặc định treo 30s).

## Google Sheet (apps-script.gs)

- Công thức đếm ngược cột Time phải theo **locale** (dấu `,` vs `;`): dò qua
  `argSeparator()` (ghi 1.1 vào Z2, xem hiển thị) — sai dấu là `#ERROR!`.
