import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  ORDERING,
  REPORT_STATUSES,
  STEPS,
  TIMING,
  ACCOUNT_PASSWORD,
  ANTI_DETECT_OVERRIDE,
  PROMO_URL,
  ENTRY_URL,
} from './chatgpt-signup.contract.js';
import { PASSWORD } from './chatgpt-signup.js';

const here = dirname(fileURLToPath(import.meta.url));
const flowSource = await readFile(join(here, 'chatgpt-signup.ts'), 'utf8');

test('contract is internally consistent', () => {
  const ids = STEPS.map((step) => step.id);
  assert.equal(new Set(ids).size, ids.length, 'id của bước phải là duy nhất');

  for (const rule of ORDERING) {
    assert.ok(ids.includes(rule.before), `ORDERING trỏ tới bước không tồn tại: ${rule.before}`);
    assert.ok(ids.includes(rule.after), `ORDERING trỏ tới bước không tồn tại: ${rule.after}`);
    assert.ok(
      ids.indexOf(rule.before) < ids.indexOf(rule.after),
      `STEPS đang xếp "${rule.before}" SAU "${rule.after}", trái với ORDERING`,
    );
  }

  // Bước nào ném lỗi thì phải nói rõ chụp ảnh nào — nếu không người vận hành
  // không biết mở file nào ra xem.
  for (const step of STEPS) {
    if (step.onMissing === 'throw' && step.timeoutMs > 0) {
      assert.ok(step.shotOnFail, `bước "${step.id}" ném lỗi nhưng không khai shotOnFail`);
    }
  }
});

test('contract cannot drift from the flow it describes', () => {
  // Mật khẩu import thẳng, không chép.
  assert.equal(ACCOUNT_PASSWORD, PASSWORD);

  // Các con số trong đặc tả phải khớp mã nguồn thật.
  assert.match(flowSource, /intervalMs: 3_000, tries: 60/, 'waitCode đã đổi — cập nhật TIMING.waitCode');
  assert.equal(TIMING.waitCode.tries, 60);
  assert.equal(TIMING.waitCode.intervalMs, 3_000);

  assert.match(flowSource, /tries: 24, intervalMs: 3_000/, 'nextCode đã đổi — cập nhật TIMING.nextCode');
  assert.equal(TIMING.nextCode.tries, 24);

  assert.match(flowSource, /attempt <= 3/, 'số lần nhập lại code đã đổi');
  assert.equal(TIMING.codeAttempts, 3);

  assert.match(flowSource, /i < 5; i \+= 1/, 'số màn chào Continue đã đổi');
  assert.equal(TIMING.welcomeContinues, 5);

  assert.match(flowSource, /payDeadline = Date\.now\(\) \+ 45_000/, 'thời gian quét link iDEAL đã đổi');
  assert.equal(TIMING.idealLinkScanMs, 45_000);

  assert.match(flowSource, /randInt\(2_500, 3_200\)/, 'độ trễ panel iDEAL đã đổi');
  assert.equal(TIMING.idealPanelDelayMs.min, 2_500);
  assert.equal(TIMING.idealPanelDelayMs.max, 3_200);

  assert.ok(flowSource.includes(ENTRY_URL), 'URL vào đã đổi');
  assert.ok(flowSource.includes(PROMO_URL), 'URL khuyến mãi đã đổi');
});

test('contract lists every status the flow can actually report', () => {
  const emitted = [...flowSource.matchAll(/status: '([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(emitted.length > 0, 'không tìm thấy report(status) nào trong flow');

  const declared = new Set(REPORT_STATUSES.map((row) => row.status));
  for (const status of new Set(emitted)) {
    assert.ok(declared.has(status), `flow báo status "${status}" nhưng đặc tả không khai`);
  }
  for (const row of REPORT_STATUSES) {
    assert.ok(emitted.includes(row.status), `đặc tả khai status "${row.status}" nhưng flow không bao giờ báo`);
  }
});

test('the anti-detect override the contract promises is the one the runner applies', async () => {
  const routes = await readFile(join(here, '..', 'server', 'routes', 'projects.ts'), 'utf8');
  const line = routes.split('\n').find((l) => l.includes("chatgpt-signup'") && l.includes('geoip'))
    ?? routes.split('\n').find((l) => l.includes('geoip: false'));
  assert.ok(line, 'không thấy chỗ runner ép anti-detect cho chatgpt-signup');
  assert.equal(ANTI_DETECT_OVERRIDE.geoip, false);
  assert.match(line, /geoip: false/);
  assert.match(line, /language: 'real'/);
});
