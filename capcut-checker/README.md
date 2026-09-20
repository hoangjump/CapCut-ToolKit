# CapCut Checker

Login hàng loạt tài khoản CapCut → xuất thông tin: VIP, trial, credits, benefits.

## Cài đặt (máy mới)

```bash
# 1. Copy thư mục capcut-checker vào máy

# 2. Cài dependencies + trình duyệt headless
npm install
npx playwright install chromium

# 3. Tạo file .env từ mẫu, điền key proxy (nếu có)
cp .env.example .env

# 4. Dán danh sách tài khoản vào accounts.txt (mỗi dòng: email|password)

# 5. Chạy
node index.js
```

## File .env

```env
MKT_API_KEY=mkt_xxxxxxxxxxxx
MKT_PROXY_KEYS=key1,key2,key3
DELAY_MS=3000
ROTATE_EACH=true
```

- `MKT_PROXY_KEYS`: nhiều key phẩy ngăn cách, script tự round-robin
- Không có proxy key → chạy direct (không qua proxy)

## Output

File `results.txt`, mỗi dòng:

```
email|pass|uid|YES/NO|YES/NO|credit_number|benefit_details
```
