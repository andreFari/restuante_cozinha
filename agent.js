import express from "express";
import os from "os";
import fs from "fs";
import path from "path";
import { exec, execFile } from "child_process";
import axios from "axios";
import { io as Client } from "socket.io-client";

const BACKEND_URL = String(process.env.BACKEND_URL || "http://127.0.0.1:10000").replace(/\/$/, "");
const AGENT_TOKEN = process.env.AGENT_TOKEN || "";
const AGENT_ID = process.env.AGENT_ID || os.hostname();
const AGENT_PORT = Number(process.env.AGENT_PORT || 3001);
const AGENT_VERSION = "2026-05-12-printing-v2";

const printerQueues = new Map();
const processingPrinters = new Set();
let socket = null;

function run(command, options = {}) {
  return new Promise((resolve, reject) => {
    exec(command, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function runFile(file, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function listPrinters() {
  if (process.platform === "win32") {
    try {
      const { stdout } = await run('powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Printer | Select-Object Name, DriverName, Shared, WorkOffline | ConvertTo-Json -Compress"');
      const parsed = JSON.parse(stdout || "[]");
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows.filter(Boolean).map((p) => ({
        printer_id: String(p.Name || ""),
        system_name: String(p.Name || ""),
        display_name: String(p.Name || ""),
        driver: String(p.DriverName || ""),
        shared: p.Shared === true,
        offline: p.WorkOffline === true,
        agent_id: AGENT_ID,
      })).filter((p) => p.printer_id);
    } catch (error) {
      console.error("Erro a listar impressoras Windows:", error.message);
      return [];
    }
  }

  try {
    const { stdout } = await run("lpstat -p 2>/dev/null | awk '{print $2}'");
    return stdout.split("\n").map((name) => name.trim()).filter(Boolean).map((name) => ({
      printer_id: name,
      system_name: name,
      display_name: name,
      agent_id: AGENT_ID,
      offline: false,
    }));
  } catch (error) {
    console.error("Erro a listar impressoras CUPS:", error.message);
    return [];
  }
}

async function registerPrinters() {
  const printers = await listPrinters();
  if (!AGENT_TOKEN) {
    console.error("AGENT_TOKEN em falta. Define o mesmo token no backend e no computador da impressora.");
    return printers;
  }

  try {
    await axios.post(`${BACKEND_URL}/api/agents/register`, {
      agent_id: AGENT_ID,
      token: AGENT_TOKEN,
      host_name: os.hostname(),
      platform: process.platform,
      version: AGENT_VERSION,
      printers,
    }, { timeout: 10000 });
    console.log(`[${AGENT_ID}] ${printers.length} impressoras registadas no backend`);
  } catch (err) {
    console.error("Erro a registar impressoras:", err.response?.data?.detail || err.response?.data?.error || err.message);
  }
  return printers;
}

function safeExtFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).toLowerCase();
    if ([".pdf", ".html", ".htm", ".txt"].includes(ext)) return ext;
  } catch {}
  return ".html";
}

async function downloadPrintFile(url, jobId) {
  const ext = safeExtFromUrl(url);
  const targetPath = path.join(os.tmpdir(), `restaurant-print-${jobId || Date.now()}${ext}`);
  const response = await axios.get(url, { responseType: "stream", timeout: 20000 });
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(targetPath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
  return targetPath;
}

async function printFileOnWindows(filePath, printerName) {
  const script = [
    "$file = $args[0]",
    "$printer = $args[1]",
    "Start-Process -FilePath $file -Verb PrintTo -ArgumentList ('\"' + $printer + '\"') -Wait",
  ].join("; ");
  await runFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script, filePath, printerName], { timeout: 60000 });
}

async function printFileWithCups(filePath, printerName) {
  await runFile("lp", ["-d", printerName, filePath], { timeout: 60000 });
}

async function printFile(filePath, printerName) {
  if (!printerName) throw new Error("printer_id em falta no job de impressão");
  if (process.platform === "win32") {
    await printFileOnWindows(filePath, printerName);
    return;
  }
  await printFileWithCups(filePath, printerName);
}

function emitPrintResult(payload) {
  if (socket?.connected) {
    socket.emit("print_job_result", payload);
  }
}

function enqueuePrintJob(job) {
  const printerId = String(job.printer_id || "");
  if (!printerId) {
    emitPrintResult({ job_id: job.job_id, status: "failed", error_message: "printer_id em falta" });
    return;
  }
  const queue = printerQueues.get(printerId) || [];
  queue.push(job);
  printerQueues.set(printerId, queue);
  processPrinterQueue(printerId).catch((error) => console.error("Erro na fila de impressão:", error.message));
}

async function processPrinterQueue(printerId) {
  if (processingPrinters.has(printerId)) return;
  processingPrinters.add(printerId);
  try {
    const queue = printerQueues.get(printerId) || [];
    while (queue.length) {
      const job = queue.shift();
      const jobId = job.job_id || job.id || `${Date.now()}`;
      let localFile = "";
      try {
        emitPrintResult({ job_id: jobId, status: "printing" });
        localFile = await downloadPrintFile(job.pdfUrl || job.pdf_url, jobId);
        await printFile(localFile, printerId);
        emitPrintResult({ job_id: jobId, status: "printed" });
        console.log(`[${AGENT_ID}] Job ${jobId} enviado para ${printerId}`);
      } catch (error) {
        emitPrintResult({ job_id: jobId, status: "failed", error_message: error.stderr || error.message || "Falha de impressão" });
        console.error(`[${AGENT_ID}] Falha no job ${jobId}:`, error.stderr || error.message);
      } finally {
        if (localFile) fs.promises.unlink(localFile).catch(() => null);
      }
    }
  } finally {
    processingPrinters.delete(printerId);
  }
}

async function connectSocket() {
  if (!AGENT_TOKEN) return;
  socket = Client(BACKEND_URL, {
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 15000,
  });

  socket.on("connect", async () => {
    const printers = await listPrinters();
    socket.emit("register_agent", {
      agent_id: AGENT_ID,
      token: AGENT_TOKEN,
      host_name: os.hostname(),
      platform: process.platform,
      version: AGENT_VERSION,
      printers,
    });
  });

  socket.on("agent_registered", (payload) => {
    if (payload?.ok) console.log(`[${AGENT_ID}] socket ligado ao backend`);
    else console.error(`[${AGENT_ID}] socket recusado:`, payload?.error || "erro desconhecido");
  });

  socket.on("print_job", (job) => {
    enqueuePrintJob(job || {});
  });

  socket.on("disconnect", () => {
    console.log(`[${AGENT_ID}] socket desligado`);
  });

  setInterval(() => {
    if (socket?.connected) socket.emit("agent_heartbeat", { agent_id: AGENT_ID });
  }, 30000);
}

const app = express();
app.get("/printers", async (req, res) => {
  res.json(await listPrinters());
});
app.get("/health", (req, res) => {
  res.json({ ok: true, agent_id: AGENT_ID, backend: BACKEND_URL, socket_connected: socket?.connected === true });
});
app.listen(AGENT_PORT, () => console.log(`Agent ${AGENT_ID} a correr na porta ${AGENT_PORT}`));

setInterval(registerPrinters, 60000);
registerPrinters();
connectSocket();
