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

export function getOperatorId() {
  return localStorage.getItem(OPERATOR_KEY) || "";
}

export function setOperatorId(operatorId) {
  localStorage.setItem(OPERATOR_KEY, operatorId);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.detail || data?.error || `HTTP ${response.status}`);
  }
  return data;
}

export const restaurantApi = {
  bootstrap() {
    return request(`/api/restaurant/bootstrap?terminal_id=${encodeURIComponent(getTerminalId())}`);
  },
  listTables() {
    return request(`/api/restaurant/tables`);
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
  removeItem(tableId, orderItemId) {
    return request(`/api/restaurant/tables/${encodeURIComponent(tableId)}/items/${encodeURIComponent(orderItemId)}`, {
      method: "DELETE",
      body: JSON.stringify({
        operator_id: getOperatorId(),
        terminal_id: getTerminalId(),
      }),
    });
  },
  sendToKitchen(tableId) {
    return request(`/api/restaurant/tables/${encodeURIComponent(tableId)}/send-to-kitchen`, {
      method: "POST",
      body: JSON.stringify({
        operator_id: getOperatorId(),
        terminal_id: getTerminalId(),
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
  archiveTable(tableId) {
    return request(`/api/restaurant/tables/manage/${encodeURIComponent(tableId)}`, {
      method: "DELETE",
      body: JSON.stringify({
        operator_id: getOperatorId(),
        terminal_id: getTerminalId(),
      }),
    });
  },
};
