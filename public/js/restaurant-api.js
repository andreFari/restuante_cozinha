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
    return request(`/api/restaurant/bootstrap?terminal_id=${encodeURIComponent(getTerminalId())}`);
  },
  listTables() {
    return request(`/api/restaurant/tables`);
  },

  listPendingPaymentRequests() {
    return request(`/api/restaurant/payment-requests?terminal_id=${encodeURIComponent(getTerminalId())}`);
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
    return request(`/api/restaurant/tables/${encodeURIComponent(tableId)}`);
  },
  getHistory(tableId) {
    return request(`/api/restaurant/tables/${encodeURIComponent(tableId)}/history`);
  },
  listOperators() {
    return request(`/api/restaurant/operators`);
  },
  getOperatorContext() {
    return request(`/api/restaurant/operators/context?terminal_id=${encodeURIComponent(getTerminalId())}`);
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
  listWorkers() {
    return request(`/api/restaurant/workers`);
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
    return request(`/api/restaurant/printers`);
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
  kitchenBoard() {
    return request(`/api/restaurant/kitchen/board`);
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
    return request(`/api/restaurant/tables/manage`);
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
    return request(`/api/restaurant/settings/qr`);
  },
  updateQrSettings(payload) {
    return request(`/api/restaurant/settings/qr`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  },
  getTableQr(tableId) {
    return request(`/api/restaurant/tables/manage/${encodeURIComponent(tableId)}/qr`);
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
    return request(`/api/restaurant/menu-items`);
  },
  listMenuProfiles() {
    return request(`/api/restaurant/menu-profiles`);
  },
  getMenuConfig(menuKey, day) {
    const params = new URLSearchParams();
    if (menuKey) params.set("menu_key", menuKey);
    if (day !== undefined && day !== null) params.set("day", String(day));
    return request(`/api/restaurant/menu-config?${params.toString()}`);
  },
  updateMenuAvailability(menuKey, menuItemId, payload) {
    return request(`/api/restaurant/menu-config/${encodeURIComponent(menuKey)}/items/${encodeURIComponent(menuItemId)}`, {
      method: "PATCH",
      body: JSON.stringify({ ...payload, operator_id: getOperatorId(), terminal_id: getTerminalId() }),
    });
  },
  listCategories() {
    return request(`/api/restaurant/categories`);
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
      body: JSON.stringify({ direction }),
    });
  },
  serviceBoard() {
    return request(`/api/restaurant/service-board`);
  },
  listLocalInvoices() {
    return request(`/api/restaurant/invoices/local`);
  },
  seedDemo() {
    return request(`/api/restaurant/demo/seed`, { method: "POST" });
  },
  resetDemo() {
    return request(`/api/restaurant/demo/reset`, { method: "POST" });
  },
};
