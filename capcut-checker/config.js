/**
 * Cấu hình — 3 cách nhập (ưu tiên từ trên xuống):
 *
 * 1. Command line:  node index.js --mkt-proxy-keys=key1,key2,key3
 * 2. File .env:     tạo file .env cạnh index.js
 * 3. Sửa trực tiếp DEFAULT ở cuối file này
 *
 * Nhiều proxy key: phân cách bằng dấu phẩy, script tự round-robin.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));

// --- Parse .env ---
const envFile = resolve(__dir, '.env');
const env = {};
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
}

// --- Parse CLI args: --key=value ---
const cli = {};
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    if (eq > 2) {
      const key = arg.slice(2, eq).replace(/-/g, '_').toUpperCase();
      cli[key] = arg.slice(eq + 1);
    }
  }
}

function get(name, fallback = '') {
  return cli[name] ?? env[name] ?? fallback;
}

// ============ CONFIG ============

// API key TÀI KHOẢN mktproxy (dạng mkt_...)
export const MKT_API_KEY = get('MKT_API_KEY', '');

// Nhiều proxy key: phân cách bằng dấu phẩy
// Hỗ trợ cả tên cũ MKT_PROXY_KEY (1 key) lẫn MKT_PROXY_KEYS (nhiều key)
const rawKeys = get('MKT_PROXY_KEYS', '') || get('MKT_PROXY_KEY', '');
export const MKT_PROXY_KEYS = rawKeys
  .split(',')
  .map(k => k.trim())
  .filter(Boolean);

export const DELAY_MS = Number(get('DELAY_MS', '3000'));
export const ROTATE_EACH = get('ROTATE_EACH', 'true') !== 'false';
export const INPUT_FILE = resolve(__dir, get('INPUT_FILE', 'accounts.txt'));
export const OUTPUT_FILE = resolve(__dir, get('OUTPUT_FILE', 'results.txt'));
