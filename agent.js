import express from "express";
import os from "os";
import { exec } from "child_process";
import axios from "axios";
import { io as Client } from "socket.io-client";

const BACKEND_URL = process.env.BACKEND_URL;
const AGENT_TOKEN = process.env.AGENT_TOKEN;

// --- EXPRESS LOCAL (para teste manual) ---
const app = express();
app.get("/printers", async (req, res) => {
  const printers = await listPrinters();
  res.json(printers);
});
app.listen(3001, () =>
  console.log(`Agent ${AGENT_ID} a correr na porta 3001...`)
);

// --- FUNÇÃO: LISTAR IMPRESSORAS ---
async function listPrinters() {
  if (process.platform === "win32") {
    // Windows: usar PowerShell
    return new Promise((resolve) => {
      exec(
        'powershell -Command "Get-Printer | Select-Object Name, DriverName, Shared, WorkOffline | ConvertTo-Json"',
        (err, stdout) => {
          if (err) return resolve([]);
          try {
            const data = JSON.parse(stdout);
            const arr = Array.isArray(data) ? data : [data];
            resolve(
              arr.map((p) => ({
                printer_id: p.Name,
                display_name: p.Name,
                driver: p.DriverName,
                shared: p.Shared,
                offline: p.WorkOffline,
                agent_id: AGENT_ID,
              }))
            );
          } catch {
            resolve([]);
          }
        }
      );
    });
  } else {
    // Linux / macOS via CUPS
    return new Promise((resolve) => {
      exec("lpstat -p | awk '{print $2}'", (err, stdout) => {
        if (err) return resolve([]);
        const printers = stdout
          .split("\n")
          .filter((x) => x)
          .map((name) => ({
            printer_id: name,
            display_name: name,
            agent_id: AGENT_ID,
          }));
        resolve(printers);
      });
    });
  }
}

// --- COMUNICAÇÃO COM BACKEND ---
async function registerPrinters() {
  const printers = await listPrinters();
  if (!printers.length) return;
  try {
    await axios.post(`${BACKEND_URL}/api/agents/register`, {
      agent_id: AGENT_ID,
      token: AGENT_TOKEN,
      printers,
    });
    console.log(`[${AGENT_ID}] Impressoras registadas no backend`);
  } catch (err) {
    console.error("Erro a registar impressoras:", err.message);
  }
}

// regista periodicamente (ex: a cada 60s)
setInterval(registerPrinters, 60000);
registerPrinters();
