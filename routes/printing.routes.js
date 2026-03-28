import express from "express";
import { printersService } from "../services/printers.service.js";

const router = express.Router();

router.post("/agents/register", (req, res) => {
  const { agent_id, token, printers } = req.body || {};
  if (token !== process.env.AGENT_TOKEN) {
    return res.status(403).json({ error: "token_invalido" });
  }

  const result = printersService.registerAgent({
    agent_id,
    printers: Array.isArray(printers) ? printers : [],
  });

  console.log(`Agent ${agent_id} registado com ${result.printers_count} impressoras`);
  return res.json(result);
});

router.get("/printers", (req, res) => {
  return res.json(printersService.listRegisteredPrinters());
});

router.post("/print", (req, res) => {
  const { agent_id, printer_id, pdfUrl } = req.body || {};
  const socket = printersService.getAgentSocket(agent_id);
  if (!socket) {
    return res.status(404).json({ error: "agent_offline" });
  }

  socket.emit("print_job", { printer_id, pdfUrl });
  return res.json({ ok: true });
});

export default router;
