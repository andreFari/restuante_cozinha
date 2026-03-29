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
const MENU_PROFILE_DEFS = [
  { id: "sala", name: "Restaurante interior", description: "Menu servido dentro do restaurante.", terminal_id: "terminal_main" },
  { id: "esplanada", name: "Fora do restaurante", description: "Menu de exterior / esplanada.", terminal_id: "terminal_main" },
  { id: "takeaway", name: "Takeaway", description: "Menu para levar.", terminal_id: "terminal_takeaway" },
  { id: "bar", name: "Bar", description: "Menu de bar, bebidas e snacks.", terminal_id: "terminal_bar" },
];
const DAYS = [0, 1, 2, 3, 4, 5, 6];

function isoMinutesAgo(minutes = 0) {
  return new Date(Date.now() - Number(minutes || 0) * 60000).toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultMenuRules(channels = ["sala"]) {
  const rules = {};
  const normalizedChannels = Array.isArray(channels) && channels.length ? channels : ["sala"];
  normalizedChannels.forEach((channel) => {
    if (MENU_PROFILE_DEFS.some((profile) => profile.id === channel)) {
      rules[channel] = [...DAYS];
    }
  });
  return rules;
}

function normalizeMenuRules(item = {}) {
  const rules = {};
  const raw = item.menu_rules && typeof item.menu_rules === "object" ? item.menu_rules : defaultMenuRules(item.channels);
  for (const profile of MENU_PROFILE_DEFS) {
    const days = Array.isArray(raw[profile.id]) ? raw[profile.id] : [];
    rules[profile.id] = days
      .map((day) => Number(day))
      .filter((day, idx, arr) => Number.isInteger(day) && day >= 0 && day <= 6 && arr.indexOf(day) === idx)
      .sort((a, b) => a - b);
  }
  return rules;
}

function deriveChannelsFromRules(menuRules) {
  return Object.entries(menuRules || {})
    .filter(([, days]) => Array.isArray(days) && days.length)
    .map(([menuKey]) => menuKey);
}

function normalizeMenuItem(item = {}) {
  const menu_rules = normalizeMenuRules(item);
  return {
    ...item,
    menu_rules,
    channels: deriveChannelsFromRules(menu_rules),
  };
}

function normalizeMenuProfile(profile = {}) {
  return {
    active: profile.active !== false,
    ...profile,
  };
}

function buildSeedState() {
  const restaurantId = "rest_1";
  const operators = [
    { id: "op_ana", name: "Ana", pin: "1111", role: "sala", active: true },
    { id: "op_rui", name: "Rui", pin: "2222", role: "caixa", active: true },
    { id: "op_joao", name: "João", pin: "3333", role: "cozinha", active: true },
    { id: "op_maria", name: "Maria", pin: "4444", role: "gerente", active: true },
  ];

  const menu_items = [
    { id: "mi_bife", name: "Bife da Casa", category: "Pratos", station: "grelha", prep_minutes: 16, price: 12.5, menu_rules: { sala: [...DAYS], esplanada: [4, 5, 6], takeaway: [4, 5, 6], bar: [] }, active: true },
    { id: "mi_feijoada", name: "Feijoada", category: "Pratos", station: "fogao", prep_minutes: 18, price: 15.0, menu_rules: { sala: [0, 6], esplanada: [0, 6], takeaway: [], bar: [] }, active: true },
    { id: "mi_hamburger", name: "Hambúrguer da Casa", category: "Pratos", station: "grelha", prep_minutes: 14, price: 9.5, menu_rules: { sala: [...DAYS], esplanada: [4, 5, 6], takeaway: [...DAYS], bar: [] }, active: true },
    { id: "mi_sopa", name: "Sopa do Dia", category: "Entradas", station: "fogao", prep_minutes: 4, price: 2.5, menu_rules: { sala: [1, 2, 3, 4, 5], esplanada: [], takeaway: [1, 2, 3, 4, 5], bar: [] }, active: true },
    { id: "mi_salada", name: "Salada Mista", category: "Acompanhamentos", station: "empratamento", prep_minutes: 3, price: 3.0, menu_rules: { sala: [...DAYS], esplanada: [...DAYS], takeaway: [...DAYS], bar: [] }, active: true },
    { id: "mi_batata", name: "Batata Frita", category: "Extras", station: "fritos", prep_minutes: 6, price: 3.0, menu_rules: { sala: [...DAYS], esplanada: [...DAYS], takeaway: [...DAYS], bar: [...DAYS] }, active: true },
    { id: "mi_cola", name: "Coca-Cola", category: "Bebidas", station: "bar", prep_minutes: 1, price: 2.0, menu_rules: { sala: [...DAYS], esplanada: [...DAYS], takeaway: [...DAYS], bar: [...DAYS] }, active: true },
    { id: "mi_cafe", name: "Café", category: "Bebidas", station: "bar", prep_minutes: 1, price: 1.1, menu_rules: { sala: [...DAYS], esplanada: [...DAYS], takeaway: [...DAYS], bar: [...DAYS] }, active: true },
    { id: "mi_pudim", name: "Pudim", category: "Sobremesas", station: "sobremesas", prep_minutes: 2, price: 3.5, menu_rules: { sala: [...DAYS], esplanada: [5, 6], takeaway: [5, 6], bar: [...DAYS] }, active: true },
    { id: "mi_prego", name: "Prego no Pão", category: "Snacks", station: "grelha", prep_minutes: 10, price: 6.5, menu_rules: { sala: [], esplanada: [4, 5, 6], takeaway: [...DAYS], bar: [...DAYS] }, active: true },
    { id: "mi_tosta", name: "Tosta Mista", category: "Snacks", station: "chapa", prep_minutes: 7, price: 4.5, menu_rules: { sala: [], esplanada: [...DAYS], takeaway: [...DAYS], bar: [...DAYS] }, active: true },
  ].map(normalizeMenuItem);

  const tables = [
    ...Array.from({ length: 12 }, (_, i) => ({
      id: `t_${i + 1}`,
      restaurant_id: restaurantId,
      number: i + 1,
      name: `Mesa ${i + 1}`,
      zone: i < 6 ? "Sala A" : "Sala B",
      capacity: 4,
      active: true,
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `t_e_${i + 1}`,
      restaurant_id: restaurantId,
      number: 20 + i + 1,
      name: `Esplanada ${i + 1}`,
      zone: "Esplanada",
      capacity: 4,
      active: true,
    })),
    { id: "t_b_1", restaurant_id: restaurantId, number: 101, name: "Bar 1", zone: "Bar", capacity: 2, active: true },
    { id: "t_b_2", restaurant_id: restaurantId, number: 102, name: "Bar 2", zone: "Bar", capacity: 2, active: true },
    { id: "t_t_1", restaurant_id: restaurantId, number: 201, name: "Takeaway 1", zone: "Takeaway", capacity: 1, active: true },
    { id: "t_t_2", restaurant_id: restaurantId, number: 202, name: "Takeaway 2", zone: "Takeaway", capacity: 1, active: true },
    { id: "t_t_3", restaurant_id: restaurantId, number: 203, name: "Takeaway 3", zone: "Takeaway", capacity: 1, active: true },
  ];

  return {
    meta: {
      version: 3,
      created_at: nowIso(),
      updated_at: nowIso(),
    },
    restaurants: [{ id: restaurantId, name: "Demo Restaurant", currency: "EUR", timezone: "Europe/Lisbon" }],
    operators,
    terminals: [
      { id: "terminal_main", name: "Terminal Principal", current_operator_id: "op_ana", updated_at: nowIso() },
      { id: "terminal_bar", name: "Receção Bar", current_operator_id: "op_rui", updated_at: nowIso() },
      { id: "terminal_takeaway", name: "Takeaway", current_operator_id: "op_rui", updated_at: nowIso() },
      { id: "terminal_kitchen", name: "Painel Cozinha", current_operator_id: "op_joao", updated_at: nowIso() },
    ],
    menu_profiles: MENU_PROFILE_DEFS.map(normalizeMenuProfile),
    menu_items,
    tables,
    table_sessions: [],
    order_items: [],
    kitchen_items: [],
    events: [],
  };
}

function createSession(state, { id, table, operator_id, opened_minutes_ago = 0, status = "open", note = "" }) {
  const session = {
    id,
    restaurant_id: table.restaurant_id,
    table_id: table.id,
    table_name: table.name,
    status,
    operator_id,
    note,
    opened_at: isoMinutesAgo(opened_minutes_ago),
    updated_at: isoMinutesAgo(Math.max(0, opened_minutes_ago - 1)),
    closed_at: status === "closed" ? isoMinutesAgo(Math.max(0, opened_minutes_ago - 1)) : null,
  };
  state.table_sessions.push(session);
  return session;
}

function addOrderItem(state, session, menuItem, { quantity = 1, status = "draft", minutes_ago = 0, note = "" } = {}) {
  const item = {
    id: makeId("oi"),
    table_session_id: session.id,
    menu_item_id: menuItem.id,
    name: menuItem.name,
    station: menuItem.station,
    quantity: Math.max(1, Number(quantity || 1)),
    unit_price: Number(menuItem.price || 0),
    note,
    status,
    created_at: isoMinutesAgo(minutes_ago),
    updated_at: isoMinutesAgo(minutes_ago),
  };
  state.order_items.push(item);
  return item;
}

function addKitchenItem(state, session, orderItem, sent_by_operator_id, status = "new", minutes_ago = 0) {
  state.kitchen_items.push({
    id: makeId("kit"),
    table_session_id: session.id,
    order_item_id: orderItem.id,
    menu_item_id: orderItem.menu_item_id,
    name: orderItem.name,
    station: orderItem.station,
    quantity: orderItem.quantity,
    note: orderItem.note || "",
    status,
    created_at: isoMinutesAgo(minutes_ago),
    sent_to_kitchen_at: isoMinutesAgo(minutes_ago),
    updated_at: isoMinutesAgo(minutes_ago),
    sent_by_operator_id,
  });
}

function pushEvent(state, payload) {
  state.events.push(eventEntry(payload));
}

function applyDemoScenario(state) {
  const table1 = state.tables.find((t) => t.id === "t_1");
  const table3 = state.tables.find((t) => t.id === "t_3");
  const take1 = state.tables.find((t) => t.id === "t_t_1");
  const bar1 = state.tables.find((t) => t.id === "t_b_1");
  const bife = state.menu_items.find((m) => m.id === "mi_bife");
  const cola = state.menu_items.find((m) => m.id === "mi_cola");
  const feijoada = state.menu_items.find((m) => m.id === "mi_feijoada");
  const pudim = state.menu_items.find((m) => m.id === "mi_pudim");
  const prego = state.menu_items.find((m) => m.id === "mi_prego");
  const cafe = state.menu_items.find((m) => m.id === "mi_cafe");

  const s1 = createSession(state, { id: makeId("sess"), table: table1, operator_id: "op_ana", opened_minutes_ago: 38, status: "sent" });
  const s2 = createSession(state, { id: makeId("sess"), table: table3, operator_id: "op_rui", opened_minutes_ago: 27, status: "ready_partial" });
  const s3 = createSession(state, { id: makeId("sess"), table: take1, operator_id: "op_rui", opened_minutes_ago: 12, status: "sent", note: "Cliente takeaway Pedro" });
  const s4 = createSession(state, { id: makeId("sess"), table: bar1, operator_id: "op_ana", opened_minutes_ago: 9, status: "open" });
  const s5 = createSession(state, { id: makeId("sess"), table: state.tables.find((t) => t.id === "t_2"), operator_id: "op_ana", opened_minutes_ago: 80, status: "closed" });

  const s1i1 = addOrderItem(state, s1, bife, { quantity: 2, status: "in_progress", minutes_ago: 21, note: "Um mal passado" });
  const s1i2 = addOrderItem(state, s1, cola, { quantity: 2, status: "ready", minutes_ago: 18 });
  addKitchenItem(state, s1, s1i1, "op_ana", "in_progress", 20);
  addKitchenItem(state, s1, s1i2, "op_ana", "ready", 17);

  const s2i1 = addOrderItem(state, s2, feijoada, { quantity: 1, status: "new", minutes_ago: 24 });
  const s2i2 = addOrderItem(state, s2, pudim, { quantity: 2, status: "blocked", minutes_ago: 10, note: "Aguardar mesa principal" });
  addKitchenItem(state, s2, s2i1, "op_rui", "new", 24);
  addKitchenItem(state, s2, s2i2, "op_rui", "blocked", 9);

  const s3i1 = addOrderItem(state, s3, prego, { quantity: 1, status: "ready", minutes_ago: 8, note: "Sem mostarda" });
  addKitchenItem(state, s3, s3i1, "op_rui", "ready", 8);

  addOrderItem(state, s4, cafe, { quantity: 2, status: "draft", minutes_ago: 3 });
  addOrderItem(state, s5, cola, { quantity: 3, status: "delivered", minutes_ago: 70 });
  addOrderItem(state, s5, bife, { quantity: 1, status: "delivered", minutes_ago: 68 });

  [
    { session: s1, op: "op_ana", action: "table_opened", entity_type: "table_session", entity_id: s1.id, payload: { table_name: s1.table_name } },
    { session: s1, op: "op_ana", action: "order_sent_to_kitchen", entity_type: "table_session", entity_id: s1.id, payload: { items_count: 2 } },
    { session: s2, op: "op_rui", action: "table_opened", entity_type: "table_session", entity_id: s2.id, payload: { table_name: s2.table_name } },
    { session: s2, op: "op_joao", action: "kitchen_blocked", entity_type: "kitchen_item", entity_id: state.kitchen_items[state.kitchen_items.length - 1].id, payload: { name: pudim.name, quantity: 2 } },
    { session: s3, op: "op_rui", action: "table_opened", entity_type: "table_session", entity_id: s3.id, payload: { table_name: s3.table_name } },
    { session: s3, op: "op_joao", action: "kitchen_ready", entity_type: "kitchen_item", entity_id: state.kitchen_items.find((k) => k.order_item_id === s3i1.id).id, payload: { name: prego.name, quantity: 1 } },
    { session: s5, op: "op_ana", action: "table_closed", entity_type: "table_session", entity_id: s5.id, payload: { table_name: s5.table_name } },
  ].forEach((evt) =>
    pushEvent(state, {
      restaurant_id: evt.session.restaurant_id,
      table_session_id: evt.session.id,
      actor_operator_id: evt.op,
      terminal_id: "terminal_main",
      action_type: evt.action,
      entity_type: evt.entity_type,
      entity_id: evt.entity_id,
      payload: evt.payload,
    })
  );
}

export class RestaurantStore {
  constructor(filePath = DEFAULT_STORE_PATH) {
    this.filePath = filePath;
    ensureDirForFile(this.filePath);
    if (!fs.existsSync(this.filePath)) {
      this.write(buildSeedState());
    } else {
      this.write(this.read());
    }
  }

  read() {
    const raw = fs.readFileSync(this.filePath, "utf8");
    const state = JSON.parse(raw);
    state.menu_profiles = Array.isArray(state.menu_profiles) && state.menu_profiles.length
      ? state.menu_profiles.map(normalizeMenuProfile)
      : MENU_PROFILE_DEFS.map(normalizeMenuProfile);
    state.menu_items = Array.isArray(state.menu_items) ? state.menu_items.map(normalizeMenuItem) : [];
    return state;
  }

  write(nextState) {
    nextState.meta = {
      ...(nextState.meta || {}),
      version: 3,
      updated_at: nowIso(),
    };
    nextState.menu_profiles = (nextState.menu_profiles || MENU_PROFILE_DEFS).map(normalizeMenuProfile);
    nextState.menu_items = (nextState.menu_items || []).map(normalizeMenuItem);
    fs.writeFileSync(this.filePath, JSON.stringify(nextState, null, 2), "utf8");
    return nextState;
  }

  transact(mutator) {
    const state = this.read();
    const result = mutator(state) || {};
    this.write(state);
    return result;
  }

  getTodayDay() {
    return new Date().getDay();
  }

  resetDemoData(seedExamples = false) {
    const nextState = buildSeedState();
    if (seedExamples) applyDemoScenario(nextState);
    this.write(nextState);
    return {
      ok: true,
      message: seedExamples ? "Exemplo carregado com mesas, pedidos e cozinha." : "Demo limpa e pronta a testar.",
      bootstrap: this.getBootstrap(),
    };
  }

  getBootstrap(terminalId = "terminal_main") {
    const state = this.read();
    const terminal = state.terminals.find((t) => t.id === terminalId) || state.terminals[0] || null;
    return {
      restaurant: state.restaurants[0] || null,
      operators: state.operators.filter((o) => o.active !== false),
      terminal,
      menu_profiles: state.menu_profiles,
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
      if (pin !== null && pin !== "" && String(operator.pin || "") !== String(pin)) {
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
      return { terminal, operator };
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

  listMenuProfiles() {
    const state = this.read();
    return state.menu_profiles;
  }

  listMenuItems() {
    const state = this.read();
    return state.menu_items
      .map(normalizeMenuItem)
      .sort((a, b) => String(a.category).localeCompare(String(b.category)) || String(a.name).localeCompare(String(b.name)));
  }

  getItemsForMenu(menu_key, day = this.getTodayDay()) {
    return this.listMenuItems().filter((item) => item.active !== false && item.menu_rules?.[menu_key]?.includes(Number(day)));
  }

  getMenuConfig(menu_key = "sala", day = this.getTodayDay()) {
    const state = this.read();
    const profile = state.menu_profiles.find((row) => row.id === menu_key) || null;
    const items = state.menu_items
      .map(normalizeMenuItem)
      .map((item) => ({
        ...item,
        enabled_for_selected_day: item.active !== false && item.menu_rules?.[menu_key]?.includes(Number(day)),
      }));
    return {
      day: Number(day),
      menu_key,
      profile,
      items,
      enabled_items: items.filter((item) => item.enabled_for_selected_day),
    };
  }

  createMenuItem({ name, category, station, prep_minutes, price, channels = ["sala"], menu_rules, active = true, operator_id, terminal_id = "terminal_main" }) {
    return this.transact((state) => {
      const item = normalizeMenuItem({
        id: makeId("mi"),
        name: String(name || "Novo prato"),
        category: String(category || "Pratos"),
        station: String(station || "grelha"),
        prep_minutes: Math.max(0, Number(prep_minutes || 0)),
        price: Number(price || 0),
        menu_rules: menu_rules || defaultMenuRules(channels),
        active: active !== false,
      });
      state.menu_items.push(item);
      state.events.push(
        eventEntry({
          restaurant_id: state.restaurants[0]?.id || "rest_1",
          table_session_id: null,
          actor_operator_id: operator_id,
          terminal_id,
          action_type: "menu_item_created",
          entity_type: "menu_item",
          entity_id: item.id,
          payload: { name: item.name, category: item.category, channels: item.channels },
        })
      );
      return { item };
    });
  }

  updateMenuItem({ menu_item_id, name, category, station, prep_minutes, price, channels, menu_rules, active, operator_id, terminal_id = "terminal_main" }) {
    return this.transact((state) => {
      const item = state.menu_items.find((row) => row.id === menu_item_id);
      if (!item) {
        const error = new Error("Prato não encontrado.");
        error.statusCode = 404;
        throw error;
      }
      if (name !== undefined) item.name = String(name || item.name);
      if (category !== undefined) item.category = String(category || item.category);
      if (station !== undefined) item.station = String(station || item.station);
      if (prep_minutes !== undefined) item.prep_minutes = Math.max(0, Number(prep_minutes || item.prep_minutes || 0));
      if (price !== undefined) item.price = Number(price || item.price || 0);
      if (menu_rules !== undefined) item.menu_rules = normalizeMenuRules(menu_rules);
      else if (channels !== undefined) item.menu_rules = defaultMenuRules(Array.isArray(channels) ? channels : item.channels);
      if (active !== undefined) item.active = Boolean(active);
      Object.assign(item, normalizeMenuItem(item));
      state.events.push(
        eventEntry({
          restaurant_id: state.restaurants[0]?.id || "rest_1",
          table_session_id: null,
          actor_operator_id: operator_id,
          terminal_id,
          action_type: "menu_item_updated",
          entity_type: "menu_item",
          entity_id: item.id,
          payload: { name: item.name, category: item.category, channels: item.channels },
        })
      );
      return { item };
    });
  }

  setMenuItemAvailability({ menu_key, menu_item_id, day, enabled, operator_id, terminal_id = "terminal_main" }) {
    return this.transact((state) => {
      const item = state.menu_items.find((row) => row.id === menu_item_id);
      if (!item) {
        const error = new Error("Prato não encontrado.");
        error.statusCode = 404;
        throw error;
      }
      if (!MENU_PROFILE_DEFS.some((profile) => profile.id === menu_key)) {
        const error = new Error("Menu inválido.");
        error.statusCode = 400;
        throw error;
      }
      const targetDay = Number(day);
      if (!Number.isInteger(targetDay) || targetDay < 0 || targetDay > 6) {
        const error = new Error("Dia inválido.");
        error.statusCode = 400;
        throw error;
      }
      const currentRules = normalizeMenuRules(item);
      const currentDays = new Set(currentRules[menu_key] || []);
      if (Boolean(enabled)) currentDays.add(targetDay);
      else currentDays.delete(targetDay);
      currentRules[menu_key] = Array.from(currentDays).sort((a, b) => a - b);
      item.menu_rules = currentRules;
      Object.assign(item, normalizeMenuItem(item));
      state.events.push(
        eventEntry({
          restaurant_id: state.restaurants[0]?.id || "rest_1",
          table_session_id: null,
          actor_operator_id: operator_id,
          terminal_id,
          action_type: "menu_day_toggled",
          entity_type: "menu_item",
          entity_id: item.id,
          payload: { menu_key, day: targetDay, enabled: Boolean(enabled), name: item.name },
        })
      );
      return { item };
    });
  }

  setMenuItemDays({ menu_key, menu_item_id, days = [], operator_id, terminal_id = "terminal_main" }) {
    return this.transact((state) => {
      const item = state.menu_items.find((row) => row.id === menu_item_id);
      if (!item) {
        const error = new Error("Prato não encontrado.");
        error.statusCode = 404;
        throw error;
      }
      const currentRules = normalizeMenuRules(item);
      currentRules[menu_key] = Array.isArray(days)
        ? days.map((day) => Number(day)).filter((day, idx, arr) => Number.isInteger(day) && day >= 0 && day <= 6 && arr.indexOf(day) === idx).sort((a, b) => a - b)
        : [];
      item.menu_rules = currentRules;
      Object.assign(item, normalizeMenuItem(item));
      state.events.push(
        eventEntry({
          restaurant_id: state.restaurants[0]?.id || "rest_1",
          table_session_id: null,
          actor_operator_id: operator_id,
          terminal_id,
          action_type: "menu_days_updated",
          entity_type: "menu_item",
          entity_id: item.id,
          payload: { menu_key, days: currentRules[menu_key], name: item.name },
        })
      );
      return { item };
    });
  }

  archiveMenuItem({ menu_item_id, operator_id, terminal_id = "terminal_main" }) {
    return this.transact((state) => {
      const item = state.menu_items.find((row) => row.id === menu_item_id);
      if (!item) {
        const error = new Error("Prato não encontrado.");
        error.statusCode = 404;
        throw error;
      }
      item.active = false;
      state.events.push(
        eventEntry({
          restaurant_id: state.restaurants[0]?.id || "rest_1",
          table_session_id: null,
          actor_operator_id: operator_id,
          terminal_id,
          action_type: "menu_item_archived",
          entity_type: "menu_item",
          entity_id: item.id,
          payload: { name: item.name },
        })
      );
      return { item };
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
    const kitchen_items = session ? state.kitchen_items.filter((item) => item.table_session_id === session.id) : [];
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
      const stamp = nowIso();
      for (const item of orderItems) {
        item.status = "sent";
        item.updated_at = stamp;
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
          created_at: stamp,
          sent_to_kitchen_at: stamp,
          updated_at: stamp,
          sent_by_operator_id: operator_id,
        });
      }
      session.status = "sent";
      session.updated_at = stamp;
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

  getServiceBoard() {
    const state = this.read();
    const operatorMap = new Map(state.operators.map((row) => [row.id, row.name]));
    const sessions = state.table_sessions
      .slice()
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .map((session) => {
        const items = this.getOrderItemsForSession(state, session.id);
        const total = items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unit_price || 0), 0);
        return {
          ...session,
          operator_name: operatorMap.get(session.operator_id) || "—",
          total,
          item_count: items.reduce((sum, item) => sum + Number(item.quantity), 0),
        };
      });

    return {
      open_tables: this.listTablesDetailed(state).filter((table) => Boolean(table.session)),
      recent_sessions: sessions.slice(0, 12),
      closed_sessions: sessions.filter((session) => session.status === "closed").slice(0, 12),
      recent_events: state.events
        .slice()
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, 20)
        .map((evt) => ({
          ...evt,
          actor_name: operatorMap.get(evt.actor_operator_id) || "—",
        })),
      kitchen: this.getKitchenBoard(state),
    };
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
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0] || null;
  }

  getOrderItemsForSession(state, session_id) {
    return state.order_items
      .filter((row) => row.table_session_id === session_id)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  }
}

export const restaurantStore = new RestaurantStore();
