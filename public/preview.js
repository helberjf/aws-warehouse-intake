/** Synthetic, read-only interface data. No network, credentials or browser storage. */
const actors = [
  { subject: 'example-operator-1', displayName: 'Operadora de exemplo A' },
  { subject: 'example-operator-2', displayName: 'Operador de exemplo B' },
];
const warehouses = Array.from({ length: 16 }, (_, index) => ({
  warehouseId: `WH-${String(index + 1).padStart(2, '0')}`,
  name: `Galpão ${String(index + 1).padStart(2, '0')} · Exemplo`,
  active: true,
}));
const definitions = [
  ['DEMO-CAIXA', 'Caixa organizadora 40 L', '7899000000010', 'BULK'],
  ['DEMO-CADERNO', 'Caderno A5 pautado', '7899000000027', 'BULK'],
  ['DEMO-GARRAFA', 'Garrafa térmica 750 ml', '7899000000034', 'BULK'],
  ['DEMO-CABO', 'Cabo USB-C 1 m', '7899000000041', 'BULK'],
  ['DEMO-FERRAMENTAS', 'Kit de ferramentas 12 peças', '7899000000058', 'BULK'],
  ['DEMO-ENVELOPE', 'Envelope acolchoado', '7899000000065', 'BULK'],
  ['DEMO-FONE', 'Fone Bluetooth', '7899000000072', 'SERIALIZED'],
  ['DEMO-COLETOR', 'Coletor de dados', '7899000000089', 'SERIALIZED'],
];
const products = definitions.map(([skuId, name, barcode, trackingMode], index) => ({
  skuId,
  name,
  barcode,
  trackingMode,
  active: true,
  createdBy: actors[index % actors.length],
  createdAt: `2026-11-01T${String(9 + index).padStart(2, '0')}:00:00.000Z`,
}));
const stock = Object.fromEntries(
  warehouses.map((warehouse, warehouseIndex) => [
    warehouse.warehouseId,
    products.map((product, productIndex) => ({
      skuId: product.skuId,
      quantity:
        product.trackingMode === 'SERIALIZED'
          ? 3 + warehouseIndex + productIndex
          : (warehouseIndex + 2) * (productIndex + 1) * 25,
      ...(product.trackingMode === 'BULK'
        ? { lotCode: `EXEMPLO-${String(warehouseIndex + 1).padStart(2, '0')}-A` }
        : {}),
    })),
  ]),
);
// Each stock balance corresponds to the sum of its completed synthetic movements.
// Serial products have one movement per unit; bulk products have one quantity movement.
const histories = Object.fromEntries(
  warehouses.map((warehouse, warehouseIndex) => {
    let sequence = 0;
    const records = stock[warehouse.warehouseId].flatMap((balance, productIndex) => {
      const product = products[productIndex];
      const units = product.trackingMode === 'SERIALIZED' ? balance.quantity : 1;
      return Array.from({ length: units }, (_, unitIndex) => {
        const event = sequence++;
        const acceptedAt = new Date(Date.UTC(2026, 10, 6, 9, warehouseIndex, event * 30)).toISOString();
        const reference = `EXEMPLO-${warehouse.warehouseId}-${product.skuId}-${unitIndex + 1}`;
        return {
          entryId: `${warehouseIndex + 1}-${productIndex + 1}-${unitIndex + 1}`,
          warehouseId: warehouse.warehouseId,
          producerId: 'example-receiving',
          quantity: product.trackingMode === 'SERIALIZED' ? 1 : balance.quantity,
          status: 'APPLIED',
          acceptedAt,
          completedAt: new Date(Date.parse(acceptedAt) + 1200).toISOString(),
          recordedBy: actors[event % actors.length],
          entry: {
            mode: product.trackingMode,
            skuId: product.skuId,
            externalReference: reference,
            occurredAt: acceptedAt,
            ...(product.trackingMode === 'SERIALIZED'
              ? { serialNumber: `EXEMPLO-SN-${warehouse.warehouseId}-${product.skuId}-${unitIndex + 1}` }
              : { quantity: balance.quantity, lotCode: balance.lotCode }),
          },
        };
      });
    });
    return [
      warehouse.warehouseId,
      records.sort((left, right) => right.acceptedAt.localeCompare(left.acceptedAt)),
    ];
  }),
);

export const previewVisitor = Object.freeze({
  subject: 'preview-visitor',
  displayName: 'Visitante da demonstração',
  organizationId: 'Organização de exemplo',
  producerId: 'preview-only',
  warehouseIds: Object.freeze(warehouses.map((warehouse) => warehouse.warehouseId)),
  roles: Object.freeze(['preview']),
});
export const previewExampleCodes = Object.freeze({ bulk: '7899000000010', serialized: '7899000000072' });
export const readOnlyMessage =
  'Esta demonstração é somente leitura. Nenhum cadastro ou recebimento pode ser gravado.';

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}
function page(items, url, scope) {
  const limit = Number(url.searchParams.get('limit') ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, 'Limite de consulta inválido.');
  let start = 0;
  const cursor = url.searchParams.get('cursor');
  if (cursor) {
    const prefix = `${scope}:`;
    if (!cursor.startsWith(prefix) || !/^\d+$/.test(cursor.slice(prefix.length)))
      fail(400, 'Cursor de demonstração inválido.');
    start = Number(cursor.slice(prefix.length));
    if (!Number.isSafeInteger(start) || start > items.length) fail(400, 'Cursor de demonstração inválido.');
  }
  return {
    items: items.slice(start, start + limit),
    ...(start + limit < items.length ? { cursor: `${scope}:${start + limit}` } : {}),
  };
}

export async function previewRequest(path, options = {}) {
  if ((options.method ?? 'GET').toUpperCase() !== 'GET') fail(403, readOnlyMessage);
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//'))
    fail(400, 'Consulta de demonstração inválida.');
  const url = new URL(path, 'https://preview.invalid');
  let result;
  if (url.pathname === '/warehouses') result = { items: warehouses };
  else if (url.pathname === '/products') result = page(products, url, 'products');
  else if (url.pathname === '/products/lookup') {
    const code = url.searchParams.get('code')?.trim();
    result = products.find((product) => product.skuId === code || product.barcode === code);
    if (!result) fail(404, 'Código não encontrado no catálogo de demonstração.');
  } else {
    const match = /^\/warehouses\/([^/]+)\/(stock|receiving-entries)(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) fail(404, 'Consulta não disponível na demonstração.');
    const warehouse = decodeURIComponent(match[1]);
    if (!Object.hasOwn(stock, warehouse)) fail(404, 'Galpão não encontrado na demonstração.');
    if (match[2] === 'stock') {
      const sku = match[3] && decodeURIComponent(match[3]);
      result = page(
        sku ? stock[warehouse].filter((item) => item.skuId === sku) : stock[warehouse],
        url,
        `stock-${warehouse}-${sku ?? 'all'}`,
      );
    } else if (match[3]) {
      result = histories[warehouse].find((entry) => entry.entryId === decodeURIComponent(match[3]));
      if (!result) fail(404, 'Entrada não encontrada na demonstração.');
    } else result = page(histories[warehouse], url, `history-${warehouse}`);
  }
  // Consumer edits cannot mutate the shared fixture data.
  return structuredClone(result);
}
