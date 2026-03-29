import express from "express";
import { restaurantStore } from "../services/restaurant.store.js";
import { requireBodyFields } from "../services/restaurant.helpers.js";

const router = express.Router();

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

router.get("/bootstrap", asyncHandler(async (req, res) => {
  const terminal_id = String(req.query.terminal_id || "terminal_main");
  res.json(restaurantStore.getBootstrap(terminal_id));
}));

router.get("/operators", asyncHandler(async (_req, res) => {
  res.json(restaurantStore.listOperators());
}));

router.post("/operators/select", asyncHandler(async (req, res) => {
  requireBodyFields(req.body, ["operator_id"]);
  const result = restaurantStore.selectOperator({
    terminal_id: req.body.terminal_id || "terminal_main",
    operator_id: req.body.operator_id,
    pin: req.body.pin ?? null,
  });
  res.json(result);
}));

router.get("/operators/context", asyncHandler(async (req, res) => {
  const terminal_id = String(req.query.terminal_id || "terminal_main");
  res.json(restaurantStore.getOperatorContext(terminal_id));
}));

router.get("/tables", asyncHandler(async (_req, res) => {
  res.json(restaurantStore.listTables());
}));

router.get("/tables/manage", asyncHandler(async (_req, res) => {
  res.json(restaurantStore.listTableDefinitions());
}));

router.post("/tables/manage", asyncHandler(async (req, res) => {
  requireBodyFields(req.body, ["number", "name", "operator_id"]);
  const result = restaurantStore.createTable({
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
  requireBodyFields(req.body, ["operator_id"]);
  const result = restaurantStore.updateTableDefinition({
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
  requireBodyFields(req.body, ["operator_id"]);
  const result = restaurantStore.archiveTableDefinition({
    table_id: req.params.tableId,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
  });
  res.json(result);
}));

router.get("/tables/:tableId", asyncHandler(async (req, res) => {
  res.json(restaurantStore.getTableDetails(req.params.tableId));
}));

router.get("/tables/:tableId/history", asyncHandler(async (req, res) => {
  res.json(restaurantStore.getHistory(req.params.tableId));
}));

router.post("/tables/open", asyncHandler(async (req, res) => {
  requireBodyFields(req.body, ["table_id", "operator_id"]);
  const result = restaurantStore.openTable({
    table_id: req.body.table_id,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
    note: req.body.note || "",
  });
  res.status(201).json(result);
}));

router.post("/tables/:tableId/items", asyncHandler(async (req, res) => {
  requireBodyFields(req.body, ["menu_item_id", "operator_id"]);
  const result = restaurantStore.addItem({
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
  requireBodyFields(req.body, ["quantity", "operator_id"]);
  const result = restaurantStore.updateItemQuantity({
    table_id: req.params.tableId,
    order_item_id: req.params.orderItemId,
    quantity: req.body.quantity,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
  });
  res.json(result);
}));

router.delete("/tables/:tableId/items/:orderItemId", asyncHandler(async (req, res) => {
  requireBodyFields(req.body, ["operator_id"]);
  const result = restaurantStore.removeItem({
    table_id: req.params.tableId,
    order_item_id: req.params.orderItemId,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
  });
  res.json(result);
}));

router.post("/tables/:tableId/send-to-kitchen", asyncHandler(async (req, res) => {
  requireBodyFields(req.body, ["operator_id"]);
  const result = restaurantStore.sendTableToKitchen({
    table_id: req.params.tableId,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
  });
  res.json(result);
}));

router.post("/tables/:tableId/close", asyncHandler(async (req, res) => {
  requireBodyFields(req.body, ["operator_id"]);
  const result = restaurantStore.closeTable({
    table_id: req.params.tableId,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
  });
  res.json(result);
}));

router.get("/kitchen/board", asyncHandler(async (_req, res) => {
  res.json(restaurantStore.getKitchenBoard());
}));

router.post("/kitchen/items/:kitchenItemId/status", asyncHandler(async (req, res) => {
  requireBodyFields(req.body, ["status", "operator_id"]);
  const result = restaurantStore.updateKitchenStatus({
    kitchen_item_id: req.params.kitchenItemId,
    status: req.body.status,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_kitchen",
  });
  res.json(result);
}));

router.get("/menu-profiles", asyncHandler(async (_req, res) => {
  res.json(restaurantStore.listMenuProfiles());
}));

router.get("/menu-config", asyncHandler(async (req, res) => {
  const menu_key = String(req.query.menu_key || "sala");
  const day = req.query.day !== undefined ? Number(req.query.day) : undefined;
  res.json(restaurantStore.getMenuConfig(menu_key, day));
}));

router.patch("/menu-config/:menuKey/items/:menuItemId", asyncHandler(async (req, res) => {
  requireBodyFields(req.body, ["operator_id"]);
  let result;
  if (Array.isArray(req.body.days)) {
    result = restaurantStore.setMenuItemDays({
      menu_key: req.params.menuKey,
      menu_item_id: req.params.menuItemId,
      days: req.body.days,
      operator_id: req.body.operator_id,
      terminal_id: req.body.terminal_id || "terminal_main",
    });
  } else {
    requireBodyFields(req.body, ["day", "enabled"]);
    result = restaurantStore.setMenuItemAvailability({
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

router.get("/menu-items", asyncHandler(async (_req, res) => {
  res.json(restaurantStore.listMenuItems());
}));

router.post("/menu-items", asyncHandler(async (req, res) => {
  requireBodyFields(req.body, ["name", "operator_id"]);
  const result = restaurantStore.createMenuItem({
    name: req.body.name,
    category: req.body.category,
    station: req.body.station,
    prep_minutes: req.body.prep_minutes,
    price: req.body.price,
    channels: req.body.channels,
    menu_rules: req.body.menu_rules,
    active: req.body.active,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
  });
  res.status(201).json(result);
}));

router.patch("/menu-items/:menuItemId", asyncHandler(async (req, res) => {
  requireBodyFields(req.body, ["operator_id"]);
  const result = restaurantStore.updateMenuItem({
    menu_item_id: req.params.menuItemId,
    name: req.body.name,
    category: req.body.category,
    station: req.body.station,
    prep_minutes: req.body.prep_minutes,
    price: req.body.price,
    channels: req.body.channels,
    menu_rules: req.body.menu_rules,
    active: req.body.active,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
  });
  res.json(result);
}));

router.delete("/menu-items/:menuItemId", asyncHandler(async (req, res) => {
  requireBodyFields(req.body, ["operator_id"]);
  const result = restaurantStore.archiveMenuItem({
    menu_item_id: req.params.menuItemId,
    operator_id: req.body.operator_id,
    terminal_id: req.body.terminal_id || "terminal_main",
  });
  res.json(result);
}));

router.get("/service-board", asyncHandler(async (_req, res) => {
  res.json(restaurantStore.getServiceBoard());
}));

router.post("/demo/reset", asyncHandler(async (_req, res) => {
  res.json(restaurantStore.resetDemoData(false));
}));

router.post("/demo/seed", asyncHandler(async (_req, res) => {
  res.json(restaurantStore.resetDemoData(true));
}));

export default router;
