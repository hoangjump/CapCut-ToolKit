# Base image của Playwright chỉ dùng làm NỀN system lib: nó đã kèm Xvfb, fonts và
# mọi thư viện đồ họa mà Firefox/Camoufox cần để chạy headful trong container.
# Engine thật KHÔNG phải Chromium bundled của image — ta fetch binary Camoufox
# (Firefox đã vá) riêng vào /opt/camoufox bên dưới, nên tag image không cần khớp
# version playwright nữa; nó chỉ cung cấp system deps.
FROM mcr.microsoft.com/playwright:v1.53.1-noble

WORKDIR /app

# Camoufox binary tải về thư mục cố định này (thay vì ~/.cache vốn vô định trong
# container). Server cũng đọc lại từ đây ở runtime nhờ cùng biến môi trường.
ENV CAMOUFOX_INSTALL_DIR=/opt/camoufox

# Cài full deps (gồm devDeps: tsc/tsx) trước để tận dụng layer cache.
COPY package.json package-lock.json* ./
RUN npm ci

# Tải binary Camoufox (~150MB) vào /opt/camoufox, bake thẳng vào image để
# container khởi động là chạy được ngay, không cần tải lúc runtime.
RUN npx camoufox-js fetch

# Bake sẵn GeoLite2-City.mmdb (~60MB) cho tính năng geoip (timezone + geo +
# locale theo IP proxy). `camoufox-js fetch` có gọi downloadMMDB() nhưng KHÔNG
# await nó (race), nên gọi lại một bước await'd riêng để chắc chắn mmdb nằm trong
# image — geoip lúc runtime đọc lại từ /opt/camoufox, không tải lại qua mạng.
RUN node --input-type=module -e "import { downloadMMDB } from 'camoufox-js/dist/locale.js'; await downloadMMDB();"

# Build TypeScript -> dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Build React UI, gồm trang /pay/:token hiển thị luồng ảnh cho nhân viên.
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci
COPY web ./web
RUN npm --prefix web run build && rm -rf web/node_modules

# Bỏ devDependencies sau khi đã build xong để image gọn hơn. camoufox-js là
# dependency thường nên vẫn còn lại sau prune.
RUN npm prune --omit=dev

# UI cũ vẫn được giữ làm fallback nếu web/dist không tồn tại.
COPY public ./public

# Store (proxy list + session/cookie) sống trong volume này.
ENV NODE_ENV=production
ENV STORE_ROOT=/data
VOLUME ["/data"]

EXPOSE 3000
# NODE_ENV=production khiến server mặc định chạy HEADLESS=virtual: Camoufox chạy
# headful thật bên trong một màn hình ảo Xvfb (camoufox-js tự spawn Xvfb). Đây là
# chế độ khó bị phát hiện hơn headless thuần của Firefox.
CMD ["node", "dist/server/index.js"]
