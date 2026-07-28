const assert = require('node:assert/strict');
const http = require('node:http');
const { readFile } = require('node:fs/promises');
const { extname, join, normalize } = require('node:path');
const { chromium } = require('playwright');

const root = normalize(join(__dirname, '..'));
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
};

const syncStub = `
window.RyanAppSync = Object.freeze({
  create() {
    let listener = null;
    const fixed = () => ({ save: async () => true, remove: async () => true });
    return Object.freeze({
      onStateChange(next) {
        listener = next;
        next({ mode: 'disconnected', message: 'Local smoke test' });
      },
      register: async () => fixed(),
      registerCollection: async () => fixed(),
      finalizeRegistration: async () => true,
      connect: async () => true,
      disconnect: async () => true,
      resetDevice: async () => true,
      sync: async () => true,
      previewMigration: async () => ({
        preview: {
          writesPerformed: 0,
          localCount: 0,
          remoteCount: 0,
          conflictCount: 0,
          orphanedCount: 0,
          review: [],
        },
        plan: {},
      }),
      applyMigration: async () => true,
      listConflicts: async () => [],
      resolveConflict: async () => true,
      getState: () => ({ mode: 'disconnected', message: 'Local smoke test' }),
    });
  },
});
`;

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const path = normalize(join(root, relative));
    if (!path.startsWith(root)) throw new Error('outside root');
    const body = await readFile(path);
    response.writeHead(200, {
      'content-type': mime[extname(path)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch (_error) {
    response.writeHead(404);
    response.end('Not found');
  }
});

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.route(
    'https://ryan-app-sync.ryan-666-mp3.chatgpt.site/ryan-app-sync.js',
    (route) => route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: syncStub,
    }),
  );

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await page.locator('[data-candyland-sync-open]').waitFor();
    assert.equal(await page.locator('#classList .class-launcher').count(), 4);

    await page.locator('#soundToggleButton').click();
    await page.waitForFunction(() =>
      localStorage.getItem('candy-circle-quest-sound-enabled') === 'off');

    await page.locator('[data-play-class="level-3-boys"]').click();
    await page.locator('[data-turn-athlete]').first().click();
    await page.locator('[data-turn-pad="2"]').click();
    await page.locator('#showCardsButton').click();
    await page.waitForFunction(() => {
      const value = JSON.parse(localStorage.getItem('candy-circle-quest-v1'));
      return value.history.length === 1;
    });
    await page.locator('#closeTurnFlowButton').click();

    const viewports = [
      { width: 375, height: 812 },
      { width: 768, height: 1024 },
      { width: 1440, height: 900 },
    ];
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.reload({ waitUntil: 'networkidle' });
      await page.locator('[data-candyland-sync-open]').click();
      await page.locator('.candyland-sync-dialog').waitFor({ state: 'visible' });
      const layout = await page.evaluate(() => ({
        viewport: window.innerWidth,
        pageWidth: document.documentElement.scrollWidth,
        dialogOpen: document.querySelector('.candyland-sync-dialog')?.open === true,
        actions: document.querySelectorAll('.candyland-sync-actions button').length,
        warning: document.querySelector('[data-candyland-storage-warning]')?.textContent || '',
      }));
      assert.equal(layout.dialogOpen, true);
      assert.equal(layout.actions, 6);
      assert.ok(layout.pageWidth <= layout.viewport, JSON.stringify({ viewport, layout }));
      assert.equal(layout.warning, '');
      await page.locator('[data-candyland-sync-close]').click();
    }

    assert.equal(
      await page.locator('#soundToggleButton').getAttribute('aria-pressed'),
      'false',
    );
    const persisted = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('candy-circle-quest-v1')));
    assert.equal(persisted.history.length, 1);
    assert.equal(errors.length, 0, errors.join('\n'));
    process.stdout.write(
      'Candyland headless smoke: 3 viewports, persistence, gameplay, sync dialog, zero_open PASS\n',
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
