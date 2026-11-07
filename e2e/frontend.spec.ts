import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function explore(page: Page) {
  await page.goto('/');
  await page.locator('#explore-preview').click();
  await expect(page.locator('#stock-lines')).toHaveText('8');
}

test('static demonstration navigates across warehouses on desktop and mobile without API or storage', async ({
  page,
  context,
}, info) => {
  const apiRequests: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => {
    if (/^\/(auth|products|warehouses)(\/|\?|$)/.test(new URL(request.url()).pathname))
      apiRequests.push(request.url());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.locator('#explore-preview').click();
  await expect(page.locator('#stock-lines')).toHaveText('8');
  await expect(page.locator('#warehouse-select option')).toHaveCount(16);
  const firstBalance = await page.locator('#stock-units').textContent();
  await page.locator('#warehouse-select').selectOption('WH-16');
  await expect(page.locator('#stock-units')).not.toHaveText(firstBalance!);
  await expect(page.locator('#stock-warehouse')).toHaveText('WH-16');
  await expect(page.locator('.session-tag')).toHaveText('Prévia estática');
  await page.screenshot({ path: info.outputPath('preview-desktop.png'), fullPage: true });
  await page.locator('[data-view="products"]').click();
  await expect(page.locator('#products-table tbody tr')).toHaveCount(8);
  await page.locator('[data-view="receiving"]').click();
  await expect(page.locator('#history-table tbody tr')).not.toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const view of ['stock', 'products', 'receiving', 'account']) {
    await page.locator(`[data-view="${view}"]`).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.locator('[data-view="stock"]').click();
  await page.screenshot({ path: info.outputPath('preview-mobile.png'), fullPage: true });
  await page.locator('#logout').click();
  await expect(page.locator('#explore-preview')).toBeVisible();
  await page.locator('#explore-preview').click();
  await page.reload();
  await expect(page.locator('#explore-preview')).toBeVisible();
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  expect(await context.cookies()).toEqual([]);
  expect(apiRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('registration and receiving remain read-only even when form submission is forced', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(request.url());
  });
  await explore(page);
  await page.locator('[data-view="products"]').click();
  await page.locator('#new-product').click();
  await expect(page.locator('#product-name')).toBeDisabled();
  await expect(page.locator('#save-product')).toBeDisabled();
  await page
    .locator('#product-form')
    .evaluate((form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await expect(page.locator('#toast')).toContainText('somente leitura');
  await page.locator('[data-view="receiving"]').click();
  await page.locator('#scan-code').fill('7899000000010');
  await page.locator('#scan-code').press('Enter');
  await expect(page.locator('.found-product')).toContainText('DEMO-CAIXA');
  await expect(page.locator('#receipt-quantity')).toBeDisabled();
  await expect(page.locator('#save-receipt')).toBeDisabled();
  await page
    .locator('#receipt-form')
    .evaluate((form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await page.locator('#scan-code').fill('7899000000072');
  await page.locator('#scan-code').press('Enter');
  await expect(page.locator('.found-product')).toContainText('DEMO-FONE');
  await expect(page.locator('#receipt-serial')).toBeDisabled();
  const statuses = await page.evaluate(async () => {
    const modulePath = '/preview.js';
    const { previewRequest } = await import(modulePath);
    return Promise.all(
      ['POST', 'PUT', 'PATCH', 'DELETE'].map(async (method) => {
        try {
          await previewRequest('/products/DEMO-CAIXA', { method, body: '{}' });
          return 200;
        } catch (error) {
          return (error as { status: number }).status;
        }
      }),
    );
  });
  expect(statuses).toEqual([403, 403, 403, 403]);
  expect(writes).toEqual([]);
  await expect(page.locator('.success-card')).toHaveCount(0);
});

test('packaged decoder reads all printed labels and resolves the same preview catalog products', async ({
  page,
}) => {
  await page.goto('/demo-barcodes.html');
  await expect(page.locator('svg')).toHaveCount(8);
  await page.addScriptTag({ url: '/vendor/zxing.js' });
  const decoded = await page.evaluate(async () => {
    const library = (
      window as unknown as {
        ZXingBrowser: {
          BrowserMultiFormatReader: new () => {
            decodeFromImageElement: (image: HTMLImageElement) => Promise<{ getText: () => string }>;
          };
        };
      }
    ).ZXingBrowser;
    const modulePath = '/preview.js';
    const { previewRequest } = await import(modulePath);
    const output: { barcode: string; skuId: string }[] = [];
    for (const original of document.querySelectorAll('svg')) {
      const svg = original.cloneNode(true) as SVGElement;
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svg.setAttribute('width', '468');
      svg.setAttribute('height', '368');
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
      await image.decode();
      const barcode = (await new library.BrowserMultiFormatReader().decodeFromImageElement(image)).getText();
      const product = await previewRequest(`/products/lookup?code=${barcode}`);
      output.push({ barcode, skuId: product.skuId });
    }
    return output;
  });
  const { products } = JSON.parse(
    await readFile(new URL('../examples/demo-products.json', import.meta.url), 'utf8'),
  );
  expect(decoded).toEqual(
    products.map(({ barcode, skuId }: { barcode: string; skuId: string }) => ({ barcode, skuId })),
  );
});

test('static output exposes no backend routes and applies the deployment headers', async ({ request }) => {
  const home = await request.get('/');
  expect(home.status()).toBe(200);
  expect(home.headers()['content-security-policy']).toContain("connect-src 'self'");
  expect(home.headers()['permissions-policy']).toContain('camera=(self)');
  expect(home.headers()['cache-control']).toBe('no-store');
  for (const path of [
    '/auth/session',
    '/products',
    '/warehouses',
    '/.env',
    '/src/main.ts',
    '/.tokens/local-login.txt',
  ]) {
    const response = await request.get(path);
    expect(response.status()).toBe(404);
    expect(await response.text()).not.toContain('<html');
  }
  expect((await request.post('/auth/login', { data: {} })).status()).toBe(405);
});

test('connected mode still sends login, CSRF-protected catalog writes and logout to its API', async ({
  page,
}) => {
  let authenticated = false;
  const writes: { path: string; method: string; csrf?: string; body: unknown }[] = [];
  const user = {
    subject: 'test-admin',
    displayName: 'Test Admin',
    organizationId: 'TEST',
    roles: ['admin'],
    warehouseIds: ['WH-01'],
  };
  const products: unknown[] = [];
  await page.route('**/runtime-config.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: "export const deployment = { mode: 'connected' };",
    }),
  );
  await page.route(/\/(auth|products|warehouses)(\/|\?|$)/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET')
      writes.push({
        path,
        method: request.method(),
        csrf: request.headers()['x-csrf-token'],
        body: request.postDataJSON(),
      });
    if (path === '/auth/session')
      return route.fulfill({
        status: authenticated ? 200 : 401,
        json: authenticated ? { user, csrfToken: 'test-csrf-value' } : {},
      });
    if (path === '/auth/login') {
      authenticated = true;
      return route.fulfill({ status: 204 });
    }
    if (path === '/auth/logout') {
      authenticated = false;
      return route.fulfill({ status: 204 });
    }
    if (path === '/warehouses')
      return route.fulfill({
        json: { items: [{ warehouseId: 'WH-01', name: 'Test warehouse', active: true }] },
      });
    if (path === '/products') return route.fulfill({ json: { items: products } });
    if (path === '/warehouses/WH-01/stock') return route.fulfill({ json: { items: [] } });
    if (path === '/products/TEST-SKU' && request.method() === 'PUT') {
      const product = {
        ...request.postDataJSON(),
        skuId: 'TEST-SKU',
        createdBy: user,
        createdAt: '2026-11-07T12:00:00Z',
      };
      products.push(product);
      return route.fulfill({ json: product });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/');
  await page.locator('#organization').fill('TEST');
  await page.locator('#username').fill('test-admin');
  await page.locator('#password').fill('test-only-password');
  await page.locator('#login-submit').click();
  await expect(page.locator('.session-tag')).toHaveText('Sessão protegida');
  await expect(page.locator('.preview-banner')).toHaveCount(0);
  await page.locator('[data-view="products"]').click();
  await page.locator('#new-product').click();
  await page.locator('#product-name').fill('Test product');
  await page.locator('#product-sku').fill('TEST-SKU');
  await page.locator('#save-product').click();
  await expect(page.locator('#products-table')).toContainText('TEST-SKU');
  await page.locator('#logout').click();
  await expect(page.locator('#login-submit')).toBeVisible();
  expect(writes).toEqual([
    {
      path: '/auth/login',
      method: 'POST',
      csrf: undefined,
      body: { organizationId: 'TEST', username: 'test-admin', password: 'test-only-password' },
    },
    {
      path: '/products/TEST-SKU',
      method: 'PUT',
      csrf: 'test-csrf-value',
      body: { name: 'Test product', trackingMode: 'BULK', active: true },
    },
    { path: '/auth/logout', method: 'POST', csrf: 'test-csrf-value', body: {} },
  ]);
});
