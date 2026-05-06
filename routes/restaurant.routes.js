import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { restaurantStore } from "../services/restaurant.store.js";
import { requireBodyFields } from "../services/restaurant.helpers.js";

const router = express.Router();

const uploadDir = path.join(process.cwd(), "public", "imagens", "pratos");
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
      const safeBase = String(file.originalname || 'prato')
        .replace(ext, '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase() || 'prato';
      cb(null, `${Date.now()}-${safeBase}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
});

function asyncHandler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      console.error("[restaurant.routes]", error);
      res.status(error.statusCode || 500).json({
        error: error.code || "restaurant_api_error",
        detail: error.message || "Erro interno.",
      });
    }
  };
}

function getPublicBaseUrl(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || process.env.RESTAURANT_PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (configured) return configured;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${req.get('host')}`.replace(/\/$/, '');
}

function toPublicAssetUrls(req, value) {
  const baseUrl = getPublicBaseUrl(req);
  const absolutize = (raw) => {
    const text = String(raw || '').trim();
    if (!text) return raw;
    if (/^(data:|https?:|blob:)/i.test(text)) return text;
    if (text.startsWith('/')) return `${baseUrl}${text}`;
    return text;
  };

  const walk = (input) => {
    if (Array.isArray(input)) return input.map(walk);
    if (!input || typeof input !== 'object') return input;
    if (input instanceof Date) return input;
    const out = {};
    for (const [key, itemValue] of Object.entries(input)) {
      out[key] = ['image_url', 'imagem_url', 'logo_url'].includes(key) ? absolutize(itemValue) : walk(itemValue);
    }
    return out;
  };

  return walk(value);
}

function getSessionAuth(req) {
  return req.session?.restaurantAuth || null;
}

function requireRestaurantAuth(req) {
  const auth = getSessionAuth(req);
  if (!auth?.user_id) {
    const error = new Error("Sessão inválida ou expirada.");
    error.statusCode = 401;
    error.code = "not_authenticated";
    throw error;
  }
  req.restaurantAuth = auth;
}

function requireAdmin(req) {
  requireRestaurantAuth(req);
  if (req.restaurantAuth?.role !== "admin") {
    const error = new Error("Apenas administrador.");
    error.statusCode = 403;
    error.code = "admin_only";
    throw error;
  }
}

function requireAnyRole(req, allowedRoles = []) {
  requireRestaurantAuth(req);
  const role = String(req.restaurantAuth?.role || "").toLowerCase();
  if (!allowedRoles.map((item) => String(item || "").toLowerCase()).includes(role)) {
    const error = new Error("Sem permissões para esta área.");
    error.statusCode = 403;
    error.code = "role_forbidden";
    throw error;
  }
}

function requireMenuManager(req) {
  requireAnyRole(req, ["admin", "kitchen"]);
}

function requireOperationalAccess(req) {
  requireRestaurantAuth(req);
  if (String(req.restaurantAuth?.role || "").toLowerCase() === "kitchen") {
    const error = new Error("Perfil cozinha sem acesso a esta área.");
    error.statusCode = 403;
    error.code = "kitchen_restricted_area";
    throw error;
  }
}

function filterTablesForTerminal(tables = [], terminalId = "terminal_main", search = "") {
  const normalizedTerminal = String(terminalId || "terminal_main").trim().toLowerCase();
  const normalizedSearch = String(search || "").trim().toLowerCase();

  const filtered = (Array.isArray(tables) ? tables : []).filter((table) => {
    const localNome = String(table?.local_nome || "").toLowerCase();
    const zone = String(table?.zone || "").toLowerCase();
    const code = String(table?.codigo || "").toLowerCase();
    const name = String(table?.name || table?.nome || "").toLowerCase();
    const sessionStatus = String(table?.session?.status || "").toLowerCase();
    const paymentPending = table?.has_pending_checkout_payment ? String(table?.payment_pending_label || 'pagamento pendente mbway').toLowerCase() : "";

    let terminalMatch = true;
    if (normalizedTerminal === "terminal_bar") terminalMatch = localNome === "bar" || zone === "bar";
    else if (normalizedTerminal === "terminal_takeaway") terminalMatch = localNome === "takeaway" || zone === "takeaway";
    else if (normalizedTerminal === "terminal_main") terminalMatch = !["bar", "takeaway"].includes(localNome);

    if (!terminalMatch) return false;
    if (!normalizedSearch) return true;

    return [name, code, zone, localNome, sessionStatus, paymentPending].some((value) => value.includes(normalizedSearch));
  });

  return filtered;
}

router.post("/auth/login", asyncHandler(async (req, res) => {
  requireBodyFields(req.body, ["email", "password"]);
  const result = await restaurantStore.authenticateUser({
    email: req.body.email,
    password: req.body.password,
  });
  req.session.restaurantAuth = {
    user_id: result.user.id,
    role: result.user.role,
    is_admin: result.user.is_admin,
  };
  res.json({ authenticated: true, user: result.user, is_admin: result.user.is_admin });
}));

router.get("/auth/me", asyncHandler(async (req, res) => {
  const auth = getSessionAuth(req);
  if (!auth?.user_id) {
    return res.json({ authenticated: false });
  }

  const user = await restaurantStore.getAuthUser(auth.user_id);
  if (!user) {
    req.session.restaurantAuth = null;
    return res.json({ authenticated: false });
  }

  req.session.restaurantAuth = {
    user_id: user.id,
    role: user.role,
    is_admin: user.is_admin,
  };
  res.json({ authenticated: true, user, is_admin: user.is_admin });
}));

router.post("/auth/logout", asyncHandler(async (req, res) => {
  await new Promise((resolve, reject) => {
    req.session.destroy((error) => (error ? reject(error) : resolve()));
  });
  res.json({ ok: true });
}));


router.get('/customer/resolve-table', asyncHandler(async (req, res) => {
  const table_code = String(req.query.table_code || req.query.qr || '').trim();
  if (!table_code) {
    const error = new Error('QR/mesa obrigatório.');
    error.statusCode = 400;
    error.code = 'table_code_required';
    throw error;
  }
  res.json(await restaurantStore.resolveCustomerTable({
    table_code,
    venue_type: req.query.venue_type || req.query.venue || '',
  }));
}));

router.post('/customer/session/start', asyncHandler(async (req, res) => {
  requireBodyFields(req.body, ['table_code']);
  const result = await restaurantStore.startCustomerSession({
    table_code: req.body.table_code,
    venue_type: req.body.venue_type || '',
    customer_name: req.body.customer_name || '',
    customer_phone: req.body.customer_phone || '',
    customer_email: req.body.customer_email || '',
    customer_nif: req.body.customer_nif || '',
    customer_count: req.body.customer_count || 1,
  });
  res.status(201).json(toPublicAssetUrls(req, result));
}));

router.get('/customer/session/:sessionId', asyncHandler(async (req, res) => {
  res.json(toPublicAssetUrls(req, await restaurantStore.getCustomerSession({ session_id: req.params.sessionId })));
}));

router.post('/customer/session/:sessionId/items', asyncHandler(async (req, res) => {
  requireBodyFields(req.body, ['menu_item_id']);
  const result = await restaurantStore.addCustomerItem({
    session_id: req.params.sessionId,
    menu_item_id: req.body.menu_item_id,
    quantity: req.body.quantity || 1,
    note: req.body.note || '',
  });
  res.status(201).json(toPublicAssetUrls(req, result));
}));

router.patch('/customer/session/:sessionId/items/:orderItemId', asyncHandler(async (req, res) => {
  requireBodyFields(req.body, ['quantity']);
  const result = await restaurantStore.updateCustomerItem({
    session_id: req.params.sessionId,
    order_item_id: req.params.orderItemId,
    quantity: req.body.quantity,
  });
  res.json(toPublicAssetUrls(req, result));
}));

router.delete('/customer/session/:sessionId/items/:orderItemId', asyncHandler(async (req, res) => {
  const result = await restaurantStore.removeCustomerItem({
    session_id: req.params.sessionId,
    order_item_id: req.params.orderItemId,
  });
  res.json(toPublicAssetUrls(req, result));
}));

router.post('/customer/session/:sessionId/submit', asyncHandler(async (req, res) => {
  requireBodyFields(req.body, ['payment_method']);
  const result = await restaurantStore.submitCustomerOrder({
    session_id: req.params.sessionId,
    payment_method: req.body.payment_method,
    customer_name: req.body.customer_name || '',
    customer_phone: req.body.customer_phone || '',
    customer_email: req.body.customer_email || '',
    customer_nif: req.body.customer_nif || '',
    mbway_contact: req.body.mbway_contact || '',
    venue_type: req.body.venue_type || '',
    send_email: req.body.send_email === true,
  });
  res.json(toPublicAssetUrls(req, result));
}));


router.post('/customer/session/:sessionId/send-to-kitchen', asyncHandler(async (req, res) => {
  const result = await restaurantStore.sendCustomerItemsToKitchen({
    session_id: req.params.sessionId,
    items: Array.isArray(req.body?.items) ? req.body.items : [],
  });
  res.json(toPublicAssetUrls(req, result));
}));

router.post('/customer/session/:sessionId/request-payment', asyncHandler(async (req, res) => {
  requireBodyFields(req.body, ['payment_method']);
  const result = await restaurantStore.requestCustomerPayment({
    session_id: req.params.sessionId,
    payment_method: req.body.payment_method,
    customer_name: req.body.customer_name || '',
    customer_phone: req.body.customer_phone || '',
    customer_email: req.body.customer_email || '',
    customer_nif: req.body.customer_nif || '',
    mbway_contact: req.body.mbway_contact || '',
    venue_type: req.body.venue_type || '',
    send_email: req.body.send_email === true,
  });
  res.json(toPublicAssetUrls(req, result));
}));

router.post('/customer/session/:sessionId/items/:orderItemId/note-chat/reply', asyncHandler(async (req, res) => {
  requireBodyFields(req.body, ['message']);
  const result = await restaurantStore.replyCustomerNoteThread({
    session_id: req.params.sessionId,
    order_item_id: req.params.orderItemId,
    message: req.body.message || '',
  });
  res.json(toPublicAssetUrls(req, result));
}));

router.get('/menu-items/:menuItemId/image', asyncHandler(async (req, res) => {
  const image = await restaurantStore.getMenuItemImage({ menu_item_id: req.params.menuItemId });
  res.setHeader('Content-Type', image.mime_type || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  if (image.filename) {
    res.setHeader('Content-Disposition', `inline; filename="${String(image.filename).replace(/"/g, '')}"`);
  }
  if (image.updated_at) res.setHeader('Last-Modified', new Date(image.updated_at).toUTCString());
  res.end(image.data);
}));

router.post('/payments/eupago/webhook', asyncHandler(async (req, res) => {
  const result = await restaurantStore.processEupagoWebhook({
    payload: req.body || {},
    headers: req.headers || {},
  });
  res.status(200).json(result || { ok: true });
}));

router.use((req, _res, next) => {
  try {
    const path = String(req.path || '');
    const originalUrl = String(req.originalUrl || '');
    if (
      path.startsWith('/customer') ||
      originalUrl.includes('/customer/') ||
      path === '/payments/eupago/webhook' ||
      path.startsWith('/payments/eupago/webhook/')
    ) {
      return next();
    }
    requireRestaurantAuth(req);
    next();
  } catch (error) {
    next(error);
  }
});

router.get("/bootstrap", asyncHandler(async (req, res) => {
  const terminal_id = String(req.query.terminal_id || "terminal_main");
  res.json(toPublicAssetUrls(req, await restaurantStore.getBootstrap(terminal_id)));
}));

router.get("/operators", asyncHandler(async (_req, res) => {
  res.json(await restaurantStore.listOperators());
}));

router.post("/operators/select", asyncHandler(async (req, res) => {
  requireBodyFields(req.body, ["operator_id"]);
  const result = await restaurantStore.selectOperator({
    terminal_id: req.body.terminal_id || "terminal_main",
    operator_id: req.body.operator_id,
    pin: req.body.pin ?? null,
  });
  res.json(result);
}));

router.post("/operators/active", asyncHandler(async (req, res) => {
  requireBodyFields(req.body, ["operator_id"]);
  const result = await restaurantStore.selectOperator({
    terminal_id: req.body.terminal_id || "terminal_main",
    operator_id: req.body.operator_id,
    pin: req.body.pin ?? null,
  });
  res.json(result);
}));

router.get("/operators/context", asyncHandler(async (req, res) => {
  const terminal_id = String(req.query.terminal_id || "terminal_main");
  res.json(await restaurantStore.getOperatorContext(terminal_id));
}));

router.get("/workers", asyncHandler(async (req, res) => {
  requireAdmin(req);
  res.json(await restaurantStore.listWorkers());
}));

router.post("/workers", asyncHandler(async (req, res) => {
  requireAdmin(req);
  requireBodyFields(req.body, ["name", "email", "password", "role"]);
  const result = await restaurantStore.createWorker({
    name: req.body.name,
    email: req.body.email,
    password: req.body.password,
    role: req.body.role,
    active: req.body.active !== false,
  });
  res.status(201).json(result);
}));

router.patch("/workers/:workerId", asyncHandler(async (req, res) => {
  requireAdmin(req);
  const result = await restaurantStore.updateWorker({
    worker_id: req.params.workerId,
    name: req.body.name,
    email: req.body.email,
    password: req.body.password,
    role: req.body.role,
    active: req.body.active,
  });
  res.json(result);
}));


router.get('/payment-requests', asyncHandler(async (req, res) => {
  requireOperationalAccess(req);
  res.json(await restaurantStore.listPendingPaymentRequests({ terminal_id: String(req.query.terminal_id || req.query.terminal || 'terminal_main') }));
}));

router.post('/payment-requests/:requestId/approve', asyncHandler(async (req, res) => {
  requireOperationalAccess(req);
  requireBodyFields(req.body, ['operator_id']);
  res.json(await restaurantStore.approvePaymentRequest({
    request_id: req.params.requestId,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || 'terminal_main',
  }));
}));

router.get("/tables", asyncHandler(async (req, res) => {
  requireOperationalAccess(req);
  const terminalId = String(req.query.terminal_id || req.query.terminal || "terminal_main");
  const search = String(req.query.search || "");
  const tables = await restaurantStore.listTables();
  res.json(filterTablesForTerminal(tables, terminalId, search));
}));

router.get("/tables/manage", asyncHandler(async (req, res) => {
  requireAdmin(req);
  res.json(await restaurantStore.listTableDefinitions());
}));

router.post("/tables/manage", asyncHandler(async (req, res) => {
  requireAdmin(req);
  requireBodyFields(req.body, ["number", "name", "operator_id"]);
  const result = await restaurantStore.createTable({
    number: req.body.number,
    name: req.body.name,
    zone: req.body.zone || "Sala",
    capacity: req.body.capacity || 4,
    active: req.body.active !== false,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
  });
  res.status(201).json(result);
}));

router.patch("/tables/manage/:tableId", asyncHandler(async (req, res) => {
  requireAdmin(req);
  requireBodyFields(req.body, ["operator_id"]);
  const result = await restaurantStore.updateTableDefinition({
    table_id: req.params.tableId,
    number: req.body.number,
    name: req.body.name,
    zone: req.body.zone,
    capacity: req.body.capacity,
    active: req.body.active,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
  });
  res.json(result);
}));

router.delete("/tables/manage/:tableId", asyncHandler(async (req, res) => {
  requireAdmin(req);
  requireBodyFields(req.body, ["operator_id"]);
  const result = await restaurantStore.archiveTableDefinition({
    table_id: req.params.tableId,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
  });
  res.json(result);
}));


router.get("/settings/qr", asyncHandler(async (req, res) => {
  requireAdmin(req);
  res.json(await restaurantStore.getTableQrAdminSettings());
}));

router.put("/settings/qr", asyncHandler(async (req, res) => {
  requireAdmin(req);
  const result = await restaurantStore.updateTableQrAdminSettings({
    restaurant_name: req.body.restaurant_name,
    logo_url: req.body.logo_url,
    wifi_ssid: req.body.wifi_ssid,
    wifi_password: req.body.wifi_password,
    wifi_security: req.body.wifi_security,
    wifi_hidden: req.body.wifi_hidden === true,
    wifi_label: req.body.wifi_label,
    print_note: req.body.print_note,
    operator_id: req.restaurantAuth.user_id,
  });
  res.json(result);
}));

router.get("/tables/manage/:tableId/qr", asyncHandler(async (req, res) => {
  requireAdmin(req);
  res.json(await restaurantStore.getTableQrBundle({
    table_id: req.params.tableId,
    operator_id: req.restaurantAuth.user_id,
    regenerate: String(req.query.regenerate || '') === '1',
  }));
}));

router.post("/tables/manage/:tableId/qr/regenerate", asyncHandler(async (req, res) => {
  requireAdmin(req);
  res.json(await restaurantStore.getTableQrBundle({
    table_id: req.params.tableId,
    operator_id: req.restaurantAuth.user_id,
    regenerate: true,
  }));
}));

router.get("/tables/manage/:tableId/print", asyncHandler(async (req, res) => {
  requireAdmin(req);
  const html = await restaurantStore.buildTableQrPrintHtml({
    table_id: req.params.tableId,
    operator_id: req.restaurantAuth.user_id,
    regenerate: String(req.query.regenerate || '') === '1',
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

router.get("/tables/:tableId", asyncHandler(async (req, res) => {
  requireOperationalAccess(req);
  const includeHistory = String(req.query.include_history || "").trim() === "1";
  res.json(await restaurantStore.getTableDetails(req.params.tableId, { includeHistory }));
}));

router.get("/tables/:tableId/history", asyncHandler(async (req, res) => {
  requireOperationalAccess(req);
  res.json(await restaurantStore.getHistory(req.params.tableId));
}));

router.post("/tables/open", asyncHandler(async (req, res) => {
  requireOperationalAccess(req);
  requireBodyFields(req.body, ["table_id", "operator_id"]);
  const result = await restaurantStore.openTable({
    table_id: req.body.table_id,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
    note: req.body.note || "",
  });
  res.status(201).json(result);
}));

router.post("/tables/:tableId/items", asyncHandler(async (req, res) => {
  requireOperationalAccess(req);
  requireBodyFields(req.body, ["menu_item_id", "operator_id"]);
  const result = await restaurantStore.addItem({
    table_id: req.params.tableId,
    menu_item_id: req.body.menu_item_id,
    quantity: req.body.quantity || 1,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
    note: req.body.note || "",
  });
  res.status(201).json(result);
}));

router.patch("/tables/:tableId/items/:orderItemId", asyncHandler(async (req, res) => {
  requireOperationalAccess(req);
  requireBodyFields(req.body, ["quantity", "operator_id"]);
  const result = await restaurantStore.updateItemQuantity({
    table_id: req.params.tableId,
    order_item_id: req.params.orderItemId,
    quantity: req.body.quantity,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
  });
  res.json(result);
}));

router.delete("/tables/:tableId/items/:orderItemId", asyncHandler(async (req, res) => {
  requireOperationalAccess(req);
  requireBodyFields(req.body, ["operator_id"]);
  const result = await restaurantStore.removeItem({
    table_id: req.params.tableId,
    order_item_id: req.params.orderItemId,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
  });
  res.json(result);
}));

router.post("/tables/:tableId/items/:orderItemId/status", asyncHandler(async (req, res) => {
  requireOperationalAccess(req);
  requireBodyFields(req.body, ["status", "operator_id"]);
  const result = await restaurantStore.updateOrderItemStatus({
    table_id: req.params.tableId,
    order_item_id: req.params.orderItemId,
    status: req.body.status,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
  });
  res.json(result);
}));

router.post("/tables/:tableId/send-to-kitchen", asyncHandler(async (req, res) => {
  requireOperationalAccess(req);
  requireBodyFields(req.body, ["operator_id"]);
  const result = await restaurantStore.sendTableToKitchen({
    table_id: req.params.tableId,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
    items: Array.isArray(req.body.items) ? req.body.items : [],
  });
  res.json(result);
}));

router.get("/tables/:tableId/checkout-preview", asyncHandler(async (req, res) => {
  requireOperationalAccess(req);
  const result = await restaurantStore.getCheckoutPreview({
    table_id: req.params.tableId,
  });
  res.json(result);
}));

router.post("/tables/:tableId/checkout", asyncHandler(async (req, res) => {
  requireOperationalAccess(req);
  requireBodyFields(req.body, ["operator_id", "payment_type"]);
  const result = await restaurantStore.processCheckout({
    table_id: req.params.tableId,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
    payment_type: req.body.payment_type,
    amount_received: req.body.amount_received,
    customer_nif: req.body.customer_nif || "",
    customer_name: req.body.customer_name || "",
    customer_email: req.body.customer_email || "",
    mbway_contact: req.body.mbway_contact || "",
    send_email: req.body.send_email === true,
    print_invoice: req.body.print_invoice === true,
    printer_id: req.body.printer_id || "",
    printer_agent_id: req.body.printer_agent_id || "",
    printer_name: req.body.printer_name || "",
  });
  res.json(result);
}));

router.post("/tables/:tableId/transfer-to-takeaway", asyncHandler(async (req, res) => {
  requireOperationalAccess(req);
  requireBodyFields(req.body, ["operator_id"]);
  const result = await restaurantStore.moveTableToTakeaway({
    table_id: req.params.tableId,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
    target_takeaway_table_id: req.body.target_takeaway_table_id || null,
  });
  res.json(result);
}));

router.post("/tables/:tableId/close", asyncHandler(async (req, res) => {
  requireOperationalAccess(req);
  requireBodyFields(req.body, ["operator_id"]);
  const result = await restaurantStore.closeTable({
    table_id: req.params.tableId,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
  });
  res.json(result);
}));

router.get("/kitchen/board", asyncHandler(async (_req, res) => {
  res.json(await restaurantStore.getKitchenBoard());
}));

router.post("/kitchen/items/:kitchenItemId/status", asyncHandler(async (req, res) => {
  requireBodyFields(req.body, ["status", "operator_id"]);
  const result = await restaurantStore.updateKitchenStatus({
    kitchen_item_id: req.params.kitchenItemId,
    status: req.body.status,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_kitchen",
  });
  res.json(result);
}));

router.post('/kitchen/items/:orderItemId/note-chat/reply', asyncHandler(async (req, res) => {
  requireBodyFields(req.body, ['operator_id']);
  const result = await restaurantStore.replyKitchenNoteThread({
    order_item_id: req.params.orderItemId,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || 'terminal_kitchen',
    preset_code: req.body.preset_code || '',
    message: req.body.message || '',
  });
  res.json(result);
}));

router.get("/menu-profiles", asyncHandler(async (req, res) => {
  requireMenuManager(req);
  res.json(await restaurantStore.listMenuProfiles());
}));

router.get("/menu-config", asyncHandler(async (req, res) => {
  requireMenuManager(req);
  const menu_key = String(req.query.menu_key || "sala");
  const day = req.query.day !== undefined ? Number(req.query.day) : undefined;
  res.json(await restaurantStore.getMenuConfig(menu_key, day));
}));

router.patch("/menu-config/:menuKey/items/:menuItemId", asyncHandler(async (req, res) => {
  requireMenuManager(req);
  requireBodyFields(req.body, ["operator_id"]);
  let result;
  if (Array.isArray(req.body.days)) {
    result = await restaurantStore.setMenuItemDays({
      menu_key: req.params.menuKey,
      menu_item_id: req.params.menuItemId,
      days: req.body.days,
      operator_id: req.body.operator_id,
      terminal_id: req.body.terminal_id || "terminal_main",
    });
  } else {
    requireBodyFields(req.body, ["day", "enabled"]);
    result = await restaurantStore.setMenuItemAvailability({
      menu_key: req.params.menuKey,
      menu_item_id: req.params.menuItemId,
      day: req.body.day,
      enabled: req.body.enabled,
      operator_id: req.body.operator_id,
      terminal_id: req.body.terminal_id || "terminal_main",
    });
  }
  res.json(result);
}));

router.get("/categories", asyncHandler(async (_req, res) => {
  res.json(await restaurantStore.listCategories());
}));
router.post("/payments/eupago/webhook", asyncHandler(async (req, res) => {
  console.log("[eupago webhook] headers:", req.headers);
  console.log("[eupago webhook] body:", JSON.stringify(req.body || {}, null, 2));

  // por agora só confirma receção
  res.status(200).json({ ok: true });
}));
router.post("/categories", asyncHandler(async (req, res) => {
  requireMenuManager(req);
  requireBodyFields(req.body, ["name"]);
  const result = await restaurantStore.createCategory({
    name: req.body.name,
    sort_order: req.body.sort_order,
  });
  res.status(201).json(result);
}));

router.patch("/categories/:categoryId", asyncHandler(async (req, res) => {
  requireMenuManager(req);
  const result = await restaurantStore.updateCategory({
    category_id: req.params.categoryId,
    name: req.body.name,
    sort_order: req.body.sort_order,
  });
  res.json(result);
}));

router.delete("/categories/:categoryId", asyncHandler(async (req, res) => {
  requireMenuManager(req);
  const result = await restaurantStore.deleteCategory({
    category_id: req.params.categoryId,
  });
  res.json(result);
}));

router.post("/uploads/menu-image", upload.single("image"), asyncHandler(async (req, res) => {
  requireMenuManager(req);
  if (!req.file) {
    const error = new Error("Imagem obrigatória.");
    error.statusCode = 400;
    error.code = "image_required";
    throw error;
  }
  res.status(201).json({
    ok: true,
    image_url: `/imagens/pratos/${req.file.filename}`,
    filename: req.file.filename,
  });
}));

router.get("/menu-items", asyncHandler(async (req, res) => {
  res.json(toPublicAssetUrls(req, await restaurantStore.listMenuItems()));
}));

router.post("/menu-items", asyncHandler(async (req, res) => {
  requireMenuManager(req);
  requireBodyFields(req.body, ["name", "operator_id"]);
  const result = await restaurantStore.createMenuItem({
    name: req.body.name,
    category: req.body.category,
    flow: req.body.flow ?? req.body.station,
    prep_minutes: req.body.prep_minutes,
    price: req.body.price,
    channels: req.body.channels,
    image_url: req.body.image_url ?? req.body.imagem_url,
    imagem_url: req.body.imagem_url ?? req.body.image_url,
    image_data_base64: req.body.image_data_base64,
    image_mime_type: req.body.image_mime_type,
    image_filename: req.body.image_filename,
    description: req.body.description ?? req.body.descricao_produto,
    descricao_produto: req.body.descricao_produto ?? req.body.description,
    preparation_details: req.body.preparation_details ?? req.body.modo_preparo,
    modo_preparo: req.body.modo_preparo ?? req.body.preparation_details,
    menu_rules: req.body.menu_rules,
    active: req.body.active,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
  });
  res.status(201).json(toPublicAssetUrls(req, result));
}));

router.patch("/menu-items/:menuItemId", asyncHandler(async (req, res) => {
  requireMenuManager(req);
  requireBodyFields(req.body, ["operator_id"]);
  const result = await restaurantStore.updateMenuItem({
    menu_item_id: req.params.menuItemId,
    name: req.body.name,
    category: req.body.category,
    flow: req.body.flow ?? req.body.station,
    prep_minutes: req.body.prep_minutes,
    price: req.body.price,
    channels: req.body.channels,
    image_url: req.body.image_url ?? req.body.imagem_url,
    imagem_url: req.body.imagem_url ?? req.body.image_url,
    image_data_base64: req.body.image_data_base64,
    image_mime_type: req.body.image_mime_type,
    image_filename: req.body.image_filename,
    description: req.body.description ?? req.body.descricao_produto,
    descricao_produto: req.body.descricao_produto ?? req.body.description,
    preparation_details: req.body.preparation_details ?? req.body.modo_preparo,
    modo_preparo: req.body.modo_preparo ?? req.body.preparation_details,
    menu_rules: req.body.menu_rules,
    active: req.body.active,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
  });
  res.json(toPublicAssetUrls(req, result));
}));
router.delete("/menu-items/:menuItemId", asyncHandler(async (req, res) => {
  requireMenuManager(req);
  requireBodyFields(req.body, ["operator_id"]);
  const result = await restaurantStore.archiveMenuItem({
    menu_item_id: req.params.menuItemId,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
  });
  res.json(result);
}));


router.post("/menu-items/:menuItemId/reorder", asyncHandler(async (req, res) => {
  requireMenuManager(req);
  requireBodyFields(req.body, ["direction"]);
  const result = await restaurantStore.reorderMenuItem({
    menu_item_id: req.params.menuItemId,
    direction: req.body.direction,
  });
  res.json(result);
}));


router.get("/printers", asyncHandler(async (req, res) => {
  requireRestaurantAuth(req);
  res.json(await restaurantStore.listRegisteredPrinters());
}));

router.get("/payment-intents/:intentId", asyncHandler(async (req, res) => {
  requireOperationalAccess(req);
  res.json(await restaurantStore.getCheckoutPaymentIntent(req.params.intentId));
}));

router.post("/payment-intents/:intentId/refresh", asyncHandler(async (req, res) => {
  requireOperationalAccess(req);
  requireBodyFields(req.body, ["operator_id"]);
  res.json(await restaurantStore.refreshCheckoutPaymentIntent({
    intent_id: req.params.intentId,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
  }));
}));

router.post("/payment-intents/:intentId/cancel", asyncHandler(async (req, res) => {
  requireOperationalAccess(req);
  requireBodyFields(req.body, ["operator_id"]);
  res.json(await restaurantStore.cancelCheckoutPaymentIntent({
    intent_id: req.params.intentId,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
  }));
}));

router.get("/invoices/local", asyncHandler(async (req, res) => {
  requireOperationalAccess(req);
  res.json(await restaurantStore.listLocalInvoices());
}));

router.get("/invoices", asyncHandler(async (req, res) => {
  requireOperationalAccess(req);
  res.json(await restaurantStore.listLocalInvoices());
}));

router.get("/service-board", asyncHandler(async (req, res) => {
  requireOperationalAccess(req);
  res.json(await restaurantStore.getServiceBoard());
}));

router.post("/demo/reset", asyncHandler(async (req, res) => {
  requireAdmin(req);
  res.json(await restaurantStore.resetDemoData(false));
}));

router.post("/demo/seed", asyncHandler(async (req, res) => {
  requireAdmin(req);
  res.json(await restaurantStore.resetDemoData(true));
}));

export default router;
