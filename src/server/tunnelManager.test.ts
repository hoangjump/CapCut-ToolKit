import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SettingsStore } from '../settingsStore.js';
import { parseQuickTunnelUrl, TunnelManager } from './tunnelManager.js';

test('quick tunnel URL is extracted from cloudflared logs', () => {
  assert.equal(
    parseQuickTunnelUrl('request=https://api.trycloudflare.com INF Visit https://quiet-river.trycloudflare.com'),
    'https://quiet-river.trycloudflare.com',
  );
  assert.equal(parseQuickTunnelUrl('request=https://api.trycloudflare.com'), undefined);
  assert.equal(parseQuickTunnelUrl('still starting'), undefined);
});

test('tunnel manager publishes and clears the runtime payment URL', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tunnel-manager-test-'));
  const executable = join(root, 'fake-cloudflared');
  const previous = process.env.CLOUDFLARED_PATH;
  try {
    await writeFile(executable, [
      '#!/usr/bin/env node',
      "if (!process.argv.includes('--protocol') || !process.argv.includes('http2')) process.exit(2);",
      "process.stderr.write('request=https://api.trycloudflare.com\\n');",
      "process.stderr.write('Visit https://worker-pay.trycloudflare.com\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n'), 'utf8');
    await chmod(executable, 0o755);
    process.env.CLOUDFLARED_PATH = executable;
    const settings = new SettingsStore(root);
    await settings.init();
    let probeAttempts = 0;
    const tunnel = new TunnelManager(settings, async (url) => {
      probeAttempts += 1;
      assert.equal(url, 'https://worker-pay.trycloudflare.com');
      return probeAttempts >= 2;
    });
    tunnel.setOrigin('http://127.0.0.1:3000');

    const online = await tunnel.start(false);
    assert.equal(online.state, 'online');
    assert.equal(online.publicUrl, 'https://worker-pay.trycloudflare.com');
    assert.equal(probeAttempts, 2);
    assert.equal(settings.getPaymentPublicUrl(), online.publicUrl);

    const stopped = await tunnel.stop(false);
    assert.equal(stopped.state, 'off');
    assert.equal(settings.getPaymentPublicUrl(), undefined);
  } finally {
    if (previous === undefined) delete process.env.CLOUDFLARED_PATH;
    else process.env.CLOUDFLARED_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});
