import { CameraScanner } from './scanner.js';

const root = document.querySelector('#app');
const icons = {
  stock: '<path d="M3 8 12 3l9 5v12H3Z"/><path d="M7 20v-9h10v9M7 15h10M7 17h10"/>',
  box: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="M3 8v10l9 5 9-5V8M12 13v10M7 5.8l10 5.4"/>',
  receive: '<path d="M12 3v12m-4-4 4 4 4-4M4 14v6h16v-6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  barcode: '<path d="M3 7V3h4M17 3h4v4M21 17v4h-4M7 21H3v-4M7 7v10M10 7v10M14 7v10M17 7v10"/>',
  camera: '<path d="M3 7h4l2-3h6l2 3h4v13H3Z"/><circle cx="12" cy="13" r="4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
  check: '<path d="m5 12 4 4L20 5"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.2 7a8 8 0 0 1 13-2L20 7M4 17l1.8 2a8 8 0 0 0 13-2"/>',
  logout: '<path d="M9 4H4v16h5M13 7l5 5-5 5M8 12h12"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] ?? icons.box}</svg>`;
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const number = (value) => new Intl.NumberFormat('pt-BR').format(value ?? 0);
const date = (value) =>
  value
    ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
    : '—';
const nameOf = (actor) => actor?.displayName || actor?.subject || 'Registro anterior à auditoria';
const state = {
  user: null,
  csrfToken: null,
  warehouses: [],
  warehouseId: '',
  products: [],
  productCursor: undefined,
  view: 'stock',
  stock: [],
  stockCursor: undefined,
  history: [],
  historyCursor: undefined,
  stockFilter: '',
  entryProduct: null,
  receipt: null,
  result: null,
  sequence: 0,
};
const isAdmin = () => state.user?.roles.includes('admin');
const warehouseName = () =>
  state.warehouses.find((w) => w.warehouseId === state.warehouseId)?.name ||
  state.warehouseId ||
  'Nenhum galpão';
const productName = (sku) => state.products.find((p) => p.skuId === sku)?.name || sku;
const scanner = new CameraScanner(document.querySelector('#camera-video'));
const cameraDialog = document.querySelector('#camera-dialog');
let toastTimer;

function toast(message, error = false) {
  const element = document.querySelector('#toast');
  element.textContent = message;
  element.classList.toggle('error', error);
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element.hidden = true;
  }, 6500);
}
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const errors = {
  400: 'Confira os campos preenchidos.',
  401: 'Sua sessão expirou. Entre novamente.',
  403: 'Você não tem permissão para esta ação.',
  404: 'Não encontramos esse registro.',
  409: 'Os dados conflitam com um registro existente. Confira o código, a referência e o tipo de controle.',
  413: 'Os dados excedem o tamanho permitido.',
  429: 'Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.',
};
async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(state.csrfToken ? { 'X-CSRF-Token': state.csrfToken } : {}),
        ...options.headers,
      },
      signal: AbortSignal.timeout(25000),
    });
  } catch {
    throw new ApiError(0, 'Não foi possível confirmar a resposta. Verifique a conexão e tente novamente.');
  }
  if (!response.ok)
    throw new ApiError(
      response.status,
      errors[response.status] || 'O serviço não respondeu como esperado. Tente novamente em instantes.',
    );
  if (response.status === 204) return null;
  return response.json();
}
function showFailure(error, element) {
  if (element) {
    element.textContent = error.message;
    element.hidden = false;
  } else toast(error.message, true);
  if (error.status === 401 && state.user) {
    state.user = null;
    state.csrfToken = null;
    closeCamera();
    renderLogin('Sua sessão expirou. Entre novamente para continuar.');
  }
}
function setButton(button, busy, text) {
  button.disabled = busy;
  button.textContent = text;
}
function empty(title, message, action = '') {
  return `<div class="empty"><div class="empty-icon">${icon('box')}</div><h3>${esc(title)}</h3><p>${esc(message)}</p>${action}</div>`;
}
function badge(status) {
  const map = {
    ACCEPTED: ['Em processamento', 'badge-warn'],
    APPLIED: ['Concluída', ''],
    REJECTED: ['Não aplicada', 'badge-error'],
  };
  const [text, cls] = map[status] ?? [status, 'badge-neutral'];
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}
function pageHeader(kicker, title, description, action = '') {
  return `<div class="page-heading"><div><p class="eyebrow">${esc(kicker)}</p><h1>${esc(title)}</h1><p class="muted">${esc(description)}</p></div>${action}</div>`;
}
function rememberReceipt() {
  if (state.receipt) sessionStorage.setItem('warehouse-pending-receipt', JSON.stringify(state.receipt));
  else sessionStorage.removeItem('warehouse-pending-receipt');
}
function restoreReceipt() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('warehouse-pending-receipt') || 'null');
    if (
      saved?.subject === state.user.subject &&
      saved?.organizationId === state.user.organizationId &&
      state.user.warehouseIds.includes(saved.warehouseId) &&
      saved.key &&
      saved.body
    ) {
      state.receipt = saved;
    }
  } catch {
    sessionStorage.removeItem('warehouse-pending-receipt');
  }
}

function renderLogin(message = '') {
  state.sequence++;
  document.title = 'Entrar · Armazém';
  root.innerHTML = `<div class="login-layout"><section class="login-story" aria-label="Armazém"><div class="brand"><span class="brand-mark">A</span><div>armazém<div class="brand-subtitle">GESTÃO DE RECEBIMENTOS</div></div></div><div class="login-story-content"><p class="eyebrow">DA CHEGADA AO ESTOQUE</p><h1>Cada entrada.<br>Cada produto.<br><span>Tudo no lugar.</span></h1><p>Uma visão clara dos seus galpões, com recebimentos organizados e responsabilidade em cada registro.</p><div class="login-feature">${icon('barcode')}Leia o código. Encontre o produto.</div><div class="login-feature">${icon('stock')}Acompanhe o estoque por galpão.</div><div class="login-feature">${icon('shield')}Saiba quem registrou cada entrada.</div></div><div class="login-footer">ARMAZÉM / CONTROLE QUE ACOMPANHA A OPERAÇÃO</div></section><main id="main" class="login-pane"><div class="login-box"><div class="brand login-mobile-brand"><span class="brand-mark">A</span><div>armazém<div class="brand-subtitle">GESTÃO DE RECEBIMENTOS</div></div></div><span class="login-label">${icon('shield')} ACESSO À OPERAÇÃO</span><h2>Bem-vindo de volta</h2><p class="muted">Entre com sua conta para acessar os galpões da sua organização.</p><form id="login-form"><div id="login-error" class="alert alert-error" role="alert" ${message ? '' : 'hidden'}>${esc(message)}</div><div class="field"><label for="organization">Organização</label><input id="organization" name="organizationId" autocomplete="organization" required maxlength="64" placeholder="Código da organização" /></div><div class="field"><label for="username">Usuário</label><input id="username" name="username" autocomplete="username" required maxlength="128" placeholder="Seu usuário" /></div><div class="field"><label for="password">Senha</label><div class="password-toggle"><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="128" placeholder="Sua senha" /><button type="button" id="show-password" class="icon-button" aria-label="Mostrar senha">${icon('eye')}</button></div></div><button id="login-submit" class="button button-primary" type="submit">Entrar na operação ${icon('arrow')}</button></form><p class="login-note">Ainda não tem acesso ou esqueceu a senha?<br>Solicite ao administrador da sua organização.</p></div></main></div>`;
  document.querySelector('#show-password').addEventListener('click', () => {
    const input = document.querySelector('#password');
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    document
      .querySelector('#show-password')
      .setAttribute('aria-label', hidden ? 'Ocultar senha' : 'Mostrar senha');
  });
  document.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.querySelector('#login-submit');
    setButton(button, true, 'Entrando…');
    document.querySelector('#login-error').hidden = true;
    try {
      const data = Object.fromEntries(new FormData(event.currentTarget));
      await api('/auth/login', { method: 'POST', body: JSON.stringify(data) });
      await startSession();
    } catch (error) {
      if (error.status === 401) error.message = 'Organização, usuário ou senha inválidos.';
      showFailure(error, document.querySelector('#login-error'));
      setButton(button, false, 'Entrar na operação');
    }
  });
}
async function startSession() {
  const session = await api('/auth/session');
  state.user = session.user;
  state.csrfToken = session.csrfToken;
  const [warehouses, products] = await Promise.all([api('/warehouses'), api('/products?limit=50')]);
  state.warehouses = warehouses.items;
  state.products = products.items;
  state.productCursor = products.cursor;
  if (!state.warehouses.some((w) => w.warehouseId === state.warehouseId))
    state.warehouseId = state.warehouses[0]?.warehouseId || '';
  restoreReceipt();
  await navigate('stock');
}
function shell() {
  const pages = { stock: 'Estoque', receiving: 'Entradas', products: 'Produtos', account: 'Minha conta' };
  root.innerHTML = `<div class="app-layout"><aside class="sidebar" aria-label="Menu principal"><div class="brand"><span class="brand-mark">A</span><div>armazém<div class="brand-subtitle">CONTROLE DA OPERAÇÃO</div></div></div><p class="nav-caption">ESPAÇO DE TRABALHO</p><nav class="nav-list">${[
    ['stock', 'stock', 'Estoque'],
    ['receiving', 'receive', 'Entradas'],
    ['products', 'box', 'Produtos'],
    ['account', 'user', 'Minha conta'],
  ]
    .map(
      ([view, symbol, label]) =>
        `<button type="button" class="nav-button" data-view="${view}" ${state.view === view ? 'aria-current="page"' : ''}>${icon(symbol)}<span>${label}</span></button>`,
    )
    .join(
      '',
    )}</nav><div class="sidebar-bottom"><p class="sidebar-help">Uma operação organizada<br>começa com um bom registro.</p><div class="profile"><div class="avatar">${esc((state.user.displayName || state.user.subject).slice(0, 2).toUpperCase())}</div><div><div class="profile-name">${esc(state.user.displayName || state.user.subject)}</div><div class="profile-role">${isAdmin() ? 'Administrador' : 'Operador de recebimentos'}</div></div></div></div></aside><div class="workspace"><header class="topbar"><div class="breadcrumb"><span>${esc(state.user.organizationId)}</span><span class="separator">/</span><strong>${pages[state.view]}</strong></div><div class="topbar-actions"><span class="session-tag"><span class="status-dot"></span>Sessão protegida</span><label class="warehouse-switch">${icon('stock')}<select id="warehouse-select" aria-label="Galpão selecionado">${state.warehouses.length ? state.warehouses.map((w) => `<option value="${esc(w.warehouseId)}" ${w.warehouseId === state.warehouseId ? 'selected' : ''}>${esc(w.name || w.warehouseId)}${w.active ? '' : ' · Inativo'}</option>`).join('') : '<option value="">Nenhum galpão</option>'}</select></label><button type="button" class="icon-button" id="logout" aria-label="Sair da conta" title="Sair">${icon('logout')}</button></div></header><main id="main" class="content" tabindex="-1"></main></div></div>`;
  document
    .querySelectorAll('[data-view]')
    .forEach((button) => button.addEventListener('click', () => navigate(button.dataset.view)));
  document.querySelector('#warehouse-select').addEventListener('change', (event) => {
    state.warehouseId = event.target.value;
    state.stockFilter = '';
    state.result = null;
    if (!state.receipt) state.entryProduct = null;
    navigate(state.view);
  });
  document.querySelector('#logout').addEventListener('click', async () => {
    try {
      await api('/auth/logout', { method: 'POST', body: '{}' });
      closeCamera();
      state.user = null;
      state.csrfToken = null;
      state.entryProduct = null;
      state.result = null;
      state.products = [];
      state.receipt = null;
      renderLogin();
    } catch (error) {
      showFailure(error);
    }
  });
}
async function navigate(view) {
  closeCamera();
  state.view = view;
  state.sequence++;
  const sequence = state.sequence;
  shell();
  document.title = `${{ stock: 'Estoque', receiving: 'Entradas', products: 'Produtos', account: 'Minha conta' }[view]} · Armazém`;
  if (view === 'stock') {
    renderStock();
    await loadStock(false, sequence);
  }
  if (view === 'products') renderProducts();
  if (view === 'receiving') {
    renderReceiving();
    await loadHistory(false, sequence);
  }
  if (view === 'account') renderAccount();
}
function renderStock() {
  document.querySelector('#main').innerHTML =
    pageHeader(
      'VISIBILIDADE DA OPERAÇÃO',
      'Estoque por galpão',
      'Consulte os produtos disponíveis e o saldo de cada lote.',
      `<button class="button button-primary" id="new-receipt">${icon('plus')} Registrar entrada</button>`,
    ) +
    `<div class="stats"><article class="stat-card"><div><div class="stat-label">Galpão selecionado</div><div class="stat-value" id="stock-warehouse">${esc(state.warehouseId || '—')}</div><div class="stat-detail">${esc(warehouseName())}</div></div><div class="stat-icon">${icon('stock')}</div></article><article class="stat-card"><div><div class="stat-label">Unidades listadas</div><div class="stat-value" id="stock-units">—</div><div class="stat-detail">Soma das linhas carregadas</div></div><div class="stat-icon">${icon('box')}</div></article><article class="stat-card"><div><div class="stat-label">Linhas nesta consulta</div><div class="stat-value" id="stock-lines">—</div><div class="stat-detail">Um registro por produto e lote</div></div><div class="stat-icon">${icon('barcode')}</div></article></div><section class="panel"><div class="panel-header"><div><h2>Produtos em estoque</h2><p>${esc(warehouseName())} · Consulte outro galpão no seletor acima</p></div><button class="button button-secondary" id="refresh-stock">${icon('refresh')} Atualizar</button></div><div class="toolbar"><form id="stock-search" class="search-form"><div class="search-wrap">${icon('search')}<input class="input" name="skuId" id="stock-sku" aria-label="Buscar estoque por SKU" placeholder="Filtrar pelo SKU exato" value="${esc(state.stockFilter)}" maxlength="64" /></div><button class="button button-secondary" type="submit">Buscar</button></form><p class="inventory-caption">Saldo por produto e lote</p></div><div id="stock-table"><div class="loading" role="status">Consultando o estoque…</div></div></section><p class="section-note">${icon('info')}O saldo considera as entradas concluídas. A consulta geral pode levar alguns instantes para refletir uma nova entrada.</p>`;
  document.querySelector('#new-receipt').addEventListener('click', () => navigate('receiving'));
  document.querySelector('#refresh-stock').addEventListener('click', () => loadStock());
  document.querySelector('#stock-search').addEventListener('submit', (event) => {
    event.preventDefault();
    state.stockFilter = document.querySelector('#stock-sku').value.trim();
    loadStock();
  });
}
async function loadStock(more = false, sequence = state.sequence) {
  const request = (state.stockRequest = (state.stockRequest || 0) + 1);
  const table = document.querySelector('#stock-table');
  if (!table) return;
  if (!state.warehouseId) {
    table.innerHTML = empty(
      'Nenhum galpão disponível',
      'Peça ao administrador acesso a um galpão para consultar o estoque.',
    );
    return;
  }
  if (!more) {
    state.stock = [];
    state.stockCursor = undefined;
    table.innerHTML = '<div class="loading" role="status">Consultando o estoque…</div>';
  }
  const moreButton = document.querySelector('#more-stock');
  if (moreButton) moreButton.disabled = true;
  try {
    const endpoint = `/warehouses/${encodeURIComponent(state.warehouseId)}/stock${state.stockFilter ? `/${encodeURIComponent(state.stockFilter)}` : ''}?limit=50${more && state.stockCursor ? `&cursor=${encodeURIComponent(state.stockCursor)}` : ''}`;
    const page = await api(endpoint);
    if (sequence !== state.sequence || request !== state.stockRequest) return;
    state.stock.push(...page.items);
    state.stockCursor = page.cursor;
    document.querySelector('#stock-units').textContent = number(
      state.stock.reduce((sum, row) => sum + row.quantity, 0),
    );
    document.querySelector('#stock-lines').textContent = number(state.stock.length);
    table.innerHTML = state.stock.length
      ? `<div class="table-scroll"><table><thead><tr><th>Produto</th><th>SKU</th><th>Lote</th><th>Quantidade</th><th>Galpão</th></tr></thead><tbody>${state.stock.map((row) => `<tr><td><div class="product-cell"><span class="product-symbol">${icon('box')}</span><div class="primary-text">${esc(productName(row.skuId))}</div></div></td><td class="mono">${esc(row.skuId)}</td><td>${esc(row.lotCode || 'Sem lote')}</td><td><span class="quantity">${number(row.quantity)}</span><span class="secondary-text"> un.</span></td><td><span class="badge badge-neutral">${esc(state.warehouseId)}</span></td></tr>`).join('')}</tbody></table></div><div class="table-footer"><span>${number(state.stock.length)} linhas carregadas${page.cursor ? ' · Há mais resultados' : ''}</span>${page.cursor ? '<button type="button" id="more-stock" class="button button-quiet">Carregar mais</button>' : '<span>Fim da consulta</span>'}</div>`
      : empty(
          'Este estoque ainda está vazio',
          state.stockFilter
            ? 'Nenhum saldo para o SKU informado neste galpão.'
            : 'Registre uma entrada para começar a acompanhar os produtos deste galpão.',
        );
    document.querySelector('#more-stock')?.addEventListener('click', () => loadStock(true));
  } catch (error) {
    if (sequence === state.sequence && request === state.stockRequest) {
      table.innerHTML = empty('Não foi possível consultar', error.message);
      showFailure(error);
    }
  }
}
function renderProducts(formProduct) {
  const main = document.querySelector('#main');
  main.innerHTML =
    pageHeader(
      'CATÁLOGO DA ORGANIZAÇÃO',
      'Produtos',
      'Cadastre o produto uma vez. Identifique-o pelo SKU ou pelo código de barras.',
      isAdmin()
        ? `<button id="new-product" class="button button-primary">${icon('plus')} Cadastrar produto</button>`
        : '',
    ) +
    `<section id="product-editor" class="panel" ${formProduct ? '' : 'hidden'}><div class="panel-header"><div><h2>${formProduct?.skuId ? 'Editar produto' : 'Novo produto'}</h2><p>O usuário responsável pelo cadastro é registrado automaticamente.</p></div><button type="button" id="close-product" class="icon-button" aria-label="Fechar cadastro">×</button></div><div class="panel-body"><form id="product-form"><div id="product-error" class="alert alert-error" role="alert" hidden></div><div class="form-grid"><div class="field"><label for="product-name">Nome do produto</label><input id="product-name" name="name" required maxlength="128" placeholder="Ex.: Caixa organizadora 40 L" value="${esc(formProduct?.name || '')}" /></div><div class="field"><label for="product-sku">SKU / código interno</label><input id="product-sku" name="skuId" required maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9._-]*" placeholder="Ex.: CX-0040" value="${esc(formProduct?.skuId || '')}" ${formProduct?.skuId ? 'readonly' : ''} /><p class="hint">Use letras, números, ponto, hífen ou sublinhado.</p></div><div class="field"><label for="product-barcode">Código de barras <span class="muted small">(opcional)</span></label><input id="product-barcode" name="barcode" maxlength="128" placeholder="Leia ou digite o código do produto" value="${esc(formProduct?.barcode || '')}" /><p class="hint">Use o leitor USB/Bluetooth ou informe o código da embalagem.</p></div><div class="field"><label for="product-mode">Controle do recebimento</label><select id="product-mode" name="trackingMode" ${formProduct?.skuId ? 'disabled' : ''}><option value="BULK" ${formProduct?.trackingMode === 'BULK' ? 'selected' : ''}>Por quantidade</option><option value="SERIALIZED" ${formProduct?.trackingMode === 'SERIALIZED' ? 'selected' : ''}>Por número de série</option></select><p class="hint">O tipo de controle não pode mudar após o cadastro.</p></div></div><div class="form-actions"><label class="check-label"><input id="product-active" type="checkbox" ${formProduct?.active === false ? '' : 'checked'} /> Produto ativo</label><button type="button" class="button button-secondary" id="cancel-product">Cancelar</button><button type="submit" id="save-product" class="button button-primary">${formProduct?.skuId ? 'Salvar alterações' : 'Cadastrar produto'}</button></div></form></div></section><section class="panel"><div class="panel-header"><div><h2>Catálogo de produtos</h2><p>Produtos compartilhados pelos galpões da organização</p></div><span class="badge badge-neutral">${number(state.products.length)} carregados</span></div><div id="products-table">${productsTable()}</div></section><p class="section-note">${icon('shield')}O autor original do cadastro permanece registrado mesmo quando outro usuário edita o produto.</p>`;
  document.querySelector('#new-product')?.addEventListener('click', () => {
    renderProducts({});
    document.querySelector('#product-editor').hidden = false;
    document.querySelector('#product-name').focus();
  });
  for (const id of ['close-product', 'cancel-product'])
    document.querySelector(`#${id}`)?.addEventListener('click', () => renderProducts());
  document.querySelectorAll('[data-edit-product]').forEach((button) =>
    button.addEventListener('click', () => {
      renderProducts(state.products.find((p) => p.skuId === button.dataset.editProduct));
      document.querySelector('#product-name').focus();
    }),
  );
  document.querySelector('#more-products')?.addEventListener('click', loadMoreProducts);
  document.querySelector('#product-barcode').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      document.querySelector('#save-product').focus();
    }
  });
  document.querySelector('#product-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const subject = state.user.subject;
    const organization = state.user.organizationId;
    const button = document.querySelector('#save-product');
    setButton(button, true, 'Salvando…');
    document.querySelector('#product-error').hidden = true;
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const body = {
      name: values.name.trim(),
      trackingMode: formProduct?.trackingMode || values.trackingMode,
      active: document.querySelector('#product-active').checked,
      ...(values.barcode.trim() ? { barcode: values.barcode.trim() } : {}),
    };
    try {
      const saved = await api(`/products/${encodeURIComponent(values.skuId.trim())}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      if (state.user?.subject !== subject || state.user?.organizationId !== organization) return;
      const index = state.products.findIndex((p) => p.skuId === saved.skuId);
      if (index >= 0) state.products[index] = saved;
      else state.products.unshift(saved);
      if (state.view === 'products') renderProducts();
      toast('Produto salvo. O responsável pelo cadastro foi registrado.');
    } catch (error) {
      showFailure(error, document.querySelector('#product-error'));
      setButton(button, false, 'Salvar produto');
    }
  });
}
function productsTable() {
  if (!state.products.length)
    return empty(
      'Seu catálogo começa aqui',
      'Cadastre os produtos para localizar seus códigos e registrar recebimentos.',
    );
  return `<div class="table-scroll"><table><thead><tr><th>Produto</th><th>Código de barras</th><th>Controle</th><th>Cadastrado por</th><th>Situação</th>${isAdmin() ? '<th><span class="sr-only">Ações</span></th>' : ''}</tr></thead><tbody>${state.products.map((product) => `<tr><td><div class="product-cell"><span class="product-symbol">${icon('box')}</span><div><div class="primary-text">${esc(product.name || product.skuId)}</div><div class="secondary-text mono">${esc(product.skuId)}</div></div></div></td><td class="mono">${esc(product.barcode || '—')}</td><td>${product.trackingMode === 'SERIALIZED' ? 'Número de série' : 'Quantidade'}</td><td><div class="primary-text">${esc(nameOf(product.createdBy))}</div><div class="secondary-text">${date(product.createdAt)}</div></td><td><span class="badge ${product.active ? '' : 'badge-neutral'}">${product.active ? 'Ativo' : 'Inativo'}</span></td>${isAdmin() ? `<td><button class="button button-quiet" data-edit-product="${esc(product.skuId)}" aria-label="Editar ${esc(product.name || product.skuId)}">Editar</button></td>` : ''}</tr>`).join('')}</tbody></table></div><div class="table-footer"><span>${number(state.products.length)} produtos carregados</span>${state.productCursor ? '<button id="more-products" class="button button-quiet">Carregar mais</button>' : '<span>Fim do catálogo</span>'}</div>`;
}
async function loadMoreProducts() {
  const sequence = state.sequence;
  const button = document.querySelector('#more-products');
  if (button) button.disabled = true;
  try {
    const page = await api(`/products?limit=50&cursor=${encodeURIComponent(state.productCursor)}`);
    if (sequence !== state.sequence) return;
    for (const product of page.items)
      if (!state.products.some((p) => p.skuId === product.skuId)) state.products.push(product);
    state.productCursor = page.cursor;
    if (sequence === state.sequence) renderProducts();
  } catch (error) {
    showFailure(error);
    if (button) button.disabled = false;
  }
}

function renderReceiving() {
  const main = document.querySelector('#main');
  main.innerHTML =
    pageHeader(
      'RECEBIMENTO DE MERCADORIAS',
      'Registrar entrada',
      'Leia o código do produto e confirme a entrada no galpão selecionado.',
    ) +
    `<div class="split-layout"><section class="panel"><div class="panel-header"><div><h2>Nova entrada · ${esc(state.warehouseId || 'Selecione um galpão')}</h2><p>${esc(warehouseName())}</p></div><span class="badge badge-neutral">${icon('receive')} Recebimento</span></div><div class="panel-body" id="receiving-form-area"></div></section><aside class="panel receiving-guide"><div class="guide"><div class="guide-icon">${icon('barcode')}</div><h2>Do código ao registro</h2><p>Use a câmera, um leitor conectado ou digite o código. Os dados do cadastro são preenchidos automaticamente.</p><ol class="steps"><li>Selecione o galpão que está recebendo os produtos.</li><li>Leia o código e confira o produto localizado.</li><li>Informe a quantidade ou o número de série e confirme.</li></ol><hr class="form-divider"/><p class="section-note">${icon('shield')}Data, horário e usuário ficam registrados na entrada.</p></div></aside></div><section class="panel"><div class="panel-header"><div><h2>Histórico de entradas</h2><p>Acompanhe o processamento e quem registrou cada recebimento</p></div><button id="refresh-history" class="button button-secondary">${icon('refresh')} Atualizar</button></div><div id="history-table"><div class="loading" role="status">Carregando as entradas…</div></div></section>`;
  renderReceiptForm();
  document.querySelector('#refresh-history').addEventListener('click', () => loadHistory());
}
function renderReceiptForm() {
  const area = document.querySelector('#receiving-form-area');
  if (!area) return;
  if (!state.warehouseId) {
    area.innerHTML = empty(
      'Selecione um galpão',
      'Você precisa de acesso a um galpão para registrar uma entrada.',
    );
    return;
  }
  if (state.result && state.result.warehouseId !== state.warehouseId) state.result = null;
  if (state.result) {
    renderReceiptResult();
    return;
  }
  const pending = state.receipt;
  if (pending && pending.warehouseId !== state.warehouseId) {
    area.innerHTML = `<div class="alert">Existe uma entrada aguardando confirmação no galpão <strong>${esc(pending.warehouseId)}</strong>. Resolva essa entrada antes de iniciar outra.</div><button class="button button-primary" id="resume-warehouse">Voltar ao galpão da entrada</button>`;
    document.querySelector('#resume-warehouse').addEventListener('click', () => {
      state.warehouseId = pending.warehouseId;
      navigate('receiving');
    });
    return;
  }
  if (pending) {
    area.innerHTML = `<div class="alert" role="status">A resposta ainda precisa ser confirmada. O mesmo registro será reenviado, preservando a referência e evitando uma entrada duplicada.</div><div class="metadata"><div class="meta-row"><span>Produto</span><strong>${esc(pending.body.skuId)}</strong></div><div class="meta-row"><span>Quantidade</span><strong>${number(pending.body.mode === 'SERIALIZED' ? 1 : pending.body.quantity)}</strong></div><div class="meta-row"><span>Referência</span><strong class="mono">${esc(pending.body.externalReference)}</strong></div><div class="meta-row"><span>Data e hora</span><strong>${date(pending.body.occurredAt)}</strong></div></div><div id="receipt-error" class="alert alert-error" role="alert" hidden></div><button id="retry-receipt" class="button button-primary">Confirmar o mesmo registro</button>`;
    document.querySelector('#retry-receipt').addEventListener('click', submitReceipt);
    return;
  }
  const product = state.entryProduct;
  const warehouse = state.warehouses.find((w) => w.warehouseId === state.warehouseId);
  if (warehouse && !warehouse.active) {
    area.innerHTML = empty(
      'Este galpão está inativo',
      'As entradas anteriores permanecem no histórico. Selecione um galpão ativo para continuar.',
    );
    return;
  }
  area.innerHTML = `<div class="scan-box"><div class="scan-heading">${icon('barcode')}<h3>Identifique o produto</h3></div><form id="lookup-form"><label for="scan-code" class="sr-only">Código de barras ou SKU</label><div class="input-row"><input id="scan-code" class="input" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="128" required placeholder="Código de barras ou SKU" value="${esc(product?.barcode || product?.skuId || '')}" /><button type="submit" class="button button-primary" id="lookup-submit">Localizar</button></div></form><div class="scan-buttons"><button type="button" class="button button-secondary" id="open-camera">${icon('camera')} Ler com a câmera</button><button type="button" class="button button-quiet" id="focus-scanner">${icon('barcode')} Usar leitor conectado</button></div><p class="hint">Leitores USB/Bluetooth funcionam como teclado. Leia o código e pressione Enter, se necessário.</p></div><div id="lookup-error" class="alert alert-error" role="alert" hidden></div>${product ? `<div class="found-product"><div><h3>${esc(product.name || product.skuId)}</h3><p>${esc(product.skuId)} · ${product.trackingMode === 'SERIALIZED' ? 'Controle por número de série' : 'Controle por quantidade'}</p></div><span class="badge">Localizado</span></div><form id="receipt-form"><div id="receipt-error" class="alert alert-error" role="alert" hidden></div><div class="form-grid">${product.trackingMode === 'SERIALIZED' ? '<div class="field span-full"><label for="receipt-serial">Número de série da unidade</label><input id="receipt-serial" name="serialNumber" required maxlength="128" autocomplete="off" placeholder="Leia ou digite o número de série"/><p class="hint">O código do produto identifica o modelo. O número de série identifica esta unidade.</p></div>' : '<div class="field"><label for="receipt-quantity">Quantidade recebida</label><input id="receipt-quantity" name="quantity" type="number" min="1" max="1000000" step="1" value="1" required /></div><div class="field"><label for="receipt-lot">Lote <span class="muted small">(opcional)</span></label><input id="receipt-lot" name="lotCode" maxlength="128" placeholder="Ex.: LOTE-001" /></div>'}</div><div class="metadata"><div class="meta-row"><span>Responsável pela entrada</span><strong>${esc(state.user.displayName || state.user.subject)}</strong></div><div class="meta-row"><span>Galpão de destino</span><strong>${esc(warehouseName())}</strong></div><div class="meta-row"><span>Data, hora e referência</span><strong>Preenchidas ao confirmar</strong></div></div><div class="form-actions"><button id="clear-entry" class="button button-secondary" type="button">Limpar</button><button id="save-receipt" class="button button-primary" type="submit">${icon('check')} Confirmar entrada</button></div></form>` : empty('Pronto para receber', 'Leia um código para preencher o produto automaticamente.')}`;
  document.querySelector('#lookup-form').addEventListener('submit', (event) => {
    event.preventDefault();
    lookupProduct(document.querySelector('#scan-code').value.trim());
  });
  document.querySelector('#focus-scanner').addEventListener('click', () => {
    document.querySelector('#scan-code').focus();
    document.querySelector('#scan-code').select();
  });
  document.querySelector('#open-camera').addEventListener('click', openCamera);
  document.querySelector('#clear-entry')?.addEventListener('click', () => {
    state.entryProduct = null;
    renderReceiptForm();
    document.querySelector('#scan-code')?.focus();
  });
  document.querySelector('#receipt-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (submitting || state.receipt) return;
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const body = {
      mode: product.trackingMode,
      skuId: product.skuId,
      externalReference: `RECEB-${crypto.randomUUID()}`,
      occurredAt: new Date().toISOString(),
      ...(product.trackingMode === 'SERIALIZED'
        ? { serialNumber: values.serialNumber.trim() }
        : {
            quantity: Number(values.quantity),
            ...(values.lotCode.trim() ? { lotCode: values.lotCode.trim() } : {}),
          }),
    };
    state.receipt = {
      subject: state.user.subject,
      organizationId: state.user.organizationId,
      warehouseId: state.warehouseId,
      key: crypto.randomUUID(),
      body,
    };
    rememberReceipt();
    submitReceipt();
  });
}
async function lookupProduct(code) {
  if (!code) return;
  const request = (state.lookupRequest = (state.lookupRequest || 0) + 1);
  const sequence = state.sequence;
  const button = document.querySelector('#lookup-submit');
  if (button) setButton(button, true, 'Localizando…');
  const errorBox = document.querySelector('#lookup-error');
  if (errorBox) errorBox.hidden = true;
  try {
    const product = await api(`/products/lookup?code=${encodeURIComponent(code)}`);
    if (sequence !== state.sequence || request !== state.lookupRequest) return;
    if (!product.active)
      throw new ApiError(409, 'Este produto está inativo e não pode receber novas entradas.');
    state.entryProduct = product;
    if (!state.products.some((p) => p.skuId === product.skuId)) state.products.push(product);
    renderReceiptForm();
    document
      .querySelector(product.trackingMode === 'SERIALIZED' ? '#receipt-serial' : '#receipt-quantity')
      ?.focus();
  } catch (error) {
    if (sequence !== state.sequence || request !== state.lookupRequest) return;
    state.entryProduct = null;
    renderReceiptForm();
    if (error.status === 404)
      error.message =
        'Código não encontrado. Cadastre o produto e vincule o código de barras antes de receber.';
    showFailure(error, document.querySelector('#lookup-error'));
    if (error.status === 404 && isAdmin()) {
      const create = document.createElement('button');
      create.type = 'button';
      create.className = 'button button-quiet';
      create.textContent = 'Cadastrar produto com este código';
      create.addEventListener('click', async () => {
        await navigate('products');
        renderProducts({ barcode: code });
        document.querySelector('#product-name').focus();
      });
      document.querySelector('#lookup-error').append(create);
    }
  }
}
let submitting = false;
async function submitReceipt() {
  if (submitting || !state.receipt) return;
  submitting = true;
  const pending = state.receipt;
  for (const button of document.querySelectorAll('#receiving-form-area button')) button.disabled = true;
  try {
    const entry = await api(`/warehouses/${encodeURIComponent(pending.warehouseId)}/receiving-entries`, {
      method: 'POST',
      headers: { 'Idempotency-Key': pending.key },
      body: JSON.stringify(pending.body),
    });
    if (state.user?.subject !== pending.subject || state.user?.organizationId !== pending.organizationId)
      return;
    state.receipt = null;
    rememberReceipt();
    state.result = entry;
    state.entryProduct = null;
    if (state.view === 'receiving') {
      renderReceiptForm();
      await loadHistory();
      if (state.warehouseId === pending.warehouseId)
        pollEntry(entry.entryId, pending.warehouseId, state.sequence);
    }
    toast(`Entrada registrada no galpão ${pending.warehouseId}. Acompanhe a confirmação do estoque.`);
  } catch (error) {
    // A network/5xx failure can occur after commit. Preserve the exact original request for safe replay.
    if (error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 429) {
      state.receipt = null;
      rememberReceipt();
    }
    if (state.view === 'receiving') {
      renderReceiptForm();
      showFailure(error, document.querySelector('#receipt-error') || document.querySelector('#lookup-error'));
    } else showFailure(error);
  } finally {
    submitting = false;
  }
}
function renderReceiptResult() {
  const result = state.result;
  if (!result || !document.querySelector('#receiving-form-area')) return;
  const terminal = result.status !== 'ACCEPTED';
  document.querySelector('#receiving-form-area').innerHTML =
    `<div class="success-card"><div class="success-heading">${icon(result.status === 'REJECTED' ? 'info' : 'check')}<h2>${result.status === 'APPLIED' ? 'Entrada concluída' : result.status === 'REJECTED' ? 'Entrada não aplicada' : 'Entrada registrada'}</h2></div><p>${result.status === 'APPLIED' ? 'O recebimento foi aplicado ao estoque do galpão.' : result.status === 'REJECTED' ? 'O estoque não foi alterado. Confira o motivo abaixo.' : 'Seu registro foi salvo. O estoque será atualizado após o processamento.'}</p><div class="metadata"><div class="meta-row"><span>Produto</span><strong>${esc(productName(result.entry.skuId))}</strong></div><div class="meta-row"><span>Quantidade</span><strong>${number(result.quantity)} un.</strong></div><div class="meta-row"><span>Registrado por</span><strong>${esc(nameOf(result.recordedBy))}</strong></div><div class="meta-row"><span>Data e hora</span><strong>${date(result.acceptedAt)}</strong></div><div class="meta-row"><span>Situação</span><strong>${badge(result.status)}</strong></div>${result.rejectionReason ? `<div class="meta-row"><span>Motivo</span><strong>${esc(result.rejectionReason === 'SERIAL_ALREADY_RECEIVED' ? 'Número de série já recebido' : result.rejectionReason)}</strong></div>` : ''}</div><div class="form-actions"><button id="check-entry" class="button button-secondary">${icon('refresh')} ${terminal ? 'Consultar novamente' : 'Verificar situação'}</button><button id="another-entry" class="button button-primary">${icon('plus')} Nova entrada</button></div></div>`;
  document.querySelector('#another-entry').addEventListener('click', () => {
    state.result = null;
    state.entryProduct = null;
    renderReceiptForm();
    document.querySelector('#scan-code')?.focus();
  });
  document.querySelector('#check-entry').addEventListener('click', async () => {
    const sequence = state.sequence;
    try {
      const updated = await api(
        `/warehouses/${encodeURIComponent(result.warehouseId)}/receiving-entries/${result.entryId}`,
      );
      if (sequence !== state.sequence || state.result?.entryId !== result.entryId) return;
      state.result = updated;
      renderReceiptResult();
      loadHistory();
    } catch (error) {
      showFailure(error);
    }
  });
}
async function pollEntry(id, warehouse, sequence) {
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (sequence !== state.sequence || state.result?.entryId !== id) return;
    try {
      const entry = await api(`/warehouses/${encodeURIComponent(warehouse)}/receiving-entries/${id}`);
      if (sequence !== state.sequence || state.result?.entryId !== id) return;
      state.result = entry;
      renderReceiptResult();
      if (entry.status !== 'ACCEPTED') {
        await loadHistory();
        return;
      }
    } catch (error) {
      if (error.status === 401) showFailure(error);
      return;
    }
  }
}
async function loadHistory(more = false, sequence = state.sequence) {
  const request = (state.historyRequest = (state.historyRequest || 0) + 1);
  const table = document.querySelector('#history-table');
  if (!table) return;
  if (!state.warehouseId) {
    table.innerHTML = empty('Nenhum galpão selecionado', 'Selecione um galpão para ver suas entradas.');
    return;
  }
  if (!more) {
    state.history = [];
    state.historyCursor = undefined;
    table.innerHTML = '<div class="loading" role="status">Carregando as entradas…</div>';
  }
  const button = document.querySelector('#more-history');
  if (button) button.disabled = true;
  try {
    const page = await api(
      `/warehouses/${encodeURIComponent(state.warehouseId)}/receiving-entries?limit=20${more && state.historyCursor ? `&cursor=${encodeURIComponent(state.historyCursor)}` : ''}`,
    );
    if (sequence !== state.sequence || request !== state.historyRequest) return;
    for (const entry of page.items)
      if (!state.history.some((e) => e.entryId === entry.entryId)) state.history.push(entry);
    state.historyCursor = page.cursor;
    table.innerHTML = state.history.length
      ? `<div class="table-scroll"><table><thead><tr><th>Produto</th><th>Quantidade</th><th>Registrado por</th><th>Recebimento</th><th>Situação</th></tr></thead><tbody>${state.history.map((entry) => `<tr><td><div class="primary-text">${esc(productName(entry.entry.skuId))}</div><div class="secondary-text mono">${esc(entry.entry.skuId)}${entry.entry.serialNumber ? ` · ${esc(entry.entry.serialNumber)}` : ''}</div></td><td><span class="quantity">${number(entry.quantity)}</span></td><td><div class="primary-text">${esc(nameOf(entry.recordedBy))}</div></td><td>${date(entry.acceptedAt)}</td><td>${badge(entry.status)}</td></tr>`).join('')}</tbody></table></div><div class="table-footer"><span>${number(state.history.length)} entradas carregadas</span>${page.cursor ? '<button id="more-history" class="button button-quiet">Carregar mais</button>' : '<span>Fim do histórico</span>'}</div>`
      : empty(
          'Nenhuma entrada por aqui',
          'Os recebimentos deste galpão aparecerão aqui, com o usuário responsável e a situação.',
        );
    document.querySelector('#more-history')?.addEventListener('click', () => loadHistory(true));
  } catch (error) {
    if (sequence === state.sequence && request === state.historyRequest) {
      table.innerHTML = empty('Não foi possível carregar o histórico', error.message);
      showFailure(error);
    }
  }
}
function renderAccount() {
  document.querySelector('#main').innerHTML =
    pageHeader(
      'ACESSO E IDENTIFICAÇÃO',
      'Minha conta',
      'Sua identidade acompanha os produtos cadastrados e as entradas registradas.',
    ) +
    `<section class="panel account-card"><div class="panel-header"><div><h2>${esc(state.user.displayName || state.user.subject)}</h2><p>${esc(state.user.organizationId)} · ${isAdmin() ? 'Administrador' : 'Operador'}</p></div><span class="avatar">${esc((state.user.displayName || state.user.subject).slice(0, 2).toUpperCase())}</span></div><div class="panel-body"><div class="metadata"><div class="meta-row"><span>Identificador do usuário</span><strong>${esc(state.user.subject)}</strong></div><div class="meta-row"><span>Galpões autorizados</span><strong>${esc(state.user.warehouseIds.join(', ') || 'Nenhum')}</strong></div></div><h3>Alterar senha</h3><p class="muted">Use uma senha exclusiva, com pelo menos 12 caracteres. Após a alteração, entre novamente.</p><form id="password-form"><div id="password-error" class="alert alert-error" role="alert" hidden></div><div class="field"><label for="current-password">Senha atual</label><input id="current-password" name="currentPassword" type="password" autocomplete="current-password" required maxlength="128"/></div><div class="field"><label for="new-password">Nova senha</label><input id="new-password" name="newPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="128"/></div><div class="field"><label for="confirm-password">Confirmar nova senha</label><input id="confirm-password" type="password" autocomplete="new-password" required minlength="12" maxlength="128"/></div><div class="form-actions"><button id="change-password" class="button button-primary" type="submit">Alterar senha</button></div></form></div></section>`;
  document.querySelector('#password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorBox = document.querySelector('#password-error');
    errorBox.hidden = true;
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (values.newPassword !== document.querySelector('#confirm-password').value) {
      showFailure(new Error('As duas senhas novas precisam ser iguais.'), errorBox);
      return;
    }
    const button = document.querySelector('#change-password');
    setButton(button, true, 'Alterando…');
    try {
      await api('/auth/password', { method: 'POST', body: JSON.stringify(values) });
      state.user = null;
      state.csrfToken = null;
      renderLogin();
      toast('Senha alterada. Entre novamente com sua nova senha.');
    } catch (error) {
      showFailure(error, errorBox);
      setButton(button, false, 'Alterar senha');
    }
  });
}
let cameraAttempt = 0;
function closeCamera() {
  cameraAttempt++;
  scanner.stop();
  if (cameraDialog.open) cameraDialog.close();
}
async function openCamera() {
  const attempt = ++cameraAttempt;
  document.querySelector('#camera-message').textContent =
    'Permita o uso da câmera e mantenha o código dentro da área indicada.';
  cameraDialog.showModal();
  try {
    await scanner.start((code) => {
      closeCamera();
      if (state.view === 'receiving' && !state.receipt) lookupProduct(code);
    });
  } catch (error) {
    if (attempt !== cameraAttempt) return;
    scanner.stop();
    document.querySelector('#camera-message').textContent =
      error.name === 'NotAllowedError'
        ? 'A câmera não foi autorizada. Permita o acesso no navegador ou use um leitor conectado.'
        : error.name === 'NotFoundError'
          ? 'Nenhuma câmera foi encontrada. Use um leitor conectado ou digite o código.'
          : error.message || 'Não foi possível abrir a câmera. Use o leitor conectado ou digite o código.';
  }
}
document.querySelector('#camera-close').addEventListener('click', closeCamera);
document.querySelector('#camera-cancel').addEventListener('click', closeCamera);
cameraDialog.addEventListener('cancel', closeCamera);
cameraDialog.addEventListener('close', () => scanner.stop());
window.addEventListener('pagehide', () => scanner.stop());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) closeCamera();
});

try {
  await startSession();
} catch (error) {
  renderLogin(error.status === 401 ? '' : error.message);
}
