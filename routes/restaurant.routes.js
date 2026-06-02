import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { restaurantStore } from "../services/restaurant.store.js";
import { takeawayChatService } from "../services/takeaway-chat.service.js";
import { ownerAssistantService } from "../services/restaurant-owner-assistant.service.js";
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
  const [bootstrap, pendingPaymentRequests, takeawayChatOrders] = await Promise.all([
    restaurantStore.getBootstrap(terminal_id),
    restaurantStore.listPendingPaymentRequests({ terminal_id }).catch(() => ({ items: [], total: 0 })),
    String(terminal_id).toLowerCase() === "terminal_takeaway"
      ? takeawayChatService.listOrders({ status: "active" }).catch(() => ({ orders: [] }))
      : Promise.resolve(null),
  ]);

  res.json(toPublicAssetUrls(req, {
    ...bootstrap,
    pending_payment_requests: pendingPaymentRequests?.items || [],
    pending_payment_requests_total: Number(pendingPaymentRequests?.total || 0),
    ...(takeawayChatOrders ? { takeaway_chat_orders: takeawayChatOrders.orders || [] } : {}),
  }));
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


router.post("/assistant/message", asyncHandler(async (req, res) => {
  requireAdmin(req);
  const result = await ownerAssistantService.handleMessage({
    message: req.body.message || '',
    operator_id: req.body.operator_id || req.restaurantAuth?.user_id || null,
    terminal_id: req.body.terminal_id || 'terminal_main',
  });
  res.json(result);
}));

router.post("/assistant/actions/confirm", asyncHandler(async (req, res) => {
  requireAdmin(req);
  const result = await ownerAssistantService.confirmAction({
    action: req.body.action || {},
    operator_id: req.body.operator_id || req.restaurantAuth?.user_id || null,
    terminal_id: req.body.terminal_id || 'terminal_main',
  });
  res.json(result);
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

router.post("/customer/takeaway-chat/message", asyncHandler(async (req, res) => {
  requireBodyFields(req.body, ["message"]);
  const result = await takeawayChatService.handleCustomerMessage({
    conversation_id: req.body.conversation_id || null,
    message: req.body.message || "",
  });
  res.json(result);
}));

router.get("/takeaway-chat/orders", asyncHandler(async (req, res) => {
  requireOperationalAccess(req);
  const result = await takeawayChatService.listOrders({
    status: req.query.status || "active",
  });
  res.json(result);
}));

router.post("/takeaway-chat/orders/:orderId/status", asyncHandler(async (req, res) => {
  requireOperationalAccess(req);
  requireBodyFields(req.body, ["status", "operator_id"]);
  const result = await takeawayChatService.updateOrderStatus({
    order_id: req.params.orderId,
    status: req.body.status,
    operator_id: req.body.operator_id || "",
    staff_notes: req.body.staff_notes || "",
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


const MENU_EXPORT_DAY_LABELS = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatEuro(value) {
  const amount = Number(value || 0);
  return new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' }).format(Number.isFinite(amount) ? amount : 0);
}

function sortMenuExportItems(items = []) {
  return [...items].sort((a, b) =>
    Number(a.category_sort_order || 0) - Number(b.category_sort_order || 0) ||
    String(a.category || 'Sem categoria').localeCompare(String(b.category || 'Sem categoria'), 'pt') ||
    Number(a.sort_order || 0) - Number(b.sort_order || 0) ||
    String(a.name || '').localeCompare(String(b.name || ''), 'pt')
  );
}

function groupedMenuExportItems(items = []) {
  const groups = new Map();
  for (const item of sortMenuExportItems(items)) {
    const category = item.category || 'Sem categoria';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(item);
  }
  return [...groups.entries()];
}

function renderMenuExportDaySection({ day, items }) {
  const groups = groupedMenuExportItems(items);
  const count = items.length;
  return `
    <section class="day-section">
      <div class="day-head">
        <div>
          <p class="eyebrow">${escapeHtml(MENU_EXPORT_DAY_LABELS[day] || 'Menu')}</p>
          <h2>${escapeHtml(MENU_EXPORT_DAY_LABELS[day] || 'Menu')}</h2>
        </div>
        <span>${count} prato${count === 1 ? '' : 's'}</span>
      </div>
      ${groups.length ? groups.map(([category, categoryItems]) => `
        <section class="category-section">
          <h3>${escapeHtml(category)}</h3>
          <div class="items-grid">
            ${categoryItems.map((item) => {
              const image = item.image_url || item.imagem_url || '';
              const description = item.description || item.descricao_produto || '';
              return `
                <article class="menu-item">
                  ${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(item.name)}" />` : '<div class="image-placeholder"></div>'}
                  <div class="item-body">
                    <div class="item-top">
                      <strong>${escapeHtml(item.name || '—')}</strong>
                      <span>${formatEuro(item.price)}</span>
                    </div>
                    ${description ? `<p>${escapeHtml(description)}</p>` : ''}
                    <small>${escapeHtml(item.flow || item.station || 'cozinha')}${item.prep_minutes ? ` · ${Number(item.prep_minutes)} min` : ''}</small>
                  </div>
                </article>`;
            }).join('')}
          </div>
        </section>`).join('') : '<div class="empty-export">Sem pratos ativos neste menu/dia.</div>'}
    </section>`;
}

function renderPrintableMenuHtml({ profile, sections, generatedAt, baseUrl, autoPrint }) {
  const totalItems = sections.reduce((sum, section) => sum + section.items.length, 0);
  return `<!doctype html>
<html lang="pt">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(profile.name)} - menu</title>
  <style>
    :root{--ink:#111827;--muted:#64748b;--line:#dbe3ef;--accent:#0f766e;--soft:#ecfdf5;--paper:#fffdf8}
    *{box-sizing:border-box}
    body{margin:0;background:#eef2f7;color:var(--ink);font-family:Arial,Helvetica,sans-serif;line-height:1.35}
    .toolbar{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;gap:12px;align-items:center;padding:12px 18px;background:#0f172a;color:#fff;box-shadow:0 10px 30px rgba(15,23,42,.18)}
    .toolbar strong{font-size:15px}.toolbar button{border:0;border-radius:12px;padding:10px 14px;font-weight:800;cursor:pointer}.toolbar .primary{background:#14b8a6;color:#06201d}.toolbar .ghost{background:#fff;color:#0f172a}
    .page{width:min(1040px,100%);margin:24px auto;padding:28px;background:var(--paper);border:1px solid var(--line);border-radius:28px;box-shadow:0 24px 80px rgba(15,23,42,.12)}
    .cover{display:grid;gap:10px;text-align:center;padding:22px 16px 26px;border:2px solid var(--accent);border-radius:28px;background:linear-gradient(180deg,#ffffff 0%,#f8fffd 100%)}
    .eyebrow{margin:0;color:var(--accent);font-weight:900;letter-spacing:.16em;text-transform:uppercase;font-size:12px}.cover h1{margin:0;font-size:42px;line-height:1}.cover p{margin:0;color:var(--muted)}
    .cover .count{display:inline-flex;justify-self:center;margin-top:8px;padding:8px 14px;border-radius:999px;background:var(--soft);color:var(--accent);font-weight:900}
    .day-section{break-inside:avoid;margin-top:28px}.day-head{display:flex;justify-content:space-between;align-items:end;gap:16px;border-bottom:2px solid var(--ink);padding-bottom:10px}.day-head h2{margin:0;font-size:28px}.day-head span{font-weight:900;color:var(--accent)}
    .category-section{margin-top:22px;break-inside:avoid}.category-section h3{margin:0 0 12px;font-size:20px;color:#0f172a;border-left:6px solid var(--accent);padding-left:10px}
    .items-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.menu-item{display:grid;grid-template-columns:118px minmax(0,1fr);gap:12px;border:1px solid var(--line);border-radius:18px;background:#fff;padding:10px;break-inside:avoid;min-height:120px}.menu-item img,.image-placeholder{width:118px;height:96px;object-fit:cover;border-radius:14px;background:#eef2f7;border:1px solid var(--line)}
    .item-body{display:grid;gap:6px;align-content:start}.item-top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.item-top strong{font-size:17px}.item-top span{font-weight:900;white-space:nowrap;color:#0f766e}.item-body p{margin:0;color:#334155;font-size:13px}.item-body small{color:var(--muted)}
    .empty-export{border:1px dashed var(--line);border-radius:18px;padding:18px;color:var(--muted);margin-top:14px;background:#fff}.footer{margin-top:24px;padding-top:14px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:12px;color:var(--muted);font-size:12px;flex-wrap:wrap}
    @page{size:A4;margin:12mm}
    @media print{body{background:#fff}.toolbar{display:none}.page{width:auto;margin:0;padding:0;border:0;box-shadow:none;border-radius:0}.cover{break-inside:avoid}.items-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.menu-item{box-shadow:none}.day-section{page-break-inside:auto}}
    @media (max-width:760px){.items-grid{grid-template-columns:1fr}.menu-item{grid-template-columns:96px minmax(0,1fr)}.menu-item img,.image-placeholder{width:96px;height:82px}.cover h1{font-size:34px}}
  </style>
</head>
<body>
  <div class="toolbar">
    <strong>Pré-visualização para PDF · usa “Guardar como PDF”</strong>
    <div><button class="ghost" onclick="window.close()">Fechar</button> <button class="primary" onclick="window.print()">Imprimir / Guardar PDF</button></div>
  </div>
  <main class="page">
    <section class="cover">
      <p class="eyebrow">Menu</p>
      <h1>${escapeHtml(profile.name)}</h1>
      <p>${escapeHtml(profile.description || '')}</p>
      <span class="count">${totalItems} prato${totalItems === 1 ? '' : 's'} no documento</span>
    </section>
    ${sections.map((section) => renderMenuExportDaySection(section)).join('')}
    <div class="footer"><span>Gerado em ${escapeHtml(generatedAt)}</span><span>${escapeHtml(baseUrl)}</span></div>
  </main>
  ${autoPrint ? '<script>window.addEventListener("load",()=>setTimeout(()=>window.print(),450));</script>' : ''}
</body>
</html>`;
}

router.get("/menu-profiles", asyncHandler(async (req, res) => {
  requireMenuManager(req);
  res.json(await restaurantStore.listMenuProfiles());
}));

router.get("/menu-config", asyncHandler(async (req, res) => {
  requireMenuManager(req);
  const menu_key = String(req.query.menu_key || "sala");
  const day = req.query.day !== undefined ? Number(req.query.day) : undefined;
  res.json(toPublicAssetUrls(req, await restaurantStore.getMenuConfig(menu_key, day)));
}));


router.get("/menu-export/:menuKey/pdf", asyncHandler(async (req, res) => {
  requireMenuManager(req);
  const menuKey = String(req.params.menuKey || 'sala');
  const profiles = await restaurantStore.listMenuProfiles();
  const profile = profiles.find((row) => row.id === menuKey);
  if (!profile) {
    const error = new Error('Menu inválido.');
    error.statusCode = 400;
    error.code = 'invalid_menu_key';
    throw error;
  }

  const dayRaw = String(req.query.day ?? new Date().getDay()).toLowerCase();
  const days = dayRaw === 'all'
    ? [0, 1, 2, 3, 4, 5, 6]
    : [Number(dayRaw)].filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);

  if (!days.length) {
    const error = new Error('Dia inválido.');
    error.statusCode = 400;
    error.code = 'invalid_day';
    throw error;
  }

  const sections = await Promise.all(days.map(async (day) => {
    const config = toPublicAssetUrls(req, await restaurantStore.getMenuConfig(menuKey, day));
    return {
      day,
      items: sortMenuExportItems(config.enabled_items || []),
    };
  }));

  const generatedAt = new Date().toLocaleString('pt-PT', { dateStyle: 'short', timeStyle: 'short' });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderPrintableMenuHtml({
    profile,
    sections,
    generatedAt,
    baseUrl: getPublicBaseUrl(req),
    autoPrint: String(req.query.autoprint || '1') !== '0',
  }));
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

router.post("/categories/:categoryId/reorder", asyncHandler(async (req, res) => {
  requireMenuManager(req);
  requireBodyFields(req.body, ["direction"]);
  const result = await restaurantStore.reorderCategory({
    category_id: req.params.categoryId,
    direction: req.body.direction,
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
  const localNome = String(req.query.local_nome || req.query.local || '').trim();
  const availableToday = ['1', 'true', 'yes', 'sim'].includes(String(req.query.available_today || req.query.today || '').toLowerCase());
  const items = localNome && availableToday
    ? await restaurantStore.listMenuItemsForLocal({ local_nome: localNome })
    : await restaurantStore.listMenuItems();
  res.json(toPublicAssetUrls(req, items));
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
