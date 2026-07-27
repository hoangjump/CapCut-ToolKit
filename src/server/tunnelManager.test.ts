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

test('tunnel manager supports verified quick and named tunnels', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tunnel-manager-test-'));
  const executable = join(root, 'fake-cloudflared');
  const previous = process.env.CLOUDFLARED_PATH;
  try {
    await writeFile(executable, [
      '#!/usr/bin/env node',
      "const { readFileSync } = require('node:fs');",
      "if (process.argv.includes('--protocol')) process.exit(2);",
      "const configIndex = process.argv.indexOf('--config');",
      "if (configIndex < 0 || readFileSync(process.argv[configIndex + 1], 'utf8').trim() !== 'loglevel: info') process.exit(2);",
      "if (!process.argv.includes('--edge-ip-version') || !process.argv.includes('4')) process.exit(2);",
      "const urlIndex = process.argv.indexOf('--url');",
      "if (urlIndex < 0 || process.argv[urlIndex + 1] !== 'http://127.0.0.1:3000') process.exit(2);",
      "const named = process.argv.includes('run');",
      "if (named && (process.env.TUNNEL_TOKEN !== 'test-tunnel-token' || process.argv.includes('test-tunnel-token'))) process.exit(2);",
      "if (!named) process.stderr.write('request=https://api.trycloudflare.com\\nVisit https://worker-pay.trycloudflare.com\\n');",
      "setTimeout(() => process.stderr.write('INF Registered tunnel connection connIndex=0 protocol=quic\\n'), 20);",
      'setInterval(() => {}, 1000);',
    ].join('\n'), 'utf8');
    await chmod(executable, 0o755);
    process.env.CLOUDFLARED_PATH = executable;
    const settings = new SettingsStore(root);
    await settings.init();
    let expectedUrl = 'https://worker-pay.trycloudflare.com';
    let probeAttempts = 0;
    const tunnel = new TunnelManager(settings, async (url) => {
      probeAttempts += 1;
      assert.equal(url, expectedUrl);
      return probeAttempts >= 2;
    });
    tunnel.setOrigin('http://127.0.0.1:3000');

    const online = await tunnel.start(false);
    assert.equal(online.state, 'online');
    assert.equal(online.mode, 'quick');
    assert.equal(online.originUrl, 'http://127.0.0.1:3000');
    assert.equal(online.publicUrl, 'https://worker-pay.trycloudflare.com');
    assert.equal(probeAttempts, 2);
    assert.equal(settings.getPaymentPublicUrl(), online.publicUrl);

    const stopped = await tunnel.stop(false);
    assert.equal(stopped.state, 'off');
    assert.equal(settings.getPaymentPublicUrl(), undefined);

    await settings.setPaymentTunnelToken('test-tunnel-token');
    await assert.rejects(tunnel.start(false), /nhập đủ Tunnel token và domain/);
    assert.equal(tunnel.status().state, 'error');
    await settings.setPaymentTunnelDomain('pay.example.com');
    expectedUrl = 'https://pay.example.com';
    probeAttempts = 0;
    const named = await tunnel.start(false);
    assert.equal(named.state, 'online');
    assert.equal(named.mode, 'named');
    assert.equal(named.publicUrl, expectedUrl);
    assert.equal(probeAttempts, 2);
    await tunnel.stop(false);
  } finally {
    if (previous === undefined) delete process.env.CLOUDFLARED_PATH;
    else process.env.CLOUDFLARED_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});
