#!/usr/bin/env node
// Rebuild native addons TỪ NGUỒN theo headers của Electron đang dùng, để module
// chạy đúng ABI trong app đóng gói. Vì electron-builder được đặt npmRebuild:false
// (nó hay tải prebuilt sai ABI đè lên), bước này là nơi bảo đảm ABI đúng.
//
// GỐC RỄ: camoufox-js phụ thuộc better-sqlite3 (dùng ở dist/webgl/sample.js khi
// launch Camoufox). npm install kéo prebuilt build cho Node hệ thống
// (NODE_MODULE_VERSION của Node máy) — KHÁC ABI Electron → app đóng gói nạp là
// crash "compiled against a different Node.js version" và cửa sổ Camoufox không
// mở. Build từ nguồn với headers Electron ra addon nạp được dưới Electron (và
// vẫn nạp được dưới Node cho test/dev).
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/** Version Electron đang cài (để lấy đúng headers/ABI). */
function electronVersion() {
  return require('electron/package.json').version;
}

/** Các addon native cần build lại. Hiện chỉ better-sqlite3 (qua camoufox-js). */
const MODULES = ['better-sqlite3'];

const target = electronVersion();
const arch = process.arch;
console.log(`[rebuild-native] Electron ${target} (${arch}) — build từ nguồn theo headers Electron`);

for (const name of MODULES) {
  let pkgDir;
  try {
    pkgDir = dirname(require.resolve(`${name}/package.json`));
  } catch {
    console.warn(`[rebuild-native] bỏ qua ${name}: không tìm thấy trong node_modules`);
    continue;
  }
  if (!existsSync(join(pkgDir, 'binding.gyp'))) {
    console.warn(`[rebuild-native] bỏ qua ${name}: không có binding.gyp`);
    continue;
  }
  console.log(`[rebuild-native] ${name} …`);
  execFileSync(
    process.execPath,
    [
      require.resolve('node-gyp/bin/node-gyp.js'),
      'rebuild',
      `--target=${target}`,
      `--arch=${arch}`,
      '--dist-url=https://electronjs.org/headers',
    ],
    { cwd: pkgDir, stdio: 'inherit' },
  );
}
console.log('[rebuild-native] xong');
