import { test, expect, type Page } from '@playwright/test';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClients } from '../src/clients.ts';
import { IdentityService } from '../src/identity/service.ts';

async function login(
  page: Page,
  warehouses = ['WH-01', 'WH-02'],
  roles: ('admin' | 'receiving')[] = ['admin', 'receiving'],
) {
  if (process.env.ENVIRONMENT !== 'local') throw new Error('Browser tests create synthetic local users only');
  const clients = createClients('us-east-1', 'http://localhost:4566');
  const username = `e2e-${randomUUID()}`,
    password = randomBytes(24).toString('base64url');
  try {
    await new IdentityService(clients.document, process.env.TABLE_NAME ?? 'warehouse-local').provisionUser({
      organizationId: 'DEMO',
      username,
      password,
      displayName: 'Operador de teste',
      producerId: 'browser-e2e',
      warehouseIds: warehouses,
      roles,
    });
  } finally {
    clients.dynamo.destroy();
    clients.sqs.destroy();
  }
  await page.goto('/');
  await page.locator('#organization').fill('DEMO');
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#login-submit').click();
  await expect(page.locator('#warehouse-select')).toBeVisible();
  return { username, password };
}

test('catalog audit, USB-style scan, receiving and stock per warehouse work through real services', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  const sku = `UI-${randomUUID().slice(0, 8)}`,
    barcode = `CODE-${sku}`;
  await page.locator('[data-view="products"]').click();
  await page.locator('#new-product').click();
  await page.locator('#product-name').fill('Caixa de ferramentas');
  await page.locator('#product-sku').fill(sku);
  await page.locator('#product-barcode').fill(barcode);
  await page.locator('#save-product').click();
  const row = page.locator('tr').filter({ hasText: sku });
  await expect(row).toContainText('Operador de teste');
  await page.screenshot({ path: info.outputPath('catalog-desktop.png'), fullPage: true });
  await page.locator('[data-view="receiving"]').click();
  await page.locator('#scan-code').fill(barcode);
  await page.locator('#scan-code').press('Enter');
  await expect(page.locator('.found-product')).toContainText('Caixa de ferramentas');
  await expect(page.locator('#receipt-quantity')).toHaveValue('1');
  await page.locator('#receipt-quantity').fill('7');
  const posted = page.waitForRequest(
    (req) => req.method() === 'POST' && req.url().endsWith('/receiving-entries'),
  );
  await page.locator('#save-receipt').click();
  const request = await posted;
  const body = request.postDataJSON();
  expect(body.skuId).toBe(sku);
  expect(body.externalReference).toMatch(/^RECEB-/);
  expect(Math.abs(Date.now() - Date.parse(body.occurredAt))).toBeLessThan(30000);
  expect(body.recordedBy).toBeUndefined();
  await expect(page.locator('.success-card')).toContainText('Entrada concluída', { timeout: 45000 });
  await expect(page.locator('.success-card')).toContainText('Operador de teste');
  await page.locator('[data-view="stock"]').click();
  await page.locator('#stock-sku').fill(sku);
  await page.locator('#stock-search').evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(page.locator('#stock-table')).toContainText('7');
  await page.screenshot({ path: info.outputPath('stock-desktop.png'), fullPage: true });
  await page.locator('#warehouse-select').selectOption('WH-02');
  await expect(page.locator('#stock-table')).not.toContainText(sku);
  expect(errors).toEqual([]);
  await page.locator('#logout').click();
  await expect(page.locator('#login-submit')).toBeVisible();
  const response = await page.request.get('/auth/session');
  expect(response.status()).toBe(401);
});

test('mobile operator has warehouse restrictions and cannot register catalog products', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, ['WH-01'], ['receiving']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('[data-view="products"]').click();
  await expect(page.locator('#new-product')).toHaveCount(0);
  await expect(page.locator('#warehouse-select option')).toHaveCount(1);
  const session = await (await page.request.get('/auth/session')).json();
  const denied = await page.request.put('/products/FORBIDDEN', {
    headers: { origin: 'http://localhost:3000', 'x-csrf-token': session.csrfToken },
    data: { name: 'Forbidden', trackingMode: 'BULK', active: true },
  });
  expect(denied.status()).toBe(403);
  await page.locator('[data-view="receiving"]').click();
  await page.locator('#scan-code').fill('unknown-product-code');
  await page.locator('#scan-code').press('Enter');
  await expect(page.locator('#lookup-error')).toContainText('Código não encontrado');
  await expect(page.locator('#save-receipt')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('receiving-mobile.png'), fullPage: true });
});

test('camera fallback decodes an actual EAN-13 image and stops capture after reading', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'BarcodeDetector', { value: undefined, configurable: true });
    const code = '7891234567895';
    const L = [
      '0001101',
      '0011001',
      '0010011',
      '0111101',
      '0100011',
      '0110001',
      '0101111',
      '0111011',
      '0110111',
      '0001011',
    ];
    const G = [
      '0100111',
      '0110011',
      '0011011',
      '0100001',
      '0011101',
      '0111001',
      '0000101',
      '0010001',
      '0001001',
      '0010111',
    ];
    const R = L.map((bits) => bits.replace(/[01]/g, (c) => (c === '0' ? '1' : '0')));
    const parity = [
      'LLLLLL',
      'LLGLGG',
      'LLGGLG',
      'LLGGGL',
      'LGLLGG',
      'LGGLLG',
      'LGGGLL',
      'LGLGLG',
      'LGLGGL',
      'LGGLGL',
    ][Number(code[0])];
    const bits =
      '101' +
      code
        .slice(1, 7)
        .split('')
        .map((digit, i) => (parity[i] === 'L' ? L : G)[Number(digit)])
        .join('') +
      '01010' +
      code
        .slice(7)
        .split('')
        .map((digit) => R[Number(digit)])
        .join('') +
      '101';
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const draw = () => {
          const ctx = canvas.getContext('2d')!;
          ctx.fillStyle = 'white';
          ctx.fillRect(0, 0, 640, 480);
          ctx.fillStyle = 'black';
          bits.split('').forEach((bit, i) => {
            if (bit === '1') ctx.fillRect(130 + i * 4, 100, 4, 280);
          });
        };
        draw();
        const stream = canvas.captureStream(10);
        const timer = setInterval(draw, 100);
        const track = stream.getVideoTracks()[0];
        const stop = track.stop.bind(track);
        track.stop = () => {
          stop();
          clearInterval(timer);
        };
        (window as unknown as { cameraStream: MediaStream }).cameraStream = stream;
        return stream;
      },
    });
  });
  await login(page);
  await page.locator('[data-view="receiving"]').click();
  await page.locator('#open-camera').click();
  await expect(page.locator('.found-product')).toContainText('Caixa organizadora', { timeout: 30000 });
  await expect(page.locator('#camera-dialog')).not.toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as unknown as { cameraStream: MediaStream }).cameraStream
        .getTracks()
        .every((track) => track.readyState === 'ended'),
    ),
  ).toBe(true);
  await expect(page.locator('#receipt-quantity')).toHaveValue('1');
});

test('uncertain HTTP completion retries original body and key without a second stock increment', async ({
  page,
}) => {
  await login(page);
  await page.locator('[data-view="receiving"]').click();
  await page.locator('#scan-code').fill('BULK-001');
  await page.locator('#scan-code').press('Enter');
  await page.locator('#receipt-quantity').fill('3');
  const lot = `retry-${randomUUID()}`;
  await page.locator('#receipt-lot').fill(lot);
  const requests: { body: string | null; key: string | undefined }[] = [];
  let first = true;
  await page.route('**/warehouses/WH-01/receiving-entries', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    requests.push({ body: route.request().postData(), key: route.request().headers()['idempotency-key'] });
    if (first) {
      first = false;
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  await page.locator('#save-receipt').click();
  await expect(page.locator('#retry-receipt')).toBeVisible();
  await page.reload();
  await page.locator('[data-view="receiving"]').click();
  await page.locator('#retry-receipt').click();
  await expect(page.locator('.success-card')).toContainText('Entrada concluída', { timeout: 45000 });
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  const stock = await (await page.request.get('/warehouses/WH-01/stock/BULK-001?limit=100')).json();
  expect(stock.items.find((item: { lotCode?: string }) => item.lotCode === lot).quantity).toBe(3);
});
test('password change ends the session and the replacement password signs in successfully', async ({
  page,
}) => {
  const credentials = await login(page);
  await page.locator('[data-view="account"]').click();
  const replacement = randomBytes(24).toString('base64url');
  await page.locator('#current-password').fill(credentials.password);
  await page.locator('#new-password').fill(replacement);
  await page.locator('#confirm-password').fill(replacement);
  await page.locator('#change-password').click();
  await expect(page.locator('#login-submit')).toBeVisible();
  expect((await page.request.get('/auth/session')).status()).toBe(401);
  await page.locator('#organization').fill('DEMO');
  await page.locator('#username').fill(credentials.username);
  await page.locator('#password').fill(replacement);
  await page.locator('#login-submit').click();
  await expect(page.locator('#warehouse-select')).toBeVisible();
});
test('all printable demo labels decode to the catalog barcode values', async ({ page }, info) => {
  await page.goto('/demo-barcodes.html');
  await expect(page.locator('svg')).toHaveCount(8);
  await page.addScriptTag({ url: '/vendor/zxing.js' });
  const codes = await page.evaluate(async () => {
    const library = (
      window as unknown as {
        ZXingBrowser: {
          BrowserMultiFormatReader: new () => {
            decodeFromImageElement: (image: HTMLImageElement) => Promise<{ getText: () => string }>;
          };
        };
      }
    ).ZXingBrowser;
    const output: string[] = [];
    for (const original of document.querySelectorAll('svg')) {
      const svg = original.cloneNode(true) as SVGElement;
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svg.setAttribute('width', '468');
      svg.setAttribute('height', '368');
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
      await image.decode();
      output.push((await new library.BrowserMultiFormatReader().decodeFromImageElement(image)).getText());
    }
    return output;
  });
  const products = JSON.parse(
    await readFile(new URL('../examples/demo-products.json', import.meta.url), 'utf8'),
  ).products;
  expect(codes).toEqual(products.map((product: { barcode: string }) => product.barcode));
  await page.screenshot({ path: info.outputPath('demo-labels.png'), fullPage: true });
});
