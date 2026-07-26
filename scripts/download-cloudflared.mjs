import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'vendor', 'cloudflared', 'cloudflared.exe');
const downloadUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

if (existsSync(target) && (await stat(target)).size > 1_000_000) {
  console.log(`cloudflared.exe đã có: ${target}`);
  process.exit(0);
}

await mkdir(dirname(target), { recursive: true });
console.log('Đang tải cloudflared.exe từ Cloudflare...');
const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(120_000) });
if (!response.ok) throw new Error(`Tải cloudflared lỗi HTTP ${response.status}`);
const temporary = `${target}.download`;
await writeFile(temporary, Buffer.from(await response.arrayBuffer()));
await rename(temporary, target);
console.log(`Đã tải cloudflared.exe: ${target}`);
