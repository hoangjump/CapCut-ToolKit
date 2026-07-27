import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SettingsStore } from '../settingsStore.js';
import { createLogger } from '../logger.js';

const log = createLogger('cloudflared');
const START_TIMEOUT_MS = 45_000;
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

export type TunnelState = 'off' | 'starting' | 'online' | 'error';

export interface TunnelStatus {
  state: TunnelState;
  publicUrl: string;
  autoStart: boolean;
  error?: string;
}

export type TunnelProbe = (publicUrl: string) => Promise<boolean>;

async function defaultTunnelProbe(publicUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${publicUrl}/pay/health`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(3_000),
    });
    return response.status === 204;
  } catch {
    return false;
  }
}

export function parseQuickTunnelUrl(text: string): string | undefined {
  const matches = text.matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/gi);
  for (const match of matches) {
    if (match[1].toLowerCase() !== 'api') return match[0];
  }
  return undefined;
}

export class TunnelManager {
  private origin?: string;
  private child?: ChildProcess;
  private state: TunnelState = 'off';
  private publicUrl = '';
  private lastError?: string;
  private startPromise?: Promise<TunnelStatus>;
  private readonly expectedStops = new Set<ChildProcess>();

  constructor(
    private readonly settings: SettingsStore,
    private readonly probe: TunnelProbe = defaultTunnelProbe,
  ) {}

  setOrigin(origin: string, clearPublicUrl = false): void {
    this.origin = origin;
    if (clearPublicUrl) this.settings.setRuntimePaymentPublicUrl(null);
  }

  status(): TunnelStatus {
    return {
      state: this.state,
      publicUrl: this.publicUrl,
      autoStart: this.settings.getPaymentTunnelAutoStart(),
      error: this.lastError,
    };
  }

  async start(autoStart = true): Promise<TunnelStatus> {
    if (autoStart !== this.settings.getPaymentTunnelAutoStart()) {
      await this.settings.setPaymentTunnelAutoStart(autoStart);
    }
    if (this.state === 'online') return this.status();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.launch();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  async startIfEnabled(): Promise<void> {
    if (!this.settings.getPaymentTunnelAutoStart()) return;
    await this.start(true).catch((error) => {
      log.warn(`không bật được tunnel: ${(error as Error).message}`);
    });
  }

  async stop(disableAutoStart = true): Promise<TunnelStatus> {
    if (disableAutoStart && this.settings.getPaymentTunnelAutoStart()) {
      await this.settings.setPaymentTunnelAutoStart(false);
    }
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) {
      this.expectedStops.add(child);
      child.kill();
    }
    this.settings.setRuntimePaymentPublicUrl(null);
    this.publicUrl = '';
    this.lastError = undefined;
    this.state = 'off';
    return this.status();
  }

  async close(): Promise<void> {
    await this.stop(false);
  }

  private async launch(): Promise<TunnelStatus> {
    if (!this.origin) throw new Error('Server local chưa sẵn sàng');
    await this.stop(false);
    this.state = 'starting';
    this.lastError = undefined;
    this.settings.setRuntimePaymentPublicUrl(null);

    const executable = this.executable();
    const child = spawn(executable, [
      'tunnel',
      '--config',
      process.platform === 'win32' ? 'NUL' : '/dev/null',
      '--no-autoupdate',
      '--edge-ip-version',
      '4',
      '--url',
      this.origin,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    return new Promise<TunnelStatus>((resolve, reject) => {
      let settled = false;
      let verifying = false;
      let output = '';
      let quickTunnelUrl: string | undefined;
      let connectionRegistered = false;
      const timeout = setTimeout(() => {
        const detail = output.trim().split('\n').at(-1);
        const reason = connectionRegistered && quickTunnelUrl
          ? `Cloudflare Tunnel đã kết nối nhưng địa chỉ ${quickTunnelUrl} chưa chuyển tiếp được vào app`
          : connectionRegistered
            ? 'Cloudflare Tunnel đã kết nối nhưng chưa nhận được địa chỉ công khai'
          : detail
            ? `Cloudflare Tunnel chưa kết nối: ${detail}`
            : 'Cloudflare Tunnel khởi động quá 45 giây';
        const hint = connectionRegistered
          ? 'Hãy thử bật lại link nhân viên hoặc đổi mạng.'
          : 'Kiểm tra Windows Firewall hoặc mạng có chặn cloudflared/cổng 7844.';
        fail(new Error(`${reason}. ${hint}`));
      }, START_TIMEOUT_MS);
      timeout.unref?.();

      const finish = (url: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.publicUrl = url;
        this.settings.setRuntimePaymentPublicUrl(url);
        this.state = 'online';
        log.info(`link nhân viên: ${url}`);
        resolve(this.status());
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (child.exitCode === null) child.kill();
        this.child = undefined;
        this.settings.setRuntimePaymentPublicUrl(null);
        this.state = 'error';
        this.lastError = error.message;
        reject(error);
      };
      const verify = (url: string) => {
        if (settled || verifying) return;
        verifying = true;
        void (async () => {
          while (!settled && this.child === child && child.exitCode === null) {
            if (await this.probe(url)) {
              finish(url);
              return;
            }
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
          }
        })().catch((error) => fail(error as Error));
      };
      const read = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        output = `${output}${text}`.slice(-8_000);
        quickTunnelUrl ??= parseQuickTunnelUrl(output);
        connectionRegistered ||= /Registered tunnel connection/i.test(output);
        if (!quickTunnelUrl) return;
        verify(quickTunnelUrl);
      };

      child.stdout?.on('data', read);
      child.stderr?.on('data', read);
      child.once('error', (error) => {
        const hint = (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'Không tìm thấy cloudflared.exe trong bộ cài'
          : error.message;
        fail(new Error(hint));
      });
      child.once('close', (code) => {
        if (this.child === child) this.child = undefined;
        if (this.expectedStops.delete(child)) {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error('Cloudflare Tunnel đã dừng'));
          }
          return;
        }
        this.settings.setRuntimePaymentPublicUrl(null);
        this.publicUrl = '';
        if (!settled) {
          fail(new Error(output.trim().split('\n').at(-1) || `cloudflared đã dừng (${code ?? '?'})`));
          return;
        }
        this.state = 'error';
        this.lastError = `Cloudflare Tunnel đã dừng (${code ?? '?'})`;
      });
    });
  }

  private executable(): string {
    const configured = process.env.CLOUDFLARED_PATH?.trim();
    if (configured) return configured;
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const executableName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const candidates = [
      resourcesPath ? join(resourcesPath, 'cloudflared', executableName) : undefined,
      join(projectRoot, 'vendor', 'cloudflared', executableName),
    ].filter((value): value is string => Boolean(value));
    return candidates.find(existsSync) ?? executableName;
  }
}
