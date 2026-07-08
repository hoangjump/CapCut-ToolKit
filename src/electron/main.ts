// PHẢI nạp camoufox-js TĨNH, NGAY ĐẦU process — trước mọi import khác. Nếu nó bị
// nạp muộn qua chuỗi await import() động (server → browserManager), mouse subsystem
// của engine chết cả process: mọi page.mouse.move/click ném "gBrowser ... ownerWindow
// is undefined", click rơi xuống synthetic (isTrusted:false) = tín hiệu bot. Chốt sau
// 23 lần probe: static-import đầu process = 10/10 OK, dynamic-import muộn = 5/5 throw.
import 'camoufox-js';
import { app, BrowserWindow, Menu, dialog, type MessageBoxOptions, type MenuItemConstructorOptions } from 'electron';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StartedServer } from '../server/index.js';
import { createLogger } from '../logger.js';

const log = createLogger('desktop');
const appName = 'TeamHatDe-Auto';
const appId = 'com.teamhatde.auto';

let mainWindow: BrowserWindow | null = null;
let server: StartedServer | null = null;

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const bootstrapFile = join(projectRoot, 'public', 'desktop-bootstrap.html');

function isValidStore(path: string): boolean {
  return existsSync(join(path, 'profiles.json'))
    || existsSync(join(path, 'projects.json'))
    || existsSync(join(path, 'settings.json'));
}

async function mergeJsonArrayFile(sourceFile: string, targetFile: string): Promise<void> {
  if (!existsSync(sourceFile)) return;
  if (!existsSync(targetFile)) {
    await cp(sourceFile, targetFile);
    return;
  }

  const [sourceRaw, targetRaw] = await Promise.all([
    readFile(sourceFile, 'utf8'),
    readFile(targetFile, 'utf8'),
  ]);
  const source = JSON.parse(sourceRaw) as Array<{ id?: string }>;
  const target = JSON.parse(targetRaw) as Array<{ id?: string }>;
  const seen = new Set(target.map((item) => item.id).filter(Boolean));
  const merged = [...target];
  for (const item of source) {
    if (item.id && seen.has(item.id)) continue;
    merged.push(item);
  }
  await writeFile(targetFile, JSON.stringify(merged, null, 2), 'utf8');
}

async function mergeLegacyStore(sourceStore: string, targetStore: string): Promise<void> {
  await mkdir(targetStore, { recursive: true });
  await mergeJsonArrayFile(join(sourceStore, 'profiles.json'), join(targetStore, 'profiles.json'));
  await mergeJsonArrayFile(join(sourceStore, 'projects.json'), join(targetStore, 'projects.json'));
  await mergeJsonArrayFile(join(sourceStore, 'proxies.json'), join(targetStore, 'proxies.json'));
  await mergeJsonArrayFile(join(sourceStore, 'mails.json'), join(targetStore, 'mails.json'));

  const sourceSettings = join(sourceStore, 'settings.json');
  const targetSettings = join(targetStore, 'settings.json');
  if (existsSync(sourceSettings) && !existsSync(targetSettings)) {
    await cp(sourceSettings, targetSettings);
  }

  for (const dir of ['data', 'shots']) {
    const sourceDir = join(sourceStore, dir);
    const targetDir = join(targetStore, dir);
    if (existsSync(sourceDir) && !existsSync(targetDir)) {
      await cp(sourceDir, targetDir, { recursive: true });
    }
  }
}

async function migrateLegacyStore(targetStore: string): Promise<void> {
  await mkdir(targetStore, { recursive: true });

  // CHỐT MIGRATE CHỈ CHẠY MỘT LẦN. Trước đây hàm này chạy MỖI lần mở app: nó merge
  // store cũ (capcut-auto/…) vào store hiện tại theo union id. Hậu quả: user xóa
  // 1 proxy/mail ở store mới, nhưng bản cũ vẫn còn record đó → lần mở sau nó được
  // THÊM LẠI (bug "xóa xong mở lại vẫn còn"). Dùng marker: migrate xong ghi file
  // đánh dấu, các lần sau thấy marker là bỏ qua hẳn, không đụng vào store nữa.
  const marker = join(targetStore, '.legacy-migrated');
  if (existsSync(marker)) return;

  const appSupportDir = dirname(app.getPath('userData'));
  const candidates = [
    process.env.STORE_ROOT,
    join(appSupportDir, 'capcut-auto', 'profiles-store'),
    join(appSupportDir, 'CapCut Auto', 'profiles-store'),
    join(process.cwd(), 'profiles-store'),
    join(dirname(process.execPath), 'profiles-store'),
    join(projectRoot, 'profiles-store'),
  ].filter((value): value is string => Boolean(value));

  const unique = [...new Set(candidates.map((candidate) => join(candidate)))];
  const matches = unique.filter((candidate) => candidate !== targetStore && isValidStore(candidate));
  if (matches.length !== 1) {
    if (matches.length > 1) {
      log.warn(`bỏ qua migrate profiles-store vì tìm thấy nhiều nguồn: ${matches.join(', ')}`);
    }
    // Không có nguồn hợp lệ (cài mới) hoặc nhiều nguồn mập mờ: vẫn ghi marker để
    // khỏi dò lại mỗi lần mở. Store mới bắt đầu trống, do người dùng tự quản.
    await writeFile(marker, new Date().toISOString(), 'utf8');
    return;
  }

  await mergeLegacyStore(matches[0], targetStore);
  await writeFile(marker, new Date().toISOString(), 'utf8');
  log.info(`merged profiles-store (một lần): ${matches[0]} -> ${targetStore}`);
}

function camoufoxInstalled(installDir: string): boolean {
  return existsSync(join(installDir, 'version.json'));
}

async function runCamoufoxFetch(): Promise<void> {
  const [{ CamoufoxFetcher }, { ALLOW_GEOIP, downloadMMDB }, { DefaultAddons, maybeDownloadAddons }] =
    await Promise.all([
      import('camoufox-js/dist/pkgman.js'),
      import('camoufox-js/dist/locale.js'),
      import('camoufox-js/dist/addons.js'),
    ]);

  const fetcher = new CamoufoxFetcher();
  await fetcher.install();
  if (ALLOW_GEOIP) await downloadMMDB();
  await maybeDownloadAddons(DefaultAddons);
}

async function loadBootstrap(status: string): Promise<void> {
  if (!mainWindow) return;
  await mainWindow.loadFile(bootstrapFile, { query: { status } });
}

async function ensureCamoufox(installDir: string): Promise<void> {
  if (camoufoxInstalled(installDir)) return;
  for (;;) {
    await loadBootstrap('Đang tải Camoufox cho lần chạy đầu...');
    try {
      await runCamoufoxFetch();
      return;
    } catch (err) {
      log.warn(`tải Camoufox lỗi: ${(err as Error).message}`);
      const message: MessageBoxOptions = {
        type: 'error',
        title: appName,
        message: 'Không tải được Camoufox',
        detail: `${(err as Error).message}\n\nKiểm tra kết nối internet rồi thử lại.`,
        buttons: ['Thử lại', 'Thoát'],
        defaultId: 0,
        cancelId: 1,
      };
      const choice = mainWindow
        ? await dialog.showMessageBox(mainWindow, message)
        : await dialog.showMessageBox(message);
      if (choice.response !== 0) throw err;
    }
  }
}

function buildAppMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: 'about', label: `Giới thiệu ${appName}` },
        { type: 'separator' },
        { role: 'hide', label: `Ẩn ${appName}` },
        { role: 'hideOthers', label: 'Ẩn ứng dụng khác' },
        { role: 'unhide', label: 'Hiện tất cả' },
        { type: 'separator' },
        { role: 'quit', label: `Thoát ${appName}` },
      ],
    });
  }

  template.push({
    label: 'Sửa',
    submenu: [
      { role: 'undo', label: 'Hoàn tác' },
      { role: 'redo', label: 'Làm lại' },
      { type: 'separator' },
      { role: 'cut', label: 'Cắt' },
      { role: 'copy', label: 'Sao chép' },
      { role: 'paste', label: 'Dán' },
      { role: 'selectAll', label: 'Chọn tất cả' },
    ],
  });

  template.push({
    label: 'Xem',
    submenu: [
      { role: 'reload', label: 'Tải lại' },
      { role: 'forceReload', label: 'Tải lại (bỏ cache)' },
      { type: 'separator' },
      { role: 'resetZoom', label: 'Cỡ mặc định' },
      { role: 'zoomIn', label: 'Phóng to' },
      { role: 'zoomOut', label: 'Thu nhỏ' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: 'Toàn màn hình' },
      { role: 'toggleDevTools', label: 'Công cụ nhà phát triển' },
    ],
  });

  template.push({
    label: 'Cửa sổ',
    role: 'windowMenu',
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function openMainWindow(): Promise<void> {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1040,
    minHeight: 720,
    title: appName,
    // Header native: ẩn title bar mặc định để phần header web ăn liền với thanh
    // tiêu đề (không còn tên app trùng lặp trên OS + web).
    //  - macOS: 'hiddenInset' → chấm đèn giao thông (traffic lights) nổi trên
    //    nội dung; header web chừa lề trái cho chúng.
    //  - Windows: 'hidden' + titleBarOverlay → nút thu/phóng/đóng native vẽ đè
    //    lên header (màu khớp nền trắng), kéo cửa sổ bằng vùng -webkit-app-region.
    titleBarStyle: isWin ? 'hidden' : isMac ? 'hiddenInset' : 'default',
    ...(isMac ? { trafficLightPosition: { x: 16, y: 18 } } : {}),
    ...(isWin
      ? { titleBarOverlay: { color: '#ffffff', symbolColor: '#1f2937', height: 52 } }
      : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await loadBootstrap('Đang chuẩn bị dữ liệu...');

  const userData = app.getPath('userData');
  const storeRoot = join(userData, 'profiles-store');
  const camoufoxDir = join(userData, 'camoufox');
  process.env.CAMOUFOX_INSTALL_DIR = camoufoxDir;

  await migrateLegacyStore(storeRoot);
  await ensureCamoufox(camoufoxDir);

  await loadBootstrap('Đang mở dashboard...');
  const { startServer } = await import('../server/index.js');
  server = await startServer({
    host: '127.0.0.1',
    port: 0,
    storeRoot,
    headless: false,
  });
  await mainWindow.loadURL(server.url);
}

async function shutdown(): Promise<void> {
  if (!server) return;
  const current = server;
  server = null;
  await current.close();
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.setName(appName);
  app.setAppUserModelId(appId);
  buildAppMenu();

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    openMainWindow().catch(async (err) => {
      log.error(err instanceof Error ? err.stack ?? err.message : String(err));
      await dialog.showMessageBox({
        type: 'error',
        title: appName,
        message: `Không thể khởi động ${appName}`,
        detail: err instanceof Error ? err.message : String(err),
      });
      app.quit();
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openMainWindow().catch((err) => log.error(err instanceof Error ? err.stack ?? err.message : String(err)));
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (!server) return;
    event.preventDefault();
    shutdown()
      .catch((err) => log.warn(`shutdown lỗi: ${(err as Error).message}`))
      .finally(() => app.quit());
  });
}
