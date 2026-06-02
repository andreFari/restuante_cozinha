const TERMINAL_KEY = "restaurant_terminal_id";
const OPERATOR_KEY = "restaurant_operator_id";

export function getTerminalId() {
  const existing = localStorage.getItem(TERMINAL_KEY);
  if (existing) return existing;
  const fallback = window.location.pathname.includes("cozinha")
    ? "terminal_kitchen"
    : "terminal_main";
  localStorage.setItem(TERMINAL_KEY, fallback);
  return fallback;
}

export function setTerminalId(terminalId) {
  localStorage.setItem(TERMINAL_KEY, terminalId);
}

export function getOperatorId() {
  return localStorage.getItem(OPERATOR_KEY) || "";
}

export function setOperatorId(operatorId) {
  localStorage.setItem(OPERATOR_KEY, operatorId);
}

export function clearOperatorId() {
  localStorage.removeItem(OPERATOR_KEY);
}

const CACHE_PREFIX = "restaurant.web.read-cache.v2:";
const readCache = new Map();
const inFlightReadCache = new Map();
let readCacheVersion = 0;

const CACHE_TTL = {
  bootstrap: 2500,
  tables: 1200,
  table: 900,
  history: 3500,
  operators: 30000,
  operatorContext: 5000,
  workers: 30000,
  pendingPayments: 1500,
  managedTables: 15000,
  qrSettings: 30000,
  tableQr: 30000,
  menuItems: 60000,
  menuProfiles: 300000,
  menuConfig: 30000,
  categories: 120000,
  printers: 20000,
  kitchen: 1000,
  serviceBoard: 1000,
  invoices: 8000,
  takeawayChatOrders: 3000,
};

function cachePart(value) {
  return encodeURIComponent(String(value ?? ""));
}

function cacheStorageKey(key) {
  return `${CACHE_PREFIX}${key}`;
}

function readPersistedCache(key) {
  try {
    const raw = sessionStorage.getItem(cacheStorageKey(key));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || typeof entry !== "object" || !("expiresAt" in entry) || !("value" in entry)) return null;
    readCache.set(key, entry);
    return entry;
  } catch {
    return null;
  }
}

function writePersistedCache(key, entry) {
  try {
    sessionStorage.setItem(cacheStorageKey(key), JSON.stringify(entry));
  } catch {
    // Sem espaço/privacidade: a cache em memória continua a funcionar.
  }
}

function invalidateReadCache(...prefixes) {
  readCacheVersion += 1;
  if (!prefixes.length) {
    readCache.clear();
    inFlightReadCache.clear();
    Object.keys(sessionStorage)
      .filter((key) => key.startsWith(CACHE_PREFIX))
      .forEach((key) => sessionStorage.removeItem(key));
    return;
  }

  const shouldRemove = (key) => prefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}:`));
  Array.from(readCache.keys()).forEach((key) => {
    if (shouldRemove(key)) readCache.delete(key);
  });
  Array.from(inFlightReadCache.keys()).forEach((key) => {
    if (shouldRemove(key)) inFlightReadCache.delete(key);
  });
  Object.keys(sessionStorage)
    .filter((key) => key.startsWith(CACHE_PREFIX))
    .filter((key) => shouldRemove(key.slice(CACHE_PREFIX.length)))
    .forEach((key) => sessionStorage.removeItem(key));
}

async function cachedRequest(key, ttlMs, url, options = {}) {
  const now = Date.now();
  const memoryHit = readCache.get(key);
  if (memoryHit?.expiresAt > now) return memoryHit.value;

  const persistedHit = readPersistedCache(key);
  if (persistedHit?.expiresAt > now) return persistedHit.value;

  const existing = inFlightReadCache.get(key);
  if (existing) return existing;

  const cacheVersionAtStart = readCacheVersion;
  const promise = request(url, options)
    .then((value) => {
      if (cacheVersionAtStart === readCacheVersion) {
        const entry = { value, savedAt: Date.now(), expiresAt: Date.now() + Math.max(0, ttlMs) };
        readCache.set(key, entry);
        writePersistedCache(key, entry);
      }
      return value;
    })
    .catch((error) => {
      if (memoryHit) return memoryHit.value;
      if (persistedHit) return persistedHit.value;
      throw error;
    })
    .finally(() => {
      inFlightReadCache.delete(key);
    });

  inFlightReadCache.set(key, promise);
  return promise;
}

function invalidateAfterMutation(url, method) {
  if (String(method || "GET").toUpperCase() === "GET") return;
  const prefixes = new Set();
  const add = (...items) => items.forEach((item) => prefixes.add(item));

  if (url.includes("/demo/") || url.includes("/auth/login") || url.includes("/auth/logout")) {
    invalidateReadCache();
    return;
  }
  if (url.includes("/operators/")) add("operator-context", "operators", "bootstrap");
  if (url.includes("/workers")) add("workers", "operators", "operator-context", "bootstrap");
  if (url.includes("/tables/manage")) add("managed-tables", "tables", "bootstrap", "table-qr");
  if (url.includes("/settings/qr") || url.includes("/qr/regenerate")) add("qr-settings", "table-qr", "managed-tables");
  if (url.includes("/categories") || url.includes("/menu-items") || url.includes("/menu-config") || url.includes("/uploads/menu-image")) {
    add("menu-items", "categories", "menu-profiles", "menu-config", "bootstrap", "kitchen", "service-board");
  }
  if (url.includes("/payment-requests") || url.includes("/tables/open") || url.includes("/tables/") || url.includes("/kitchen/items/")) {
    add("bootstrap", "tables", "kitchen", "service-board", "pending-payments", "history", "invoices");
    const tableMatch = url.match(/\/api\/restaurant\/tables\/([^/]+)/);
    if (tableMatch?.[1] && !["manage", "open"].includes(tableMatch[1])) {
      add(`table:${cachePart(decodeURIComponent(tableMatch[1]))}`);
    }
  }
  if (url.includes("/checkout") || url.includes("/payment-intents/")) add("bootstrap", "tables", "invoices", "printers");
  if (url.includes("/printers")) add("printers");
  if (url.includes("/takeaway-chat/orders")) add("takeaway-chat-orders", "bootstrap", "tables");
  if (url.includes("/assistant/actions/confirm")) add("menu-items", "menu-profiles", "menu-config", "bootstrap", "kitchen", "service-board");

  if (prefixes.size) {
    invalidateReadCache(...Array.from(prefixes));
    return;
  }

  // Segurança primeiro: qualquer POST/PATCH/DELETE não reconhecido limpa cache toda.
  // Assim endpoints novos nunca deixam a UI presa a dados antigos depois de uma escrita.
  invalidateReadCache();
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      ...((options.body && !(options.body instanceof FormData)) ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { detail: text };
    }
  }
  if (!response.ok) {
    throw new Error(data?.detail || data?.error || `HTTP ${response.status}`);
  }

  invalidateAfterMutation(url, options.method || "GET");
  return data;
}

export const restaurantApi = {
  login(email, password) {
    return request(`/api/restaurant/auth/login`, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  },
  getAuthSession() {
    return request(`/api/restaurant/auth/me`);
  },
  logout() {
    clearOperatorId();
    return request(`/api/restaurant/auth/logout`, { method: "POST" });
  },
  bootstrap() {
    const terminalId = getTerminalId();
    return cachedRequest(`bootstrap:${cachePart(terminalId)}`, CACHE_TTL.bootstrap, `/api/restaurant/bootstrap?terminal_id=${encodeURIComponent(terminalId)}`);
  },
  listTables() {
    const terminalId = getTerminalId();
    return cachedRequest(`tables:${cachePart(terminalId)}`, CACHE_TTL.tables, `/api/restaurant/tables?terminal_id=${encodeURIComponent(terminalId)}`);
  },

  listPendingPaymentRequests() {
    const terminalId = getTerminalId();
    return cachedRequest(`pending-payments:${cachePart(terminalId)}`, CACHE_TTL.pendingPayments, `/api/restaurant/payment-requests?terminal_id=${encodeURIComponent(terminalId)}`);
  },
  approvePaymentRequest(requestId) {
    return request(`/api/restaurant/payment-requests/${encodeURIComponent(requestId)}/approve`, {
      method: "POST",
      body: JSON.stringify({
        operator_id: getOperatorId(),
        terminal_id: getTerminalId(),
      }),
    });
  },
  customerResolveTable(tableCode, venueType = "") {
    const params = new URLSearchParams({ table_code: tableCode });
    if (venueType) params.set('venue_type', venueType);
    return request(`/api/restaurant/customer/resolve-table?${params.toString()}`);
  },
  customerStartSession(payload) {
    return request(`/api/restaurant/customer/session/start`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  getCustomerSession(sessionId) {
    return request(`/api/restaurant/customer/session/${encodeURIComponent(sessionId)}`);
  },
  addCustomerItem(sessionId, payload) {
    return request(`/api/restaurant/customer/session/${encodeURIComponent(sessionId)}/items`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  updateCustomerItem(sessionId, orderItemId, payload) {
    return request(`/api/restaurant/customer/session/${encodeURIComponent(sessionId)}/items/${encodeURIComponent(orderItemId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },
  removeCustomerItem(sessionId, orderItemId) {
    return request(`/api/restaurant/customer/session/${encodeURIComponent(sessionId)}/items/${encodeURIComponent(orderItemId)}`, {
      method: 'DELETE',
    });
  },
  submitCustomerOrder(sessionId, payload) {
    return request(`/api/restaurant/customer/session/${encodeURIComponent(sessionId)}/submit`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  getTable(tableId) {
    return cachedRequest(`table:${cachePart(tableId)}`, CACHE_TTL.table, `/api/restaurant/tables/${encodeURIComponent(tableId)}`);
  },
  getHistory(tableId) {
    return cachedRequest(`history:${cachePart(tableId)}`, CACHE_TTL.history, `/api/restaurant/tables/${encodeURIComponent(tableId)}/history`);
  },
  listOperators() {
    return cachedRequest("operators", CACHE_TTL.operators, `/api/restaurant/operators`);
  },
  getOperatorContext() {
    const terminalId = getTerminalId();
    return cachedRequest(`operator-context:${cachePart(terminalId)}`, CACHE_TTL.operatorContext, `/api/restaurant/operators/context?terminal_id=${encodeURIComponent(terminalId)}`);
  },
  selectOperator(operatorId, pin = "") {
    return request(`/api/restaurant/operators/select`, {
      method: "POST",
      body: JSON.stringify({
        terminal_id: getTerminalId(),
        operator_id: operatorId,
        pin,
      }),
    });
  },

  ownerAssistantMessage(message) {
    return request(`/api/restaurant/assistant/message`, {
      method: "POST",
      body: JSON.stringify({
        message,
        operator_id: getOperatorId(),
        terminal_id: getTerminalId(),
      }),
    });
  },
  confirmOwnerAssistantAction(action) {
    return request(`/api/restaurant/assistant/actions/confirm`, {
      method: "POST",
      body: JSON.stringify({
        action,
        operator_id: getOperatorId(),
        terminal_id: getTerminalId(),
      }),
    });
  },
  listWorkers() {
    return cachedRequest("workers", CACHE_TTL.workers, `/api/restaurant/workers`);
  },
  createWorker(payload) {
    return request(`/api/restaurant/workers`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  updateWorker(workerId, payload) {
    return request(`/api/restaurant/workers/${encodeURIComponent(workerId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },
  openTable(tableId, note = "") {
    return request(`/api/restaurant/tables/open`, {
      method: "POST",
      body: JSON.stringify({
        table_id: tableId,
        operator_id: getOperatorId(),
        terminal_id: getTerminalId(),
        note,
      }),
    });
  },
  addItem(tableId, menuItemId, quantity = 1, note = "") {
    return request(`/api/restaurant/tables/${encodeURIComponent(tableId)}/items`, {
      method: "POST",
      body: JSON.stringify({
        menu_item_id: menuItemId,
        quantity,
        note,
        operator_id: getOperatorId(),
        terminal_id: getTerminalId(),
      }),
    });
  },
  updateItemQuantity(tableId, orderItemId, quantity) {
    return request(`/api/restaurant/tables/${encodeURIComponent(tableId)}/items/${encodeURIComponent(orderItemId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        quantity,
        operator_id: getOperatorId(),
        terminal_id: getTerminalId(),
      }),
    });
  },
  updateOrderItemStatus(tableId, orderItemId, status) {
    return request(`/api/restaurant/tables/${encodeURIComponent(tableId)}/items/${encodeURIComponent(orderItemId)}/status`, {
      method: "POST",
      body: JSON.stringify({
        status,
        operator_id: getOperatorId(),
        terminal_id: getTerminalId(),
      }),
    });
  },
  removeItem(tableId, orderItemId) {
    return request(`/api/restaurant/tables/${encodeURIComponent(tableId)}/items/${encodeURIComponent(orderItemId)}`, {
      method: "DELETE",
      body: JSON.stringify({
        operator_id: getOperatorId(),
        terminal_id: getTerminalId(),
      }),
    });
  },
  sendToKitchen(tableId, items = []) {
    return request(`/api/restaurant/tables/${encodeURIComponent(tableId)}/send-to-kitchen`, {
      method: "POST",
      body: JSON.stringify({
        operator_id: getOperatorId(),
        terminal_id: getTerminalId(),
        items: Array.isArray(items) ? items : [],
      }),
    });
  },
  closeTable(tableId) {
    return request(`/api/restaurant/tables/${encodeURIComponent(tableId)}/close`, {
      method: "POST",
      body: JSON.stringify({
        operator_id: getOperatorId(),
        terminal_id: getTerminalId(),
      }),
    });
  },
  checkoutPreview(tableId) {
    return request(`/api/restaurant/tables/${encodeURIComponent(tableId)}/checkout-preview`);
  },

  listPrinters() {
    return cachedRequest("printers", CACHE_TTL.printers, `/api/restaurant/printers`);
  },
  listAdminPrinters() {
    return request(`/api/printers/admin`);
  },
  updatePrinterConfig(payload) {
    return request(`/api/printers/config`, {
      method: "PATCH",
      body: JSON.stringify(payload || {}),
    });
  },
  getPaymentIntent(intentId) {
    return request(`/api/restaurant/payment-intents/${encodeURIComponent(intentId)}`);
  },
  refreshPaymentIntent(intentId) {
    return request(`/api/restaurant/payment-intents/${encodeURIComponent(intentId)}/refresh`, {
      method: "POST",
      body: JSON.stringify({
        operator_id: getOperatorId(),
        terminal_id: getTerminalId(),
      }),
    });
  },
  cancelPaymentIntent(intentId) {
    return request(`/api/restaurant/payment-intents/${encodeURIComponent(intentId)}/cancel`, {
      method: "POST",
      body: JSON.stringify({
        operator_id: getOperatorId(),
        terminal_id: getTerminalId(),
      }),
    });
  },
  checkoutTable(tableId, payload) {
    return request(`/api/restaurant/tables/${encodeURIComponent(tableId)}/checkout`, {
      method: "POST",
      body: JSON.stringify({
        ...payload,
        operator_id: getOperatorId(),
        terminal_id: getTerminalId(),
      }),
    });
  },
  transferToTakeaway(tableId, payload = {}) {
    return request(`/api/restaurant/tables/${encodeURIComponent(tableId)}/transfer-to-takeaway`, {
      method: "POST",
      body: JSON.stringify({
        ...payload,
        operator_id: getOperatorId(),
        terminal_id: getTerminalId(),
      }),
    });
  },
  listTakeawayChatOrders(status = "active") {
    const normalized = status || "active";
    return cachedRequest(`takeaway-chat-orders:${cachePart(normalized)}`, CACHE_TTL.takeawayChatOrders, `/api/restaurant/takeaway-chat/orders?status=${encodeURIComponent(normalized)}`);
  },
  updateTakeawayChatOrderStatus(orderId, status, staffNotes = "") {
    return request(`/api/restaurant/takeaway-chat/orders/${encodeURIComponent(orderId)}/status`, {
      method: "POST",
      body: JSON.stringify({
        status,
        staff_notes: staffNotes,
        operator_id: getOperatorId(),
        terminal_id: getTerminalId(),
      }),
    });
  },
  kitchenBoard() {
    return cachedRequest("kitchen", CACHE_TTL.kitchen, `/api/restaurant/kitchen/board`);
  },
  kitchenStatus(kitchenItemId, status) {
    return request(`/api/restaurant/kitchen/items/${encodeURIComponent(kitchenItemId)}/status`, {
      method: "POST",
      body: JSON.stringify({
        status,
        operator_id: getOperatorId(),
        terminal_id: getTerminalId(),
      }),
    });
  },
  replyKitchenNoteThread(orderItemId, payload = {}) {
    return request(`/api/restaurant/kitchen/items/${encodeURIComponent(orderItemId)}/note-chat/reply`, {
      method: 'POST',
      body: JSON.stringify({
        operator_id: getOperatorId(),
        terminal_id: getTerminalId(),
        preset_code: payload.preset_code || '',
        message: payload.message || '',
      }),
    });
  },
  listTableDefinitions() {
    return cachedRequest("managed-tables", CACHE_TTL.managedTables, `/api/restaurant/tables/manage`);
  },
  createTable(payload) {
    return request(`/api/restaurant/tables/manage`, {
      method: "POST",
      body: JSON.stringify({
        ...payload,
        operator_id: getOperatorId(),
        terminal_id: getTerminalId(),
      }),
    });
  },
  updateTable(tableId, payload) {
    return request(`/api/restaurant/tables/manage/${encodeURIComponent(tableId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...payload,
        operator_id: getOperatorId(),
        terminal_id: getTerminalId(),
      }),
    });
  },
  getQrSettings() {
    return cachedRequest("qr-settings", CACHE_TTL.qrSettings, `/api/restaurant/settings/qr`);
  },
  updateQrSettings(payload) {
    return request(`/api/restaurant/settings/qr`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  },
  getTableQr(tableId) {
    return cachedRequest(`table-qr:${cachePart(tableId)}`, CACHE_TTL.tableQr, `/api/restaurant/tables/manage/${encodeURIComponent(tableId)}/qr`);
  },
  regenerateTableQr(tableId) {
    return request(`/api/restaurant/tables/manage/${encodeURIComponent(tableId)}/qr/regenerate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },
  getTablePrintUrl(tableId, regenerate = false) {
    return `/api/restaurant/tables/manage/${encodeURIComponent(tableId)}/print${regenerate ? '?regenerate=1' : ''}`;
  },
  archiveTable(tableId) {
    return request(`/api/restaurant/tables/manage/${encodeURIComponent(tableId)}`, {
      method: "DELETE",
      body: JSON.stringify({
        operator_id: getOperatorId(),
        terminal_id: getTerminalId(),
      }),
    });
  },
  listMenuItems() {
    return cachedRequest("menu-items", CACHE_TTL.menuItems, `/api/restaurant/menu-items`);
  },
  listMenuProfiles() {
    return cachedRequest("menu-profiles", CACHE_TTL.menuProfiles, `/api/restaurant/menu-profiles`);
  },
  getMenuConfig(menuKey, day) {
    const params = new URLSearchParams();
    if (menuKey) params.set("menu_key", menuKey);
    if (day !== undefined && day !== null) params.set("day", String(day));
    return cachedRequest(`menu-config:${cachePart(menuKey)}:${cachePart(day)}`, CACHE_TTL.menuConfig, `/api/restaurant/menu-config?${params.toString()}`);
  },
  getMenuExportUrl(menuKey, day, { autoPrint = true } = {}) {
    const params = new URLSearchParams();
    params.set("day", day === undefined || day === null ? "all" : String(day));
    if (!autoPrint) params.set("autoprint", "0");
    return `/api/restaurant/menu-export/${encodeURIComponent(menuKey || "sala")}/pdf?${params.toString()}`;
  },
  updateMenuAvailability(menuKey, menuItemId, payload) {
    return request(`/api/restaurant/menu-config/${encodeURIComponent(menuKey)}/items/${encodeURIComponent(menuItemId)}`, {
      method: "PATCH",
      body: JSON.stringify({ ...payload, operator_id: getOperatorId(), terminal_id: getTerminalId() }),
    });
  },
  listCategories() {
    return cachedRequest("categories", CACHE_TTL.categories, `/api/restaurant/categories`);
  },
  createCategory(payload) {
    return request(`/api/restaurant/categories`, {
      method: "POST",
      body: JSON.stringify({ ...payload }),
    });
  },
  updateCategory(categoryId, payload) {
    return request(`/api/restaurant/categories/${encodeURIComponent(categoryId)}`, {
      method: "PATCH",
      body: JSON.stringify({ ...payload }),
    });
  },
  reorderCategory(categoryId, direction) {
    return request(`/api/restaurant/categories/${encodeURIComponent(categoryId)}/reorder`, {
      method: "POST",
      body: JSON.stringify({ direction }),
    });
  },
  deleteCategory(categoryId) {
    return request(`/api/restaurant/categories/${encodeURIComponent(categoryId)}`, {
      method: "DELETE",
    });
  },
  uploadMenuImage(file) {
    const form = new FormData();
    form.append("image", file);
    return request(`/api/restaurant/uploads/menu-image`, {
      method: "POST",
      body: form,
    });
  },
  createMenuItem(payload) {
    return request(`/api/restaurant/menu-items`, {
      method: "POST",
      body: JSON.stringify({ ...payload, operator_id: getOperatorId(), terminal_id: getTerminalId() }),
    });
  },
  updateMenuItem(menuItemId, payload) {
    return request(`/api/restaurant/menu-items/${encodeURIComponent(menuItemId)}`, {
      method: "PATCH",
      body: JSON.stringify({ ...payload, operator_id: getOperatorId(), terminal_id: getTerminalId() }),
    });
  },
  archiveMenuItem(menuItemId) {
    return request(`/api/restaurant/menu-items/${encodeURIComponent(menuItemId)}`, {
      method: "DELETE",
      body: JSON.stringify({ operator_id: getOperatorId(), terminal_id: getTerminalId() }),
    });
  },

  reorderMenuItem(menuItemId, direction) {
    return request(`/api/restaurant/menu-items/${encodeURIComponent(menuItemId)}/reorder`, {
      method: "POST",
      body: JSON.stringify({ direction, operator_id: getOperatorId(), terminal_id: getTerminalId() }),
    });
  },
  serviceBoard() {
    return cachedRequest("service-board", CACHE_TTL.serviceBoard, `/api/restaurant/service-board`);
  },
  listLocalInvoices() {
    return cachedRequest("invoices", CACHE_TTL.invoices, `/api/restaurant/invoices/local`);
  },
  seedDemo() {
    return request(`/api/restaurant/demo/seed`, { method: "POST" });
  },
  resetDemo() {
    return request(`/api/restaurant/demo/reset`, { method: "POST" });
  },
};
