# TeamHatDe-Auto — Multi-profile browser manager

Hệ thống quản lý nhiều profile trình duyệt với anti-detect fingerprint, lưu
session theo từng profile và gán proxy riêng cho mỗi profile. Engine là
[Camoufox](https://camoufox.com/) — một bản Firefox được vá ở tầng C++ để spoof
fingerprint ngay trong engine (canvas/WebGL/audio/font/screen/CPU/RAM/WebRTC…),
điều khiển qua Playwright. Đi kèm một web UI (Express + HTML tĩnh) để quản lý
proxy và hồ sơ.

> **Vì sao Camoufox thay vì Chromium?** Spoof ở tầng engine (C++) khó bị phát
> hiện hơn nhiều so với cách tiêm JavaScript sau khi trang đã load: không để lại
> dấu vết "đã patch", và platform/UA/WebGL/font tự nhất quán với nhau theo OS đã
> chọn. Đổi lại, engine là Firefox — automation viết theo API Playwright Firefox.

## Chạy thử

```bash
npm install
npx camoufox-js fetch              # tải binary Camoufox (~150MB) — lần đầu

npm run server:dev                 # web UI + API, mặc định http://localhost:3000
npm run dev                        # demo CLI: seed vài profile rồi mở song song, in egress IP/UA
```

Build production:

```bash
npm run build                      # tsc -> dist/
npm run server                     # chạy bản đã build
npm run dist:win                   # build bộ cài Windows, kèm cloudflared.exe
```

Biến môi trường:
- `PORT` — cổng web (mặc định 3000)
- `STORE_ROOT` — thư mục lưu trữ (mặc định `./profiles-store`)
- `HEADLESS` — chế độ hiển thị trình duyệt:
  - `false` — headful, cửa sổ thật trên màn hình (mặc định khi chạy local)
  - `virtual` — headful bên trong màn hình ảo Xvfb (mặc định trong Docker; khó bị
    phát hiện hơn headless thuần của Firefox)
  - `true` — headless thật (nhanh nhất nhưng dễ lộ nhất)
  - Khi không đặt: `virtual` nếu `NODE_ENV=production`, ngược lại headful.
- `CAMOUFOX_INSTALL_DIR` — nơi cài/đọc binary Camoufox (mặc định `~/.cache/camoufox`).
  Đặt biến này khi home directory vô định (container/CI).

## Docker

```bash
docker compose up -d --build       # build image + chạy nền, web ở http://localhost:3000
docker compose logs -f             # xem log
docker compose down                # dừng + xóa container
```

### Thanh toán nhân viên trong app Windows

App tự chạy toàn bộ luồng, không cần VPS, Docker gateway hay cấu hình tên miền:

1. Khi app mở, `cloudflared.exe` tạo một Quick Tunnel `https://...trycloudflare.com`.
2. Bot gửi link `/pay/:token` vào Telegram cho nhân viên.
3. Nhân viên bấm bắt đầu; app mở Camoufox headless bằng đúng proxy của tài khoản.
4. Trang nhân viên nhận ảnh màn hình và gửi click/phím về app. Phiên tự đóng sau
   15 phút; mặc định tối đa 3 phiên đồng thời.
5. Thanh toán thành công chỉ đổi trạng thái. Tiền công vẫn chỉ cộng khi nhân viên
   thả reaction ❤️ trên Telegram.

Tab `Công việc -> Thanh toán` trên app PC hiển thị các phiên chờ/đang chạy và số
slot đang dùng. Nút `Xem` mở popup màn hình remote ngay trong app để quản lý theo
dõi hoặc thao tác hỗ trợ; browser tự đóng sau 5 giây khi phát hiện thanh toán xong.

Trong `Công việc -> Telegram`, nút `Bật link nhân viên` dùng để bật lại tunnel nếu
nó bị mất kết nối. App ghi nhớ lựa chọn và tự bật ở lần chạy sau. Public hostname
chỉ được phép truy cập trang/API thanh toán, không thể mở dashboard quản trị.

Lệnh `npm run dist:win` tự tải binary chính thức của Cloudflare và nhét vào bộ cài;
máy nhân viên không phải cài thêm gì, máy quản lý cũng không cần mở port router.

[Dockerfile](Dockerfile) dùng base image `mcr.microsoft.com/playwright:vX.Y-noble`
**chỉ để lấy system lib** (Xvfb, fonts, thư viện đồ họa mà Firefox cần) — engine
thật là binary Camoufox được `npx camoufox-js fetch` tải vào `/opt/camoufox` và
bake thẳng vào image, nên container khởi động là chạy ngay, không cần tải lúc
runtime. Vì engine không phải Chromium của image nữa, tag base image **không cần
khớp** version playwright; nó chỉ cung cấp system deps.

Trong container không có X server, nên server mặc định chạy `HEADLESS=virtual`:
Camoufox chạy headful thật bên trong một màn hình ảo Xvfb (camoufox-js tự spawn
Xvfb). Cửa sổ trình duyệt do nút "Mở" bật lên sống trong màn hình ảo đó — thứ bạn
xem qua trình duyệt là web UI ở cổng 3000. Muốn thấy cửa sổ thật trên màn hình
thì chạy local với `npm run server:dev`.

## Lưu trữ trên đĩa

`ProfileManager` sở hữu layout dưới `STORE_ROOT` (mặc định `profiles-store/`):

```
<root>/profiles.json        — metadata mọi profile
<root>/data/<profileId>/     — userDataDir của Camoufox (cookies, localStorage, …)
<root>/proxies.json          — thư viện proxy
<root>/mails.json            — kho mail (email + refresh_token + client_id)
<root>/settings.json         — cài đặt app (API key dongvanfb)
<root>/projects.json         — automation job (tên flow + profile để chạy)
<root>/telegram-work.json    — nhân viên, task Telegram, reaction và sổ tiền công
<root>/shots/                — screenshot do flow chụp (<name>-<ts>.png)
```

`ProxyStore` lưu thư viện proxy trong cùng `STORE_ROOT`. Session trình duyệt sống
trong `userDataDir` nên cookies/localStorage tự động bền qua các lần chạy — không
cần dump session thủ công.

`mails.json` và `settings.json` chứa **bí mật thật** (refresh_token, API key
dongvanfb). Chúng nằm local trong `STORE_ROOT`; API key không bao giờ trả nguyên
văn về UI — endpoint `GET /api/settings` chỉ trả bản masked.

## Kiến trúc mã nguồn

| File | Vai trò |
|------|---------|
| [src/types.ts](src/types.ts) | Kiểu dữ liệu: `Profile`, `AntiDetectConfig`, `BrowserSettings`, `ProxyConfig` + các hàm `default*()`. |
| [src/profileManager.ts](src/profileManager.ts) | CRUD profile, persist `profiles.json`, sở hữu `userDataDir`. |
| [src/browserManager.ts](src/browserManager.ts) | Vòng đời `BrowserContext` theo profile qua Camoufox: `open`/`close`/`closeAll`, `isOpen`/`openProfileIds`, `rotate` (xoay proxy, close+reopen), `runBatch` (chạy hàng loạt có giới hạn đồng thời). Resolve proxy lúc mở qua `proxyResolver`, dựng proxy relay. |
| [src/antiDetect.ts](src/antiDetect.ts) | `languageForCountry` — suy `navigator.language` từ quốc gia của proxy IP. (Spoofing fingerprint còn lại do engine Camoufox lo.) |
| [src/proxyStore.ts](src/proxyStore.ts) | Thư viện proxy: CRUD, parse dòng `host:port[:user:pass]`, hiển thị. |
| [src/proxyChecker.ts](src/proxyChecker.ts) | Kiểm tra proxy còn sống + đo độ trễ. |
| [src/proxyResolver.ts](src/proxyResolver.ts) | Quyết định proxy cho mỗi lần launch theo `mode` (static/pool/gateway); bốc ngẫu nhiên từ `ProxyStore` cho pool. Thuần quyết định — `BrowserManager` lo persist. |
| [src/mailClient.ts](src/mailClient.ts) | Client HTTP gọi API dongvanfb: `getBalance`/`buyMail` (cần API key), `getCode` (thử OAuth2 → fallback Graph), `getMessages`. Thuần, không giữ state. |
| [src/mailStore.ts](src/mailStore.ts) | Kho mail: CRUD, `createMany` (nạp lô từ mua), parse dòng `email\|pass\|refresh\|client`, suy provider từ domain. |
| [src/settingsStore.ts](src/settingsStore.ts) | Cài đặt app (API key dongvanfb) trong `settings.json`; `maskKey` để hiển thị an toàn. |
| [src/automation/types.ts](src/automation/types.ts) | Kiểu automation: `FlowContext` (page + helper + session + getOtp + log), `Flow`, `FlowMeta`, `RegisteredFlow`. |
| [src/automation/helper.ts](src/automation/helper.ts) | `PageHelper` — wrapper mỏng trên `Page` với timeout + log gọn (goto/click/fill/type/waitFor/exists/text/sleep/screenshot). Không nuốt lỗi. |
| [src/automation/runner.ts](src/automation/runner.ts) | `runProject` — dựng `FlowContext` mỗi profile trên `runBatch`, poll OTP qua `getCode`, trả `RunResult[]` per-profile (lỗi cô lập từng profile). |
| [src/projectStore.ts](src/projectStore.ts) | Kho automation job: CRUD `projects.json` (tên flow + danh sách profile + mail gán). |
| [src/flows/index.ts](src/flows/index.ts) | Registry flow: `FLOWS` map + `flowMetas()`/`getFlow()`. Thêm automation = thêm 1 file flow + đăng ký 1 dòng. |
| [src/flows/demo.ts](src/flows/demo.ts) | Flow mẫu: mở trang IP/fingerprint + chụp screenshot. An toàn, để smoke-test khung. |
| [src/server/index.ts](src/server/index.ts) | Express API + phục vụ UI tĩnh từ `public/`. |
| [public/index.html](public/index.html) | Toàn bộ web UI (HTML/CSS/JS một file). |

## Anti-detect — các knob

Camoufox lo phần nặng (canvas/WebGL/audio/font/screen/CPU/RAM/mediaDevices) ngay
trong engine theo OS đã chọn, nên `AntiDetectConfig` chỉ còn vài lựa chọn
lúc launch:

- **osProfile**: `auto` | `windows` | `macos` | `linux` — OS mà fingerprint sẽ
  khai. Camoufox sinh trọn bộ platform/UA/WebGL/font nhất quán với OS này. `auto`
  để Camoufox random mỗi lần mở.
- **language**: `real` | `base-on-ip` — giữ locale mặc định (nhất quán OS) hay suy
  từ quốc gia của proxy IP (map thô 9 nước). Khi `geoip` bật thì bị nó thay bằng
  locale chính xác từ MaxMind.
- **webrtc**: `base-on-ip` | `real` | `disabled` — `disabled` tắt hẳn stack WebRTC
  để không lộ IP; còn lại để bật (proxy relay đã ép egress nên IP phát hiện khớp
  proxy).
- **geoip**: `true` | `false` — khi bật (và profile có proxy), Camoufox gửi 1
  request qua chính relay để lấy IP egress rồi tra MaxMind, set trọn bộ
  **timezone + geolocation (lat/long) + locale + WebRTC IP** khớp IP proxy ngay
  trong engine. Chính xác hơn `language` nên thay nó. Không proxy thì bỏ qua (tránh
  key theo IP thật của máy).
- **geolocation**: `prompt` | `allow` | `disabled` — quyền `navigator.geolocation`:
  `prompt` hỏi (mặc định Firefox), `allow` cấp im lặng (vị trí lấy từ geoip),
  `disabled` tắt hẳn API. Set qua `firefox_user_prefs`.
- **maskMediaDevices**: `true` | `false` — khi bật, set `mediaDevices:enabled=false`
  nên `navigator.mediaDevices.enumerateDevices()` trả rỗng (giấu camera/mic/loa).
  Tắt nếu profile cần video/voice call thật.
- **screen**: `real` | `"WIDTHxHEIGHT"` — `real` để Camoufox chọn độ phân giải nhất
  quán với OS; chuỗi `"1920x1080"`... constrain bộ sinh fingerprint (`screen`
  min=max cả 2 chiều) nên `screen.width/height` **và** `availWidth/availHeight` đều
  báo đúng độ phân giải đó (option `window` chỉ chỉnh kích thước cửa sổ, để
  `screen.*` ở kích thước màn hình thật — một mismatch fingerprinter bắt được).

WebGL vendor/renderer **để Camoufox tự sample** theo OS (có biến thiên giữa các
profile) — ép cùng một cặp cho cả fleet khiến mọi profile trông giống hệt nhau,
tự nó là một tín hiệu gom nhóm.

Một số knob các antidetect Chromium (GoLogin/AdsPower) hay phơi ra thì **không**
áp dụng cho Camoufox (Firefox), UI hiện nhưng disable kèm ghi chú:
- **Canvas / WebGL image / Audio** (Noise/Real/Block) — Camoufox tự noise theo
  `seed` ổn định mỗi profile ngay trong engine, không expose mode chỉnh tay.
- **Font** (Masked/Real) — Camoufox **luôn** inject bộ font theo OS (573 font cho
  mac) + `fonts:spacing_seed`, tức luôn "Masked"; "Real" = leak font máy thật = phá
  ẩn danh.
- **Client rect**, **Hardware concurrency** — engine tự sinh nhất quán theo OS;
  set tay bị Camoufox cảnh báo là dễ lộ hơn.
- **Trình duyệt Chrome / browser version kiểu Chrome / đổi User-Agent tay** — engine
  là Firefox: `checkCustomFingerprint` **ném lỗi** nếu UA không phải Firefox (non-
  Firefox fingerprint chắc chắn bị phát hiện). Camoufox chỉ có `ff_version`, mặc định
  theo binary đã cài; UA tự sinh coherent theo OS.
- **Mac: Apple Chip vs Intel** — `SUPPORTED_OS` chỉ có `macos`, không tách kiến trúc.
- **Memory devices** (`navigator.deviceMemory`), **Bluetooth**, **MAC address**,
  **Device name** — API riêng Chromium hoặc Firefox/JS không expose, không có knob.

GeoIP dùng DB `GeoLite2-City.mmdb` (~60MB). Docker bake sẵn vào image; chạy local
lần đầu geoip bật sẽ tự tải vào `CAMOUFOX_INSTALL_DIR` (mặc định `~/.cache/camoufox`).

Mỗi profile có `seed` ổn định để fingerprint nhất quán qua các lần chạy.

## Proxy — 3 chế độ xoay

Mỗi profile chọn nguồn proxy qua `proxyRotation.mode`. Nếu profile không có
`proxyRotation` (hồ sơ cũ) thì coi như `static` — hành vi giữ nguyên như trước.

- **static** — ghim đúng `profile.proxy` như cũ. Không đụng tới thư viện proxy.
- **pool** — bốc **ngẫu nhiên** một proxy từ thư viện `ProxyStore`, lọc theo `tags`
  và chỉ lấy proxy Live (`liveOnly`, mặc định bật). Proxy đã bốc được ghi lại vào
  `profile.proxy` + `assignedProxyId` nên bền qua restart và hiển thị được trên UI.
  - `rotateOnOpen` — bốc proxy mới **mỗi lần mở**; tắt thì giữ proxy đã gán.
  - `rotateOnFailure` — recheck proxy trước khi launch; nếu chết thì đánh dấu Dead
    và bốc con khác (tối đa 3 lần).
- **gateway** — giữ một endpoint xoay cố định (nhà cung cấp tự đổi egress IP mỗi
  session). Xoay = mở lại session để lấy IP mới.

Trigger xoay: **mỗi lần mở** (nếu `rotateOnOpen`), **khi proxy chết/lỗi** (nếu
`rotateOnFailure`), và **thủ công** qua nút ↻ trên UI / endpoint `rotate-proxy`.
Xoay lúc profile đang mở sẽ tự **close + reopen** để áp IP mới ngay. Nếu pool cạn
proxy Live khớp bộ lọc, hệ thống **từ chối mở** và báo lỗi (không đi trực tiếp làm
lộ IP thật).

## HTTP API

### Proxy
- `GET    /api/proxies?q=` — liệt kê (lọc theo từ khóa)
- `POST   /api/proxies` — tạo một hoặc nhiều (`{type,host,port,...}` hoặc `{type,lines,tags}`)
- `PUT    /api/proxies/:id` — sửa
- `DELETE /api/proxies/:id` — xóa
- `POST   /api/proxies/:id/check` — kiểm tra một proxy
- `POST   /api/proxies/check-all` — kiểm tra tất cả (đồng thời có giới hạn)

### Profile
- `GET    /api/profiles` — liệt kê
- `GET    /api/profiles/running` — danh sách id profile đang mở *(đăng ký trước `:id`)*
- `GET    /api/profiles/:id` — chi tiết
- `POST   /api/profiles` — tạo
- `PUT    /api/profiles/:id` — cập nhật (merge `antiDetect`/`browser`/`proxyRotation` để PATCH một phần)
- `DELETE /api/profiles/:id?wipeData=true` — xóa (kèm xóa session nếu `wipeData`)
- `POST   /api/profiles/:id/open` — mở `BrowserContext` (idempotent)
- `POST   /api/profiles/:id/close` — đóng, flush session xuống đĩa
- `POST   /api/profiles/:id/rotate-proxy` — xoay proxy thủ công (pool: bốc mới;
  gateway: session mới). Nếu đang mở thì close+reopen để áp IP mới ngay. Trả 400
  nếu mode `static` hoặc pool cạn proxy Live.

### Mail (dongvanfb)
- `GET    /api/settings` — trạng thái API key (`{hasKey, masked}` — **không** trả nguyên văn)
- `PUT    /api/settings` — đặt API key (`{dongvanfbApiKey}`)
- `GET    /api/mail/balance` — số dư tài khoản (cần key; 400 nếu chưa cấu hình)
- `POST   /api/mail/buy` — mua mail (`{accountType,quality}`, **tốn tiền**), tự nạp vào kho
- `GET    /api/mails` — liệt kê kho mail
- `POST   /api/mails` — thêm thủ công (`{line}` dạng `email|pass|refresh|client`, hoặc field rời)
- `DELETE /api/mails/:id` — xóa mail
- `POST   /api/mails/:id/code` — lấy OTP cho mail đã lưu (`{type}`); thử OAuth2 trước, fallback Graph
- `POST   /api/mails/:id/messages` — xem hộp thư (list message)
- `POST   /api/mail/code` — lấy OTP ad-hoc (`{email,refresh_token,client_id,type}`, không cần lưu mail)

Endpoint đọc mail / lấy code (`tools.dongvanfb.net`) **không** cần API key — chỉ
cần bộ `email+refresh_token+client_id`. Chỉ `balance`/`buy` (`api.dongvanfb.net`)
dùng key đã lưu.

### Automation (flow + project)
- `GET    /api/flows` — metadata các flow đã đăng ký (cho dropdown)
- `GET    /api/projects` — liệt kê project
- `GET    /api/projects/:id` — chi tiết
- `POST   /api/projects` — tạo (`{name, flowName, profileIds?, mailId?, concurrency?}`)
- `PUT    /api/projects/:id` — cập nhật
- `DELETE /api/projects/:id` — xóa
- `POST   /api/projects/:id/run` — chạy flow trên các profile (headful, đồng bộ),
  trả `{results:[{profileId, ok, error?}]}` per-profile

## Web UI

Bản desktop có năm tab: **Quản lý proxy**, **Hồ sơ**, **Mail**, **Project** và
**Công việc**. Tab Công việc quản lý nhân viên theo Telegram Forum Topic, giao
task, tính sản lượng và tiền công khi đúng nhân viên thả ❤️.

Mỗi nhân viên có đơn giá mặc định; task chụp lại đơn giá lúc gửi nên việc đổi giá
sau này không làm thay đổi task cũ. Reaction được xử lý tuần tự và lưu
`update_id`, vì vậy Telegram retry webhook không cộng tiền lần hai.

Thiết lập nhanh:

1. Thêm bot làm Administrator của Supergroup và cấp quyền quản lý topic.
2. Trong **Công việc → Telegram**, nhập bot token riêng + chat id `-100...`.
3. Bản Windows chạy local chọn **Polling**; server có HTTPS công khai có thể đăng
   ký webhook ngay trong UI.
4. Tạo nhân viên rồi cho nhân viên gửi `/bind MÃ` trong đúng topic. App cũng có
   thể tự tạo topic bằng nút **Tạo topic**.
5. Giao task với số lượng/đơn giá. Khi nhân viên thả ❤️, bot xác nhận và trả tổng
   số lượng + tiền ngày/tháng; bỏ tim sẽ trừ lại khoản đang ghi nhận.

Trong flow `capcut-signin`, bật **Tự phân phối link CapCut** để đặt quota theo
nhân viên (ví dụ Duy 10, Tài 5, Phong 8). Tổng quota tự trở thành số profile tạm
cần chạy. Mỗi kết quả thành công được gửi round-robin vào topic nhân viên với đủ
email, password, mail full và checkout link. Link nằm trong hàng chờ khi bấm
**Tạm dừng gửi**; flow Camoufox vẫn tiếp tục, và chỉ reaction ❤️ mới tính 1 con
vào bảng công. Hàng chờ được lưu trong `telegram-work.json`, có thể resume/retry
sau khi app khởi động lại.

Pipeline `.gitlab-ci.yml` tự typecheck, test và build Electron target Windows
bằng Wine. File `.exe` được lưu trong GitLab Job Artifacts trên mỗi push `main`,
Merge Request, tag hoặc khi chạy pipeline thủ công.

Tab Hồ sơ (master-detail):
- Danh sách bên trái: mỗi hồ sơ có chấm trạng thái (xanh = đang chạy) và nút **Mở/Đóng**.
- Panel cấu hình bên phải: đổi tên hồ sơ (input, lưu khi blur/Enter), nút Mở/Đóng,
  toggle browser-trigger, URL khởi động, start parameters, bookmarks, và các
  segmented control anti-detect (OS đồng bộ / WebRTC / Language) — tất cả autosave.
- Nút **+ Tạo hồ sơ** mở modal lớn với panel tóm tắt fingerprint bên phải; trong đó
  "Chọn từ thư viện proxy" tải lại dropdown proxy, "Kiểm tra proxy" check proxy
  đang chọn server-side.
- Trong panel còn có mục **Lấy OTP từ mail**: chọn mail từ kho + dịch vụ
  (facebook/google/…) → lấy code ngay, không cần rời tab Hồ sơ.

Tab Mail:
- Cột trái: ô **API key dongvanfb** (lưu qua `/api/settings`, chỉ hiện masked),
  nút **Xem số dư**, form **Mua mail** (account_type/quality, xác nhận trước khi
  tốn tiền), và ô **Thêm mail thủ công** (dán `email|password|refresh|client`).
- Cột phải: bảng kho mail — mỗi dòng có nút **Lấy code** (chọn dịch vụ) và
  **Hộp thư** (mở modal, nội dung HTML render trong `<iframe sandbox>` chống XSS).

Tab Project (master-detail, chạy automation hàng loạt):
- Trái: danh sách project + nút **+ Tạo project**.
- Phải: chọn **flow** (dropdown từ `/api/flows`), tick **profiles** để chạy, gán
  **mail** (tùy chọn, cho bước OTP), đặt **số luồng song song** (mặc định 2), ghi
  chú — tất cả autosave. Nút **Chạy** mở cửa sổ Camoufox thật (headful) cho từng
  profile, chạy flow, rồi hiện bảng kết quả ✓/✗ per-profile (lỗi một profile không
  kéo đổ cả batch).
- Thêm automation mới = viết một file trong [src/flows/](src/flows/) export
  `RegisteredFlow` rồi đăng ký một dòng trong [src/flows/index.ts](src/flows/index.ts).
  Flow dùng `PageHelper` (goto/click/fill/type/waitFor/getOtp/screenshot…) để lái
  `page`; không cần đụng engine hay UI.

## Giới hạn hiện tại / TODO

- **Chưa có xác thực** trên API. Phù hợp chạy local; nếu expose ra mạng cần thêm lớp auth.
- Cookies nhập trong modal hiện chỉ lưu vào `notes` (chưa nạp tự động vào profile).
- **Mail**: mới lấy code/đọc mail thủ công. Chưa tự bơm OTP vào form web đang mở
  trong profile (automation điền code) — để lần sau. `mail-domain` endpoints (tạo
  domain riêng) cũng chưa làm.
- **Automation**: mới là *khung* — flow viết bằng code TS trong `src/flows/`,
  chạy đồng bộ (đợi xong mới trả), chưa có trình soạn flow trong UI, chưa theo dõi
  tiến độ realtime, và mỗi project gán tối đa 1 mail. Thêm tác vụ mới = viết một
  file flow + đăng ký một dòng ở [src/flows/index.ts](src/flows/index.ts).
- `npm run dev` (demo CLI) và việc mở/đóng qua web UI đã chạy thật headful trên
  local với Camoufox. Chế độ `virtual` trong Docker đã được kiểm thử khi build image.

## Proxy từ mktproxy.com (nguồn dạng API)

Tool tích hợp mua/dùng proxy từ [mktproxy.com](https://mktproxy.com) (`https://api.mktproxy.com/api`).
Client: [src/mktproxyClient.ts](src/mktproxyClient.ts); route: `/api/mktproxy/*` +
proxy dạng API trong [src/proxyStore.ts](src/proxyStore.ts) (`apiProvider`/`apiKey`).

### HAI loại key — KHÁC nhau, đừng nhầm

| Key | Dạng | Gửi qua | Dùng cho |
|-----|------|---------|----------|
| **Key SERVER** (tài khoản) | `mkt_...` | header `X-API-Key` | `GET /balance`, `POST /buy-proxy`, `GET /orders`, **header** của `POST /update-ip-whitelist`. Lấy ở mktproxy.com → **Profile**. |
| **Key PROXY** (theo đơn) | hex 24 ký tự `6a4a...` | query/body `key` (KHÔNG header) | `GET /proxies/new`, `GET /proxies/current`, `POST /proxies/rotate-ip`, và `key` trong **body** của `/update-ip-whitelist`. Mỗi đơn proxy xoay có key riêng — đây chính là "proxy" để gen IP. |

Trong UI: **key SERVER** nhập ở card "Mua proxy" (để mua + xem số dư); **key PROXY**
nhập ở "Thêm mới → API (mktproxy)" (tạo một entry proxy dạng **API** trong thư viện).

### Proxy xoay `auth_type = ip_whitelist` — flow đúng (đã xác minh bằng gọi API thật)

Loại "Proxy Rotate VN" là **HTTP** (`protocol: "http"`), **không user/pass**, auth theo
**IP nguồn**. Muốn dùng được:

1. **Whitelist IP máy**: `POST /update-ip-whitelist` với header `X-API-Key = key SERVER`
   và body `{ key: <key PROXY>, ip_whitelist: [<IP công khai của máy>] }`.
2. **Kích hoạt egress**: `POST /proxies/rotate-ip { key: <key PROXY> }`. (Chỉ gọi
   `proxies/new` là đọc cache → đơn chưa "live" → connect bị **ECONNRESET**. Trong
   cooldown 60s, `rotate-ip` trả proxy hiện tại nên gọi lại vô hại.)
3. **Connect** gateway `host:port` (protocol theo field `protocol`, thường **HTTP**,
   không creds) **TỪ IP đã whitelist**.

Tool tự làm 1→2 mỗi lần **Test** hoặc mua proxy API; lưu proxy theo đúng protocol NCC
trả. Vì auth theo IP, **cần key SERVER hợp lệ** trong cài đặt để whitelist; nếu chỉ có
key PROXY thì không whitelist được (báo `Invalid API key`).
