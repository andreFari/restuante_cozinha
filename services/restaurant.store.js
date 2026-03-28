import fs from "fs";
import {
  DEFAULT_STORE_PATH,
  ensureDirForFile,
  eventEntry,
  makeId,
  nowIso,
  buildKitchenCard,
} from "./restaurant.helpers.js";

const ACTIVE_TABLE_STATUSES = new Set(["open", "sent", "ready_partial"]);
const KITCHEN_STATUS_ORDER = ["new", "in_progress", "ready", "delivered", "blocked"];

function buildSeedState() {
  const restaurantId = "rest_1";
  const operators = [
    { id: "op_ana", name: "Ana", pin: "1111", role: "sala", active: true },
    { id: "op_rui", name: "Rui", pin: "2222", role: "caixa", active: true },
    { id: "op_joao", name: "João", pin: "3333", role: "cozinha", active: true },
    { id: "op_maria", name: "Maria", pin: "4444", role: "gerente", active: true },
  ];
  const menu_items = [
    { id: "mi_bife", name: "Bife da Casa", category: "Pratos", station: "grelha", prep_minutes: 16, price: 12.5, active: true },
    { id: "mi_sopa", name: "Sopa", category: "Entradas", station: "empratamento", prep_minutes: 4, price: 2.5, active: true },
    { id: "mi_pudim", name: "Pudim", category: "Sobremesas", station: "sobremesas", prep_minutes: 2, price: 3.5, active: true },
    { id: "mi_cola", name: "Coca-Cola", category: "Bebidas", station: "bar", prep_minutes: 1, price: 2.0, active: true },
    { id: "mi_batata", name: "Batata Frita", category: "Extras", station: "fritos", prep_minutes: 6, price: 3.0, active: true },
    { id: "mi_feijoada", name: "Feijoada", category: "Pratos", station: "fogao", prep_minutes: 18, price: 15.0, active: true },
  ];

  const tables = Array.from({ length: 18 }, (_, i) => ({
    id: `t_${i + 1}`,
    restaurant_id: restaurantId,
    number: i + 1,
    name: `Mesa ${i + 1}`,
    zone: i < 6 ? "Sala A" : i < 12 ? "Sala B" : "Esplanada",
    capacity: i < 10 ? 4 : 6,
    active: true,
  }));

  return {
    meta: {
      version: 1,
      created_at: nowIso(),
      updated_at: nowIso(),
    },
    restaurants: [{ id: restaurantId, name: "Demo Restaurant", currency: "EUR", timezone: "Europe/Lisbon" }],
    operators,
    terminals: [
      { id: "terminal_main", name: "Terminal Principal", current_operator_id: null, updated_at: nowIso() },
      { id: "terminal_kitchen", name: "Painel Cozinha", current_operator_id: null, updated_at: nowIso() },
    ],
    menu_items,
    tables,
    table_sessions: [],
    order_items: [],
    kitchen_items: [],
    events: [],
  };
}

export class RestaurantStore {
  constructor(filePath = DEFAULT_STORE_PATH) {
    this.filePath = filePath;
    ensureDirForFile(this.filePath);
    if (!fs.existsSync(this.filePath)) {
      this.write(buildSeedState());
    }
  }

  read() {
    const raw = fs.readFileSync(this.filePath, "utf8");
    return JSON.parse(raw);
  }

  write(nextState) {
    nextState.meta = {
      ...(nextState.meta || {}),
      updated_at: nowIso(),
    };
    fs.writeFileSync(this.filePath, JSON.stringify(nextState, null, 2), "utf8");
    return nextState;
  }

  transact(mutator) {
    const state = this.read();
    const result = mutator(state) || {};
    this.write(state);
    return result;
  }

  getBootstrap(terminalId = "terminal_main") {
    const state = this.read();
    const terminal = state.terminals.find((t) => t.id === terminalId) || state.terminals[0] || null;
    return {
      restaurant: state.restaurants[0] || null,
      operators: state.operators.filter((o) => o.active !== false),
      terminal,
      tables: this.listTablesDetailed(state),
      menu_items: state.menu_items.filter((m) => m.active !== false),
      kitchen: this.getKitchenBoard(state),
    };
  }

  listOperators() {
    const state = this.read();
    return state.operators.filter((o) => o.active !== false);
  }

  selectOperator({ terminal_id = "terminal_main", operator_id, pin = null }) {
    return this.transact((state) => {
      const operator = state.operators.find((o) => o.id === operator_id && o.active !== false);
      if (!operator) {
        const error = new Error("Operador não encontrado.");
        error.statusCode = 404;
        throw error;
      }
      if (pin !== null && String(operator.pin || "") !== String(pin)) {
        const error = new Error("PIN inválido.");
        error.statusCode = 401;
        throw error;
      }
      let terminal = state.terminals.find((t) => t.id === terminal_id);
      if (!terminal) {
        terminal = { id: terminal_id, name: terminal_id, current_operator_id: null, updated_at: nowIso() };
        state.terminals.push(terminal);
      }
      terminal.current_operator_id = operator.id;
      terminal.updated_at = nowIso();
      return {
        terminal,
        operator,
      };
    });
  }

  getOperatorContext(terminal_id = "terminal_main") {
    const state = this.read();
    const terminal = state.terminals.find((t) => t.id === terminal_id) || null;
    const operator = terminal ? state.operators.find((o) => o.id === terminal.current_operator_id) || null : null;
    return { terminal, operator };
  }

  listTables() {
    const state = this.read();
    return this.listTablesDetailed(state);
  }


  listTableDefinitions() {
    const state = this.read();
    return state.tables
      .map((table) => ({
        ...table,
        has_active_session: Boolean(this.getActiveSessionForTable(state, table.id)),
      }))
      .sort((a, b) => a.number - b.number);
  }

  createTable({ number, name, zone = "Sala", capacity = 4, active = true, operator_id, terminal_id = "terminal_main" }) {
    return this.transact((state) => {
      const existingNumber = state.tables.find((table) => Number(table.number) === Number(number));
      if (existingNumber) {
        const error = new Error("Já existe uma mesa com esse número.");
        error.statusCode = 409;
        throw error;
      }
      const restaurant = state.restaurants[0];
      const table = {
        id: makeId("table"),
        restaurant_id: restaurant?.id || "rest_1",
        number: Number(number),
        name: String(name || `Mesa ${number}`),
        zone: String(zone || "Sala"),
        capacity: Math.max(1, Number(capacity || 4)),
        active: active !== false,
      };
      state.tables.push(table);
      state.events.push(
        eventEntry({
          restaurant_id: table.restaurant_id,
          table_session_id: null,
          actor_operator_id: operator_id,
          terminal_id,
          action_type: "table_created",
          entity_type: "table",
          entity_id: table.id,
          payload: { number: table.number, name: table.name, zone: table.zone, capacity: table.capacity },
        })
      );
      return { table };
    });
  }

  updateTableDefinition({ table_id, number, name, zone, capacity, active, operator_id, terminal_id = "terminal_main" }) {
    return this.transact((state) => {
      const table = state.tables.find((row) => row.id === table_id);
      if (!table) {
        const error = new Error("Mesa não encontrada.");
        error.statusCode = 404;
        throw error;
      }
      if (number !== undefined && Number(number) !== Number(table.number)) {
        const duplicate = state.tables.find((row) => row.id !== table_id && Number(row.number) === Number(number));
        if (duplicate) {
          const error = new Error("Já existe outra mesa com esse número.");
          error.statusCode = 409;
          throw error;
        }
        table.number = Number(number);
      }
      if (name !== undefined) table.name = String(name || table.name);
      if (zone !== undefined) table.zone = String(zone || table.zone);
      if (capacity !== undefined) table.capacity = Math.max(1, Number(capacity || table.capacity));
      if (active !== undefined) table.active = Boolean(active);
      state.events.push(
        eventEntry({
          restaurant_id: table.restaurant_id,
          table_session_id: null,
          actor_operator_id: operator_id,
          terminal_id,
          action_type: "table_updated",
          entity_type: "table",
          entity_id: table.id,
          payload: { number: table.number, name: table.name, zone: table.zone, capacity: table.capacity, active: table.active },
        })
      );
      return { table };
    });
  }

  archiveTableDefinition({ table_id, operator_id, terminal_id = "terminal_main" }) {
    return this.transact((state) => {
      const table = state.tables.find((row) => row.id === table_id);
      if (!table) {
        const error = new Error("Mesa não encontrada.");
        error.statusCode = 404;
        throw error;
      }
      if (this.getActiveSessionForTable(state, table_id)) {
        const error = new Error("Não podes ocultar uma mesa que está aberta.");
        error.statusCode = 409;
        throw error;
      }
      table.active = false;
      state.events.push(
        eventEntry({
          restaurant_id: table.restaurant_id,
          table_session_id: null,
          actor_operator_id: operator_id,
          terminal_id,
          action_type: "table_archived",
          entity_type: "table",
          entity_id: table.id,
          payload: { number: table.number, name: table.name },
        })
      );
      return { table };
    });
  }

  listTablesDetailed(state) {
    return state.tables
      .filter((table) => table.active !== false)
      .map((table) => {
        const session = this.getActiveSessionForTable(state, table.id);
        const items = session ? this.getOrderItemsForSession(state, session.id) : [];
        const total = items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unit_price || 0), 0);
        const totalItems = items.reduce((sum, item) => sum + Number(item.quantity), 0);
        const pendingKitchen = state.kitchen_items.filter(
          (item) => item.table_session_id === session?.id && ["new", "in_progress", "blocked"].includes(item.status)
        ).length;
        return {
          ...table,
          session: session
            ? {
                id: session.id,
                status: session.status,
                opened_at: session.opened_at,
                updated_at: session.updated_at,
                operator_id: session.operator_id,
                note: session.note || "",
              }
            : null,
          metrics: {
            total,
            total_items: totalItems,
            pending_kitchen: pendingKitchen,
          },
        };
      })
      .sort((a, b) => a.number - b.number);
  }

  getTableDetails(table_id) {
    const state = this.read();
    const table = state.tables.find((t) => t.id === table_id);
    if (!table) {
      const error = new Error("Mesa não encontrada.");
      error.statusCode = 404;
      throw error;
    }
    const session = this.getActiveSessionForTable(state, table.id);
    const order_items = session ? this.getOrderItemsForSession(state, session.id) : [];
    const history = session
      ? state.events.filter((evt) => evt.table_session_id === session.id).sort((a, b) => b.created_at.localeCompare(a.created_at))
      : [];
    const kitchen_items = session
      ? state.kitchen_items.filter((item) => item.table_session_id === session.id)
      : [];
    const total = order_items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unit_price || 0), 0);
    return {
      table,
      session,
      order_items,
      kitchen_items,
      history: history.map((evt) => ({
        ...evt,
        actor_name: state.operators.find((o) => o.id === evt.actor_operator_id)?.name || "—",
      })),
      totals: {
        total,
        total_items: order_items.reduce((sum, item) => sum + Number(item.quantity), 0),
      },
    };
  }

  openTable({ table_id, operator_id, terminal_id = "terminal_main", note = "" }) {
    return this.transact((state) => {
      const table = state.tables.find((t) => t.id === table_id && t.active !== false);
      if (!table) {
        const error = new Error("Mesa não encontrada.");
        error.statusCode = 404;
        throw error;
      }
      const existing = this.getActiveSessionForTable(state, table_id);
      if (existing) {
        const error = new Error("Essa mesa já está aberta.");
        error.statusCode = 409;
        throw error;
      }
      const session = {
        id: makeId("sess"),
        restaurant_id: table.restaurant_id,
        table_id: table.id,
        table_name: table.name,
        status: "open",
        operator_id,
        note,
        opened_at: nowIso(),
        updated_at: nowIso(),
        closed_at: null,
      };
      state.table_sessions.push(session);
      state.events.push(
        eventEntry({
          restaurant_id: table.restaurant_id,
          table_session_id: session.id,
          actor_operator_id: operator_id,
          terminal_id,
          action_type: "table_opened",
          entity_type: "table_session",
          entity_id: session.id,
          payload: { table_id: table.id, table_name: table.name, note },
        })
      );
      return { session };
    });
  }

  addItem({ table_id, menu_item_id, quantity = 1, operator_id, terminal_id = "terminal_main", note = "" }) {
    return this.transact((state) => {
      const table = state.tables.find((t) => t.id === table_id && t.active !== false);
      if (!table) {
        const error = new Error("Mesa não encontrada.");
        error.statusCode = 404;
        throw error;
      }
      const session = this.getActiveSessionForTable(state, table_id);
      if (!session) {
        const error = new Error("A mesa não está aberta.");
        error.statusCode = 409;
        throw error;
      }
      const menuItem = state.menu_items.find((item) => item.id === menu_item_id && item.active !== false);
      if (!menuItem) {
        const error = new Error("Artigo não encontrado.");
        error.statusCode = 404;
        throw error;
      }
      const item = {
        id: makeId("oi"),
        table_session_id: session.id,
        menu_item_id: menuItem.id,
        name: menuItem.name,
        station: menuItem.station,
        quantity: Math.max(1, Number(quantity || 1)),
        unit_price: Number(menuItem.price || 0),
        note,
        status: "draft",
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      state.order_items.push(item);
      session.updated_at = nowIso();
      state.events.push(
        eventEntry({
          restaurant_id: table.restaurant_id,
          table_session_id: session.id,
          actor_operator_id: operator_id,
          terminal_id,
          action_type: "item_added",
          entity_type: "order_item",
          entity_id: item.id,
          payload: {
            table_id: table.id,
            menu_item_id: menuItem.id,
            name: menuItem.name,
            quantity: item.quantity,
            note,
          },
        })
      );
      return { item };
    });
  }

  updateItemQuantity({ table_id, order_item_id, quantity, operator_id, terminal_id = "terminal_main" }) {
    return this.transact((state) => {
      const session = this.getActiveSessionForTable(state, table_id);
      if (!session) {
        const error = new Error("Mesa não aberta.");
        error.statusCode = 409;
        throw error;
      }
      const item = state.order_items.find((row) => row.id === order_item_id && row.table_session_id === session.id);
      if (!item) {
        const error = new Error("Item não encontrado.");
        error.statusCode = 404;
        throw error;
      }
      item.quantity = Math.max(1, Number(quantity || 1));
      item.updated_at = nowIso();
      session.updated_at = nowIso();
      state.events.push(
        eventEntry({
          restaurant_id: session.restaurant_id,
          table_session_id: session.id,
          actor_operator_id: operator_id,
          terminal_id,
          action_type: "item_qty_changed",
          entity_type: "order_item",
          entity_id: item.id,
          payload: { quantity: item.quantity, name: item.name },
        })
      );
      return { item };
    });
  }

  removeItem({ table_id, order_item_id, operator_id, terminal_id = "terminal_main" }) {
    return this.transact((state) => {
      const session = this.getActiveSessionForTable(state, table_id);
      if (!session) {
        const error = new Error("Mesa não aberta.");
        error.statusCode = 409;
        throw error;
      }
      const idx = state.order_items.findIndex((row) => row.id === order_item_id && row.table_session_id === session.id);
      if (idx === -1) {
        const error = new Error("Item não encontrado.");
        error.statusCode = 404;
        throw error;
      }
      const [item] = state.order_items.splice(idx, 1);
      session.updated_at = nowIso();
      state.events.push(
        eventEntry({
          restaurant_id: session.restaurant_id,
          table_session_id: session.id,
          actor_operator_id: operator_id,
          terminal_id,
          action_type: "item_removed",
          entity_type: "order_item",
          entity_id: order_item_id,
          payload: { name: item.name, quantity: item.quantity },
        })
      );
      return { removed: true };
    });
  }

  sendTableToKitchen({ table_id, operator_id, terminal_id = "terminal_main" }) {
    return this.transact((state) => {
      const session = this.getActiveSessionForTable(state, table_id);
      if (!session) {
        const error = new Error("Mesa não aberta.");
        error.statusCode = 409;
        throw error;
      }
      const orderItems = this.getOrderItemsForSession(state, session.id).filter((item) => item.status === "draft");
      if (!orderItems.length) {
        const error = new Error("Não existem itens novos para enviar para a cozinha.");
        error.statusCode = 409;
        throw error;
      }
      for (const item of orderItems) {
        item.status = "sent";
        item.updated_at = nowIso();
        state.kitchen_items.push({
          id: makeId("kit"),
          table_session_id: session.id,
          order_item_id: item.id,
          menu_item_id: item.menu_item_id,
          name: item.name,
          station: item.station,
          quantity: item.quantity,
          note: item.note || "",
          status: "new",
          created_at: nowIso(),
          sent_to_kitchen_at: nowIso(),
          updated_at: nowIso(),
          sent_by_operator_id: operator_id,
        });
      }
      session.status = "sent";
      session.updated_at = nowIso();
      state.events.push(
        eventEntry({
          restaurant_id: session.restaurant_id,
          table_session_id: session.id,
          actor_operator_id: operator_id,
          terminal_id,
          action_type: "order_sent_to_kitchen",
          entity_type: "table_session",
          entity_id: session.id,
          payload: { items_count: orderItems.length },
        })
      );
      return { session_id: session.id, sent_items: orderItems.length };
    });
  }

  updateKitchenStatus({ kitchen_item_id, status, operator_id, terminal_id = "terminal_kitchen" }) {
    return this.transact((state) => {
      if (!KITCHEN_STATUS_ORDER.includes(status)) {
        const error = new Error("Estado de cozinha inválido.");
        error.statusCode = 400;
        throw error;
      }
      const item = state.kitchen_items.find((row) => row.id === kitchen_item_id);
      if (!item) {
        const error = new Error("Item de cozinha não encontrado.");
        error.statusCode = 404;
        throw error;
      }
      item.status = status;
      item.updated_at = nowIso();

      const orderItem = state.order_items.find((row) => row.id === item.order_item_id);
      if (orderItem) {
        orderItem.status = status;
        orderItem.updated_at = nowIso();
      }

      const session = state.table_sessions.find((row) => row.id === item.table_session_id);
      if (session) {
        const allKitchenItems = state.kitchen_items.filter((row) => row.table_session_id === session.id);
        const pending = allKitchenItems.filter((row) => ["new", "in_progress", "blocked"].includes(row.status));
        const ready = allKitchenItems.filter((row) => row.status === "ready");
        if (!pending.length && ready.length) {
          session.status = "ready_partial";
        }
        if (!pending.length && allKitchenItems.length && allKitchenItems.every((row) => row.status === "delivered")) {
          session.status = "open";
        }
        session.updated_at = nowIso();
        state.events.push(
          eventEntry({
            restaurant_id: session.restaurant_id,
            table_session_id: session.id,
            actor_operator_id: operator_id,
            terminal_id,
            action_type: `kitchen_${status}`,
            entity_type: "kitchen_item",
            entity_id: item.id,
            payload: { name: item.name, quantity: item.quantity },
          })
        );
      }
      return { item };
    });
  }

  closeTable({ table_id, operator_id, terminal_id = "terminal_main" }) {
    return this.transact((state) => {
      const session = this.getActiveSessionForTable(state, table_id);
      if (!session) {
        const error = new Error("Mesa não aberta.");
        error.statusCode = 409;
        throw error;
      }
      const pendingKitchen = state.kitchen_items.filter(
        (item) => item.table_session_id === session.id && ["new", "in_progress", "blocked"].includes(item.status)
      );
      if (pendingKitchen.length) {
        const error = new Error("Ainda existem itens pendentes na cozinha.");
        error.statusCode = 409;
        throw error;
      }
      session.status = "closed";
      session.closed_at = nowIso();
      session.updated_at = nowIso();
      state.events.push(
        eventEntry({
          restaurant_id: session.restaurant_id,
          table_session_id: session.id,
          actor_operator_id: operator_id,
          terminal_id,
          action_type: "table_closed",
          entity_type: "table_session",
          entity_id: session.id,
          payload: { table_id },
        })
      );
      return { session };
    });
  }

  getHistory(table_id) {
    const state = this.read();
    const session = this.getActiveSessionForTable(state, table_id) || this.getLastSessionForTable(state, table_id);
    if (!session) return [];
    return state.events
      .filter((evt) => evt.table_session_id === session.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((evt) => ({
        ...evt,
        actor_name: state.operators.find((o) => o.id === evt.actor_operator_id)?.name || "—",
      }));
  }

  getKitchenBoard(state = null) {
    const currentState = state || this.read();
    const activeSessions = currentState.table_sessions.filter((session) => ACTIVE_TABLE_STATUSES.has(session.status));
    const sessionMap = new Map(activeSessions.map((session) => [session.id, session]));
    const menuMap = new Map(currentState.menu_items.map((item) => [item.id, item]));
    const operatorMap = new Map(currentState.operators.map((op) => [op.id, op.name]));
    const cards = currentState.kitchen_items
      .filter((item) => sessionMap.has(item.table_session_id))
      .map((item) => buildKitchenCard(item, sessionMap.get(item.table_session_id), menuMap.get(item.menu_item_id), operatorMap.get(item.sent_by_operator_id)));

    return {
      columns: {
        new: cards.filter((card) => card.status === "new"),
        in_progress: cards.filter((card) => card.status === "in_progress"),
        ready: cards.filter((card) => card.status === "ready"),
        delivered: cards.filter((card) => card.status === "delivered"),
        blocked: cards.filter((card) => card.status === "blocked"),
      },
      totals: {
        total: cards.length,
        pending: cards.filter((card) => ["new", "in_progress", "blocked"].includes(card.status)).length,
        overdue: cards.filter((card) => card.overdue_by_minutes > 0).length,
      },
    };
  }

  getActiveSessionForTable(state, table_id) {
    return state.table_sessions.find((session) => session.table_id === table_id && ACTIVE_TABLE_STATUSES.has(session.status)) || null;
  }

  getLastSessionForTable(state, table_id) {
    return state.table_sessions
      .filter((session) => session.table_id === table_id)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] || null;
  }

  getOrderItemsForSession(state, session_id) {
    return state.order_items
      .filter((row) => row.table_session_id === session_id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
}

export const restaurantStore = new RestaurantStore();
