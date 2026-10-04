# CapCut Auto (CLI)

Một lệnh làm hết: **mua mail → đăng ký CapCut → join team → check VIP / trial / credit**.

## Cài đặt (1 lần)

Yêu cầu **Node.js 20+** (https://nodejs.org).

```bash
cd capcut-checker
npm run setup          # npm install + tải Chromium cho Playwright
cp config.example.json config.json
```

Mở `config.json` điền:

| Khoá | Ý nghĩa |
|---|---|
| `mailProvider` | `stk` = Selltaikhoan, `dvfb` = Dongvanfb |
| `stkApiKey`, `stkProduct` | Key + ID sản phẩm Selltaikhoan |
| `dvfbApiKey`, `dvfbProduct` | Key + `account_type` Dongvanfb (VD `1` Hotmail NEW, `5` Hotmail TRUSTED) |
| `teamInviteLink` | Link mời team `https://www.capcut.com/sv2/...` (để trống = không join) |
| `proxyKeys` | Key MKTProxy, nhiều key phẩy ngăn cách (để trống = chạy direct) |
| `rotateEach` | `true` = xoay IP mỗi account |
| `delayMs` | Nghỉ giữa mỗi account (ms) |
| `count` | Số account mặc định khi chạy không truyền số |

Sản phẩm mail phải là loại **OAuth2** (có `refresh_token|client_id`) để tool tự đọc OTP.

## Chạy

```bash
node index.js 5                 # mua 5 mail → đăng ký → join → check
node index.js                   # như trên, số lượng lấy từ "count" trong config.json
node index.js --file=list.txt   # chạy từ danh sách có sẵn
node index.js --balance         # xem số dư nguồn mail
node index.js --products        # liệt kê sản phẩm mail để lấy ID
node index.js --help
```

Tuỳ chọn thêm: `--provider=stk|dvfb` (đổi nguồn mail cho lần chạy này), `--no-join` (bỏ bước join).

`--file`: mỗi dòng một account, tool tự nhận dạng:

```
email|pass                            → login → join → check
email|pass|refresh_token|client_id    → đăng ký mới → join → check
```

Nên có thể chạy lại những mail đã mua mà đăng ký lỗi bằng `--file=accounts.txt` (sửa file chỉ giữ dòng cần chạy).

`Ctrl+C` một lần = dừng sau account đang chạy; bấm lần hai = thoát ngay.

## Kết quả

- Cuối mỗi lần chạy in danh sách `email|pass` các account OK để copy.
- `results.txt` (ghi nối thêm, không xoá kết quả cũ): `email|pass|uid|vip|trial|credit|joined`
  — dòng lỗi có `ERROR:<lý do>` ở cột uid.
- `accounts.txt`: mọi mail đã mua `email|pass_mail|refresh_token|client_id` (giữ lại phòng khi đăng ký lỗi).

`pass` trong kết quả là **mật khẩu CapCut** (tool tự sinh khi đăng ký), không phải mật khẩu mail.

## Lỗi thường gặp

| Lỗi | Cách xử lý |
|---|---|
| `Executable doesn't exist` | `npx playwright install chromium` |
| `Chưa có API key …` / `Chưa có ID sản phẩm …` | Điền vào `config.json`; xem ID bằng `--products` |
| `Mua mail thất bại … — dừng` | Hết tiền hoặc hết kho: `--balance`, `--products` |
| `không có refresh_token/client_id` | Chọn sản phẩm mail loại OAuth2 |
| `Không nhận được OTP sau 90s` | Mail chết/chậm — chạy lại mail đó bằng `--file` |
| `joined=NO` | Link mời hết hạn / team đầy; log dòng `join:` in các nút đang có trên trang |

Không gửi `config.json`, `accounts.txt`, `results.txt` cho người khác — chứa key và tài khoản.
