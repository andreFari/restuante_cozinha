import os from "os";
import { randomUUID } from "crypto";
import { withClient } from "../src/db.js";

const AGENT_ID = os.hostname();
const agentSockets = new Map();
const dispatchingAgents = new Set();
const ONLINE_WINDOW_MS = 90 * 1000;

function boolOr(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === "true" || value === 1 || value === "1";
}

function asText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function toJsonArray(value, fallback = ["fatura", "fatura_recibo", "consulta_conta"]) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter(Boolean).map(String);
    } catch {
      return value.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }
  return fallback;
}

async function ensurePrinterSchema(client) {
  await client.query(`create table if not exists public.restaurant_printer_agents (
    agent_id text primary key,
    host_name text null,
    platform text null,
    version text null,
    last_seen timestamptz not null default now(),
    metadata_json jsonb not null default '{}'::jsonb
  )`);

  await client.query(`create table if not exists public.restaurant_printers (
    agent_id text not null references public.restaurant_printer_agents(agent_id) on delete cascade,
    printer_id text not null,
    system_name text not null,
    display_name text not null,
    admin_name text null,
    driver text null,
    shared boolean not null default false,
    offline boolean not null default false,
    active boolean not null default false,
    show_on_checkout boolean not null default false,
    is_default boolean not null default false,
    default_document_type text not null default 'fatura',
    supported_document_types jsonb not null default '["fatura", "fatura_recibo", "consulta_conta"]'::jsonb,
    last_seen timestamptz not null default now(),
    metadata_json jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (agent_id, printer_id)
  )`);

  await client.query(`create table if not exists public.restaurant_print_jobs (
    id text primary key,
    agent_id text not null,
    printer_id text not null,
    printer_name text null,
    document_type text not null default 'fatura',
    title text null,
    pdf_url text not null,
    source_type text null,
    source_id text null,
    requested_by_user_id text null,
    terminal_id text null,
    status text not null default 'queued',
    error_message text null,
    attempts int not null default 0,
    payload_json jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    sent_at timestamptz null,
    printed_at timestamptz null,
    failed_at timestamptz null,
    constraint restaurant_print_jobs_status_check check (status in ('queued','sent','printing','printed','failed','cancelled'))
  )`);

  await client.query(`create index if not exists idx_restaurant_print_jobs_agent_status on public.restaurant_print_jobs(agent_id, status, created_at)`);
  await client.query(`create index if not exists idx_restaurant_print_jobs_printer_status on public.restaurant_print_jobs(agent_id, printer_id, status, created_at)`);
}

function mapPrinter(row) {
  if (!row) return null;
  const lastSeen = row.last_seen ? new Date(row.last_seen) : null;
  const agentLastSeen = row.agent_last_seen ? new Date(row.agent_last_seen) : null;
  const online = agentLastSeen ? Date.now() - agentLastSeen.getTime() <= ONLINE_WINDOW_MS : false;
  const ready = Boolean(row.active && row.show_on_checkout && online && !row.offline);
  return {
    id: row.printer_id,
    printer_id: row.printer_id,
    name: row.admin_name || row.display_name || row.system_name || row.printer_id,
    printer_name: row.admin_name || row.display_name || row.system_name || row.printer_id,
    system_name: row.system_name || row.printer_id,
    display_name: row.display_name || row.system_name || row.printer_id,
    admin_name: row.admin_name || "",
    driver: row.driver || "",
    shared: row.shared === true,
    offline: row.offline === true,
    active: row.active === true,
    show_on_checkout: row.show_on_checkout === true,
    is_default: row.is_default === true,
    default_document_type: row.default_document_type || "fatura",
    supported_document_types: toJsonArray(row.supported_document_types),
    agent_id: row.agent_id,
    agent_name: row.host_name || row.agent_id,
    host_name: row.host_name || row.agent_id,
    platform: row.platform || "",
    online,
    ready,
    lastSeen: lastSeen?.toISOString?.() || null,
    last_seen: lastSeen?.toISOString?.() || null,
    agent_last_seen: agentLastSeen?.toISOString?.() || null,
  };
}

function mapPrintJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    agent_id: row.agent_id,
    printer_id: row.printer_id,
    printer_name: row.printer_name || "",
    document_type: row.document_type || "fatura",
    title: row.title || "",
    pdf_url: row.pdf_url || "",
    source_type: row.source_type || "",
    source_id: row.source_id || "",
    requested_by_user_id: row.requested_by_user_id || "",
    terminal_id: row.terminal_id || "",
    status: row.status,
    error_message: row.error_message || "",
    attempts: Number(row.attempts || 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
    sent_at: row.sent_at,
    printed_at: row.printed_at,
    failed_at: row.failed_at,
  };
}

async function registerAgent({ agent_id, printers = [], host_name = "", platform = "", version = "", metadata = {} }) {
  const cleanAgentId = asText(agent_id || AGENT_ID);
  const cleanPrinters = Array.isArray(printers) ? printers : [];

  const result = await withClient(async (client) => {
    await ensurePrinterSchema(client);
    await client.query(
      `insert into public.restaurant_printer_agents (agent_id, host_name, platform, version, last_seen, metadata_json)
       values ($1, $2, $3, $4, now(), $5::jsonb)
       on conflict (agent_id) do update set
         host_name = excluded.host_name,
         platform = excluded.platform,
         version = excluded.version,
         last_seen = now(),
         metadata_json = excluded.metadata_json`,
      [cleanAgentId, asText(host_name || cleanAgentId), asText(platform), asText(version), JSON.stringify(metadata || {})]
    );

    for (const rawPrinter of cleanPrinters) {
      const printerId = asText(rawPrinter?.printer_id || rawPrinter?.id || rawPrinter?.name || rawPrinter?.display_name);
      if (!printerId) continue;
      const displayName = asText(rawPrinter?.display_name || rawPrinter?.name || printerId, printerId);
      await client.query(
        `insert into public.restaurant_printers (
          agent_id, printer_id, system_name, display_name, driver, shared, offline, last_seen, metadata_json
        ) values ($1, $2, $3, $4, $5, $6, $7, now(), $8::jsonb)
        on conflict (agent_id, printer_id) do update set
          system_name = excluded.system_name,
          display_name = excluded.display_name,
          driver = excluded.driver,
          shared = excluded.shared,
          offline = excluded.offline,
          last_seen = now(),
          updated_at = now(),
          metadata_json = excluded.metadata_json`,
        [
          cleanAgentId,
          printerId,
          asText(rawPrinter?.system_name || rawPrinter?.name || printerId, printerId),
          displayName,
          asText(rawPrinter?.driver || rawPrinter?.DriverName),
          boolOr(rawPrinter?.shared, false),
          boolOr(rawPrinter?.offline ?? rawPrinter?.WorkOffline, false),
          JSON.stringify(rawPrinter || {}),
        ]
      );
    }

    const rows = await client.query(
      `select p.*, a.host_name, a.platform, a.last_seen as agent_last_seen
         from public.restaurant_printers p
         join public.restaurant_printer_agents a on a.agent_id = p.agent_id
        where p.agent_id = $1
        order by coalesce(nullif(p.admin_name, ''), p.display_name, p.printer_id)`,
      [cleanAgentId]
    );
    return rows.rows.map(mapPrinter);
  });

  scheduleDispatchQueuedJobs(cleanAgentId);
  return { ok: true, agent_id: cleanAgentId, printers_count: cleanPrinters.length, printers: result };
}

async function updateAgentHeartbeat(agent_id) {
  const cleanAgentId = asText(agent_id);
  if (!cleanAgentId) return null;
  return withClient(async (client) => {
    await ensurePrinterSchema(client);
    await client.query(`update public.restaurant_printer_agents set last_seen = now() where agent_id = $1`, [cleanAgentId]);
    return true;
  });
}

async function listRegisteredPrinters({ admin = false } = {}) {
  return withClient(async (client) => {
    await ensurePrinterSchema(client);
    const where = admin
      ? "true"
      : "p.active = true and p.show_on_checkout = true and p.offline = false and a.last_seen >= now() - interval '90 seconds'";
    const rows = await client.query(
      `select p.*, a.host_name, a.platform, a.last_seen as agent_last_seen
         from public.restaurant_printers p
         join public.restaurant_printer_agents a on a.agent_id = p.agent_id
        where ${where}
        order by p.is_default desc, coalesce(nullif(p.admin_name, ''), p.display_name, p.printer_id)`,
    );
    return rows.rows.map(mapPrinter);
  });
}

async function listAdminPrinters() {
  const printers = await listRegisteredPrinters({ admin: true });
  return { printers };
}

async function updatePrinterConfig({
  agent_id,
  printer_id,
  admin_name,
  active,
  show_on_checkout,
  is_default,
  default_document_type,
  supported_document_types,
}) {
  const cleanAgentId = asText(agent_id);
  const cleanPrinterId = asText(printer_id);
  if (!cleanAgentId || !cleanPrinterId) {
    const error = new Error("agent_id e printer_id são obrigatórios.");
    error.status = 400;
    throw error;
  }

  const supportedTypes = toJsonArray(supported_document_types);
  const defaultType = asText(default_document_type || supportedTypes[0] || "fatura", "fatura");

  const printer = await withClient(async (client) => {
    await ensurePrinterSchema(client);
    if (is_default === true) {
      await client.query(`update public.restaurant_printers set is_default = false where not (agent_id = $1 and printer_id = $2)`, [cleanAgentId, cleanPrinterId]);
    }

    const result = await client.query(
      `update public.restaurant_printers
          set admin_name = $3,
              active = $4,
              show_on_checkout = $5,
              is_default = $6,
              default_document_type = $7,
              supported_document_types = $8::jsonb,
              updated_at = now()
        where agent_id = $1 and printer_id = $2
        returning *`,
      [
        cleanAgentId,
        cleanPrinterId,
        asText(admin_name) || null,
        boolOr(active, false),
        boolOr(show_on_checkout, false),
        boolOr(is_default, false),
        defaultType,
        JSON.stringify(supportedTypes),
      ]
    );
    if (!result.rows[0]) {
      const error = new Error("Impressora não encontrada. Liga o agent desse computador e atualiza a lista.");
      error.status = 404;
      throw error;
    }

    const enriched = await client.query(
      `select p.*, a.host_name, a.platform, a.last_seen as agent_last_seen
         from public.restaurant_printers p
         join public.restaurant_printer_agents a on a.agent_id = p.agent_id
        where p.agent_id = $1 and p.printer_id = $2
        limit 1`,
      [cleanAgentId, cleanPrinterId]
    );
    return mapPrinter(enriched.rows[0]);
  });

  return { ok: true, printer };
}

async function createPrintJob({
  agent_id,
  printer_id,
  printer_name = "",
  pdfUrl,
  document_type = "fatura",
  title = "Fatura",
  source_type = "invoice",
  source_id = "",
  requested_by_user_id = "",
  terminal_id = "",
  payload = {},
}) {
  const cleanAgentId = asText(agent_id);
  const cleanPrinterId = asText(printer_id);
  const cleanPdfUrl = asText(pdfUrl);
  if (!cleanAgentId || !cleanPrinterId) {
    return { requested: false, queued: false, reason: "printer_not_selected" };
  }
  if (!cleanPdfUrl.startsWith("http")) {
    return { requested: true, queued: false, reason: "missing_absolute_invoice_url", printer_agent_id: cleanAgentId, printer_id: cleanPrinterId, printer_name };
  }

  const jobId = randomUUID();
  const insertedJob = await withClient(async (client) => {
    await ensurePrinterSchema(client);
    const printer = await client.query(
      `select p.*, a.host_name, a.platform, a.last_seen as agent_last_seen
         from public.restaurant_printers p
         join public.restaurant_printer_agents a on a.agent_id = p.agent_id
        where p.agent_id = $1 and p.printer_id = $2
        limit 1`,
      [cleanAgentId, cleanPrinterId]
    );
    const selected = mapPrinter(printer.rows[0]);
    if (!selected) {
      return { job: null, reason: "printer_not_registered" };
    }
    if (!selected.active || !selected.show_on_checkout) {
      return { job: null, reason: "printer_inactive" };
    }

    const result = await client.query(
      `insert into public.restaurant_print_jobs (
        id, agent_id, printer_id, printer_name, document_type, title, pdf_url,
        source_type, source_id, requested_by_user_id, terminal_id, status, payload_json
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued',$12::jsonb)
      returning *`,
      [
        jobId,
        cleanAgentId,
        cleanPrinterId,
        asText(printer_name || selected.name || selected.display_name || cleanPrinterId),
        asText(document_type || selected.default_document_type || "fatura", "fatura"),
        asText(title || "Fatura", "Fatura"),
        cleanPdfUrl,
        asText(source_type || "invoice", "invoice"),
        asText(source_id),
        asText(requested_by_user_id) || null,
        asText(terminal_id) || null,
        JSON.stringify(payload || {}),
      ]
    );
    return { job: mapPrintJob(result.rows[0]), reason: null };
  });

  if (!insertedJob.job) {
    return { requested: true, queued: false, reason: insertedJob.reason, printer_agent_id: cleanAgentId, printer_id: cleanPrinterId, printer_name };
  }

  const dispatched = await dispatchPrintJob(insertedJob.job.id);
  return {
    requested: true,
    queued: insertedJob.job.status === "queued",
    reason: dispatched.dispatched ? null : dispatched.reason,
    job_id: insertedJob.job.id,
    printer_agent_id: cleanAgentId,
    printer_id: cleanPrinterId,
    printer_name,
  };
}

async function getPrintJob(jobId) {
  return withClient(async (client) => {
    await ensurePrinterSchema(client);
    const result = await client.query(`select * from public.restaurant_print_jobs where id = $1 limit 1`, [jobId]);
    return mapPrintJob(result.rows[0]);
  });
}

async function updatePrintJobStatus(jobId, status, { error_message = "" } = {}) {
  const dateColumn = status === "printed" ? "printed_at" : status === "failed" ? "failed_at" : null;
  return withClient(async (client) => {
    await ensurePrinterSchema(client);
    const result = await client.query(
      `update public.restaurant_print_jobs
          set status = $2,
              error_message = nullif($3, ''),
              updated_at = now(),
              ${dateColumn ? `${dateColumn} = now(),` : ""}
              attempts = case when $2 in ('sent','printing') then attempts + 1 else attempts end
        where id = $1
        returning *`,
      [jobId, status, asText(error_message)]
    );
    return mapPrintJob(result.rows[0]);
  });
}

async function dispatchPrintJob(jobId) {
  const job = await getPrintJob(jobId);
  if (!job || !["queued", "failed"].includes(job.status)) {
    return { dispatched: false, reason: "job_not_dispatchable" };
  }

  const socket = getAgentSocket(job.agent_id);
  if (!socket) {
    return { dispatched: false, reason: "agent_offline" };
  }

  await updatePrintJobStatus(job.id, "sent");
  socket.emit("print_job", {
    job_id: job.id,
    printer_id: job.printer_id,
    printer_name: job.printer_name,
    document_type: job.document_type,
    pdfUrl: job.pdf_url,
    pdf_url: job.pdf_url,
    title: job.title || job.printer_name || "Fatura",
  });
  return { dispatched: true, reason: null };
}

async function dispatchQueuedJobsForAgent(agent_id) {
  const cleanAgentId = asText(agent_id);
  if (!cleanAgentId || dispatchingAgents.has(cleanAgentId)) return;
  dispatchingAgents.add(cleanAgentId);
  try {
    const jobs = await withClient(async (client) => {
      await ensurePrinterSchema(client);
      const result = await client.query(
        `select * from public.restaurant_print_jobs
          where agent_id = $1 and status = 'queued'
          order by created_at asc
          limit 20`,
        [cleanAgentId]
      );
      return result.rows.map(mapPrintJob);
    });
    for (const job of jobs) {
      await dispatchPrintJob(job.id);
    }
  } finally {
    dispatchingAgents.delete(cleanAgentId);
  }
}

function scheduleDispatchQueuedJobs(agent_id) {
  setTimeout(() => {
    dispatchQueuedJobsForAgent(agent_id).catch((error) => console.error("Erro a enviar jobs pendentes:", error.message));
  }, 250);
}

function bindAgentSocket(agent_id, socket) {
  agentSockets.set(agent_id, socket);
  updateAgentHeartbeat(agent_id).catch(() => null);
}

function unbindSocket(socket) {
  for (const [agent_id, agentSocket] of agentSockets.entries()) {
    if (agentSocket === socket) {
      agentSockets.delete(agent_id);
    }
  }
}

function getAgentSocket(agent_id) {
  return agentSockets.get(agent_id) || null;
}

function initPrintingSockets(io, agentToken) {
  io.on("connection", (socket) => {
    socket.on("register_agent", async ({ agent_id, token, printers = [], host_name = "", platform = "", version = "" } = {}) => {
      if (token !== agentToken) {
        socket.disconnect(true);
        return;
      }
      const cleanAgentId = asText(agent_id || AGENT_ID);
      bindAgentSocket(cleanAgentId, socket);
      try {
        await registerAgent({ agent_id: cleanAgentId, printers, host_name, platform, version });
        socket.emit("agent_registered", { ok: true, agent_id: cleanAgentId });
        scheduleDispatchQueuedJobs(cleanAgentId);
        console.log(`✅ Agent ${cleanAgentId} autenticado com ${printers.length} impressoras`);
      } catch (error) {
        socket.emit("agent_registered", { ok: false, error: error.message });
      }
    });

    socket.on("agent_heartbeat", ({ agent_id } = {}) => {
      const cleanAgentId = asText(agent_id);
      if (cleanAgentId) updateAgentHeartbeat(cleanAgentId).catch(() => null);
    });

    socket.on("print_job_result", async ({ job_id, status, error_message } = {}) => {
      const cleanStatus = ["printing", "printed", "failed"].includes(status) ? status : "failed";
      if (!job_id) return;
      try {
        await updatePrintJobStatus(job_id, cleanStatus, { error_message });
      } catch (error) {
        console.error("Erro a atualizar job de impressão:", error.message);
      }
    });

    socket.on("disconnect", () => {
      unbindSocket(socket);
    });
  });
}

setInterval(() => {
  const agentIds = Array.from(agentSockets.keys());
  for (const agentId of agentIds) {
    updateAgentHeartbeat(agentId).catch(() => null);
  }
}, 30000);

export const printersService = {
  AGENT_ID,
  ensurePrinterSchema,
  registerAgent,
  listRegisteredPrinters,
  listAdminPrinters,
  updatePrinterConfig,
  createPrintJob,
  dispatchPrintJob,
  dispatchQueuedJobsForAgent,
  getAgentSocket,
  initPrintingSockets,
};
