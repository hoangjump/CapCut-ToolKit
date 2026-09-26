# CapCut Checker

Tool tự động cho CapCut: mua mail → đăng ký tài khoản → join team → check thông tin (VIP / trial / credit).

Có 2 cách chạy:

| Cách | File | Dùng khi |
|---|---|---|
| **Web UI** (khuyên dùng) | `server.js` | Bấm nút, xem log realtime, copy kết quả `email\|pass` |
| CLI | `index.js` | Chạy nền / cấu hình bằng `.env` |

---

## 1. Cài đặt trên máy mới

Yêu cầu: **Node.js 20+** (tải tại https://nodejs.org).

```bash
# Giải nén rồi vào thư mục
cd capcut-checker

# Cài thư viện + trình duyệt Chromium cho Playwright (~150MB, chỉ 1 lần)
npm install
npx playwright install chromium
```

Windows: mở **PowerShell** hoặc **CMD** tại thư mục rồi chạy y hệt.

---

## 2. Chạy Web UI

```bash
npm start
```

Mở trình duyệt vào **http://localhost:3456**

### Cấu hình (khung bên trái)

- **Nguồn mua mail**: chọn `Selltaikhoan` hoặc `Dongvanfb`, nhập API key + ID sản phẩm.
  Bấm **Xem DS sản phẩm** để liệt kê và click chọn ID; **Số dư** để kiểm tra tiền.
  - Selltaikhoan: key tại selltaikhoan.com → API
  - Dongvanfb: key tại dongvanfb.net (VD `1` = Hotmail NEW, `5` = Hotmail TRUSTED)
- **Link mời Team CapCut**: dạng `https://www.capcut.com/sv2/...` (bỏ trống = không join)
- **Proxy keys**: key MKTProxy, nhiều key phẩy ngăn cách (bỏ trống = chạy direct)
- **Delay / Xoay IP**: nghỉ giữa mỗi account, có xoay IP mỗi acc hay không
- Bấm **Lưu cấu hình** → lưu vào `config.json`

### Chạy

Chọn 1 trong 4 chế độ:

| Chế độ | Làm gì | Input |
|---|---|---|
| **Đăng ký mới** | Mua mail → đăng ký CapCut → join team → check | Số account cần mua |
| **Check + Join** | Login → join team → lấy info | Danh sách `email\|pass` |
| **Check info** | Login → lấy info | Danh sách `email\|pass` |
| **Join team** | Login → join team | Danh sách `email\|pass` |

Danh sách để trống → tự đọc `accounts.txt`.

### Kết quả

- Tab **Bảng**: email, UID, VIP, Trial, Credit, Joined
- Tab **Text**: mỗi dòng `email|password` — bấm **Copy email|pass** hoặc **Copy full**
- Tự ghi thêm vào `results.txt`: `email|pass|uid|VIP|Trial|credit|joined`
- Mail mua được ghi vào `accounts.txt`: `email|pass|refresh_token|client_id`

Đổi port: `PORT=8080 npm start`

---

## 3. Chạy CLI (tuỳ chọn)

```bash
cp .env.example .env     # điền key vào .env
node index.js
```

Xem chú thích từng biến trong `.env.example` (`MODE`, `COUNT`, `SELLTK_*`, `MKT_PROXY_KEYS`…).

---

## 4. Cấu trúc file

```
server.js       Web UI + API (mua mail, đăng ký, join, check)
ui.html         Giao diện web
index.js        Entry CLI
app.js          Logic CLI (đăng ký / check)
browser.js      Playwright: login CapCut, lấy info
capcut.js       Gọi API CapCut (passport, OTP…)
device.js       Sinh fingerprint thiết bị
proxy.js        Pool proxy MKTProxy, xoay IP
config.js       Đọc .env cho CLI
config.example.json   Mẫu cấu hình Web UI
.env.example          Mẫu cấu hình CLI
```

Các file **không** nên gửi cho người khác (chứa key / tài khoản): `config.json`, `.env`, `accounts.txt`, `results.txt`.

---

## 5. Lỗi thường gặp

| Lỗi | Cách xử lý |
|---|---|
| `Executable doesn't exist` / không mở được Chromium | Chạy lại `npx playwright install chromium` |
| `Chưa nhập API key …` | Nhập key đúng nguồn đang chọn, bấm Lưu cấu hình |
| `Mua mail thất bại` | Hết tiền / hết kho — bấm Số dư và Xem DS sản phẩm |
| Join team `joined=NO` | Kiểm tra link mời còn hạn, xem log dòng `join:` |
| Port 3456 đang bận | `PORT=3457 npm start` |
