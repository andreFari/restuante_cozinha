import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const DEFAULT_STORE_PATH = path.resolve(
  __dirname,
  "../data/restaurant-state.json"
);

export function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function makeId(prefix = "id") {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${random}`;
}

export function minutesBetween(startIso, endIso = nowIso()) {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  return Math.max(0, Math.floor((end - start) / 60000));
}

export function normalizeString(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase();
}

export function eventEntry({
  restaurant_id,
  table_session_id,
  actor_operator_id,
  terminal_id = null,
  action_type,
  entity_type,
  entity_id,
  payload = {},
}) {
  return {
    id: makeId("evt"),
    restaurant_id,
    table_session_id,
    actor_operator_id,
    terminal_id,
    action_type,
    entity_type,
    entity_id,
    payload,
    created_at: nowIso(),
  };
}

export function buildKitchenCard(item, session, menuItem, operatorName) {
  const minutesWaiting = minutesBetween(item.sent_to_kitchen_at || item.created_at);
  const prepTarget = Number(menuItem?.prep_minutes || 0);
  const overdueBy = prepTarget > 0 ? Math.max(0, minutesWaiting - prepTarget) : 0;

  return {
    id: item.id,
    order_item_id: item.order_item_id,
    table_session_id: session.id,
    table_id: session.table_id,
    table_name: session.table_name,
    menu_item_id: item.menu_item_id,
    name: item.name,
    quantity: item.quantity,
    station: menuItem?.station || item.station || "general",
    prep_minutes: prepTarget,
    status: item.status,
    note: item.note || "",
    sent_to_kitchen_at: item.sent_to_kitchen_at || item.created_at,
    updated_at: item.updated_at,
    minutes_waiting: minutesWaiting,
    overdue_by_minutes: overdueBy,
    sent_by: operatorName,
  };
}

export function requireBodyFields(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === null || body[field] === "");
  if (missing.length) {
    const error = new Error(`Campos obrigatórios em falta: ${missing.join(", ")}`);
    error.statusCode = 400;
    throw error;
  }
}

export function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
