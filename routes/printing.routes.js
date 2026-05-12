import express from "express";
import { printersService } from "../services/printers.service.js";

const router = express.Router();

function requireAdmin(req) {
  const auth = req.session?.restaurantAuth || null;
  if (!auth?.user_id) {
    const error = new Error("Sessão expirada. Inicia sessão novamente.");
    error.status = 401;
    throw error;
  }
  if (auth.role !== "admin") {
    const error = new Error("Só admin pode gerir impressoras.");
    error.status = 403;
    throw error;
  }
  return auth;
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

router.post("/agents/register", asyncHandler(async (req, res) => {
  const { agent_id, token, printers, host_name, platform, version, metadata } = req.body || {};
  if (token !== process.env.AGENT_TOKEN) {
    return res.status(403).json({ error: "token_invalido" });
  }

  const result = await printersService.registerAgent({
    agent_id,
    printers: Array.isArray(printers) ? printers : [],
    host_name,
    platform,
    version,
    metadata,
  });

  console.log(`Agent ${result.agent_id} registado com ${result.printers_count} impressoras`);
  return res.json(result);
}));

router.get("/printers", asyncHandler(async (req, res) => {
  const printers = await printersService.listRegisteredPrinters();
  return res.json({ printers });
}));

router.get("/printers/admin", asyncHandler(async (req, res) => {
  requireAdmin(req);
  return res.json(await printersService.listAdminPrinters());
}));

router.patch("/printers/config", asyncHandler(async (req, res) => {
  requireAdmin(req);
  const result = await printersService.updatePrinterConfig(req.body || {});
  return res.json(result);
}));

router.post("/print", asyncHandler(async (req, res) => {
  const { agent_id, printer_id, pdfUrl, pdf_url, printer_name, document_type, title, source_type, source_id, terminal_id } = req.body || {};
  const result = await printersService.createPrintJob({
    agent_id,
    printer_id,
    printer_name,
    pdfUrl: pdfUrl || pdf_url,
    document_type,
    title,
    source_type,
    source_id,
    terminal_id,
    requested_by_user_id: req.session?.restaurantAuth?.user_id || "",
  });
  return res.json(result);
}));

router.use((err, req, res, next) => {
  if (!err) return next();
  const status = Number(err.status || err.statusCode || 500);
  return res.status(status).json({ error: err.code || "printing_error", detail: err.message || "Erro de impressão." });
});

export default router;
