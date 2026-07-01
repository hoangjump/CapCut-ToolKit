import { ProfileManager } from './profileManager.js';
import { BrowserManager } from './browserManager.js';
import { createLogger } from './logger.js';

const log = createLogger('main');

/**
 * Demo entry point: ensures a few profiles exist, then opens them in parallel
 * (bounded concurrency) and reports the egress IP + the UA the page actually
 * sees — a quick way to confirm the per-profile proxy is applied and that
 * Camoufox is serving a coherent (Firefox) fingerprint.
 */
async function main(): Promise<void> {
  const profiles = new ProfileManager();
  await profiles.init();

  // Seed a couple of demo profiles on first run.
  if (profiles.list().length === 0) {
    log.info('no profiles found — seeding demo profiles');
    await profiles.create({ name: 'demo-1' });
    await profiles.create({ name: 'demo-2' });
    await profiles.create({ name: 'demo-3' });
  }

  const browsers = new BrowserManager(profiles, undefined, { headless: false });
  const ids = profiles.list().map((p) => p.id);

  log.info(`running batch over ${ids.length} profiles`);

  const results = await browsers.runBatch(
    ids,
    async ({ profile, context }) => {
      const page = await context.newPage();
      await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded' });
      const bodyText = await page.locator('body').innerText();
      let ip = 'unknown';
      try {
        ip = (JSON.parse(bodyText) as { ip: string }).ip;
      } catch {
        log.warn(`[${profile.name}] unexpected IP response: ${bodyText.slice(0, 80)}`);
      }
      const ua = await page.evaluate(() => navigator.userAgent);
      const webdriver = await page.evaluate(
        () => (navigator as Navigator & { webdriver?: boolean }).webdriver ?? false,
      );
      log.info(`[${profile.name}] ip=${ip} webdriver=${webdriver} ua=${ua.slice(0, 40)}…`);
      return { ip, webdriver };
    },
    { concurrency: 2, autoClose: true },
  );

  const ok = results.filter((r) => !r.error).length;
  log.info(`batch done: ${ok}/${results.length} succeeded`);
  for (const r of results) {
    if (r.error) log.error(`  ${r.profileId}: ${r.error.message}`);
  }

  await browsers.closeAll();
}

main().catch((err) => {
  log.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
