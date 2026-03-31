import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { Resend } from 'resend';
import { query, withClient, withTransaction } from '../src/db.js';
const ACTIVE_DB_SESSION_STATES = ['rascunho', 'enviado', 'em_preparo', 'parcialmente_pronto', 'pronto', 'entregue'];
const MENU_PROFILE_DEFS = [
  { id: 'sala', name: 'Restaurante interior', description: 'Menu servido dentro do restaurante.', local_nome: 'restaurante' },
  { id: 'esplanada', name: 'Fora do restaurante', description: 'Menu de exterior / esplanada.', local_nome: 'esplanada' },
  { id: 'takeaway', name: 'Takeaway', description: 'Menu para levar.', local_nome: 'takeaway' },
  { id: 'bar', name: 'Bar', description: 'Menu de bar, bebidas e snacks.', local_nome: 'bar' },
];
const DAY_SET = [0, 1, 2, 3, 4, 5, 6];
const KITCHEN_STATUSES = ['new', 'in_progress', 'ready', 'delivered'];
const WIFI_SECURITY_SET = new Set(['WPA', 'WEP', 'nopass']);

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const PUBLIC_INVOICES_DIR = path.join(process.cwd(), 'public', 'invoices');
fs.mkdirSync(PUBLIC_INVOICES_DIR, { recursive: true });

const HOT_CACHE = new Map();
const HOT_CACHE_TTLS = {
  menuItems: 4000,
  categories: 5000,
  tables: 1500,
  kitchen: 1500,
  operatorContext: 1500,
};
let menuAvailabilitySchemaReady = false;

function cacheKey(prefix, extra = '') {
  return extra ? `${prefix}:${extra}` : prefix;
}

async function readCached(prefix, extra, ttl, loader) {
  const key = cacheKey(prefix, extra);
  const hit = HOT_CACHE.get(key);
  const now = Date.now();
  if (hit && hit.expires_at > now) return hit.value;
  const value = await loader();
  HOT_CACHE.set(key, { value, expires_at: now + ttl });
  return value;
}

function invalidateCache(...prefixes) {
  if (!prefixes.length) { HOT_CACHE.clear(); return; }
  for (const key of [...HOT_CACHE.keys()]) {
    if (prefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}:`))) {
      HOT_CACHE.delete(key);
    }
  }
}


function digitsOnly(value) {
  return String(value || '').replace(/\D+/g, '');
}

function normalizePaymentType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'multibanco') return 'cartao';
  if (raw === 'cartao') return 'cartao';
  if (raw === 'mbway') return 'mbway';
  if (raw === 'dinheiro') return 'dinheiro';
  if (raw === 'transferencia') return 'transferencia';
  return 'outro';
}

function uiPaymentType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'cartao') return 'multibanco';
  return raw;
}

function buildInvoiceNumber(createdAt, index) {
  const date = new Date(createdAt || Date.now());
  const y = String(date.getFullYear());
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `FT-${y}${m}${d}-${String(index).padStart(4, '0')}`;
}

function buildInvoiceHtml({ invoiceNumber, createdAt, customerName, customerNif, customerEmail, paymentType, amountReceived, changeAmount, tableName, items, totalSemIva, totalIva, total }) {
  const rows = (items || []).map((item) => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #e2e8f0;">${String(item.name || '')}</td>
        <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:center;">${Number(item.quantity || 0)}</td>
        <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;">${parseMoney(item.unit_price).toFixed(2)} €</td>
        <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;">${(parseMoney(item.unit_price) * Number(item.quantity || 0)).toFixed(2)} €</td>
      </tr>`).join('');

  return `<!doctype html>
<html lang="pt"><head><meta charset="utf-8"><title>${invoiceNumber}</title></head>
<body style="font-family:Arial,sans-serif;background:#f8fafc;color:#0f172a;padding:24px;">
  <div style="max-width:900px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:18px;padding:24px;">
    <div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;">
      <div><div style="font-size:12px;color:#64748b;letter-spacing:.08em;text-transform:uppercase;">Fatura local</div><h1 style="margin:6px 0 0 0;">${invoiceNumber}</h1></div>
      <div style="text-align:right;font-size:14px;color:#475569;">
        <div>Data: ${new Date(createdAt).toLocaleString('pt-PT')}</div>
        <div>Mesa/slot: ${tableName || '—'}</div>
        <div>Pagamento: ${uiPaymentType(paymentType)}</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:20px;">
      <div style="padding:16px;border:1px solid #e2e8f0;border-radius:14px;"><strong>Cliente</strong><div style="margin-top:8px;color:#475569;">${customerName || 'Consumidor final'}</div><div style="color:#475569;">NIF: ${customerNif || '—'}</div><div style="color:#475569;">Email: ${customerEmail || '—'}</div></div>
      <div style="padding:16px;border:1px solid #e2e8f0;border-radius:14px;"><strong>Pagamento</strong><div style="margin-top:8px;color:#475569;">Total: ${parseMoney(total).toFixed(2)} €</div><div style="color:#475569;">Recebido: ${parseMoney(amountReceived).toFixed(2)} €</div><div style="color:#475569;">Troco: ${parseMoney(changeAmount).toFixed(2)} €</div></div>
    </div>

    <table style="width:100%;border-collapse:collapse;margin-top:24px;font-size:14px;">
      <thead><tr><th style="text-align:left;padding:8px;border-bottom:2px solid #cbd5e1;">Artigo</th><th style="text-align:center;padding:8px;border-bottom:2px solid #cbd5e1;">Qtd</th><th style="text-align:right;padding:8px;border-bottom:2px solid #cbd5e1;">Preço</th><th style="text-align:right;padding:8px;border-bottom:2px solid #cbd5e1;">Total</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <div style="margin-top:20px;display:grid;gap:6px;justify-content:end;">
      <div style="text-align:right;color:#475569;">Subtotal: ${parseMoney(totalSemIva).toFixed(2)} €</div>
      <div style="text-align:right;color:#475569;">IVA: ${parseMoney(totalIva).toFixed(2)} €</div>
      <div style="text-align:right;font-size:20px;font-weight:800;">Total: ${parseMoney(total).toFixed(2)} €</div>
    </div>
  </div>
</body></html>`;
}

async function ensureCheckoutSchema(client) {
  await client.query(`create table if not exists public.pagamentos (
    id text primary key default fn_uuid(),
    sessao_id text not null references public.mesa_sessoes(id) on delete cascade,
    fatura_id text null references public.faturas(id) on delete set null,
    tipo_pagamento public.tipo_pagamento not null,
    valor numeric(12,2) not null check (valor >= 0),
    dinheiro_recebido numeric(12,2) null,
    troco numeric(12,2) null,
    mbway_contacto text null,
    referencia text null,
    processed_by_user_id text null references public.app_users(id),
    created_at timestamptz not null default now()
  )`);
  await client.query(`alter table public.faturas add column if not exists numero_documento text`);
  await client.query(`alter table public.faturas add column if not exists cliente_nif text`);
  await client.query(`alter table public.faturas add column if not exists cliente_nome text`);
  await client.query(`alter table public.faturas add column if not exists cliente_email text`);
  await client.query(`alter table public.faturas add column if not exists enviada_por_email_em timestamptz`);
  await client.query(`alter table public.faturas add column if not exists checkout_origem text`);
}



async function ensureQrSchema(client) {
  await client.query(`create table if not exists public.mesa_qr_tokens (
    id text primary key default fn_uuid(),
    mesa_id text not null references public.mesas(id) on delete cascade,
    token text not null unique,
    is_active boolean not null default true,
    created_by_user_id text null references public.app_users(id),
    metadata_json jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    revoked_at timestamptz null
  )`);
  await client.query(`alter table public.mesa_qr_tokens add column if not exists is_active boolean not null default true`);
  await client.query(`alter table public.mesa_qr_tokens add column if not exists created_by_user_id text null references public.app_users(id)`);
  await client.query(`alter table public.mesa_qr_tokens add column if not exists metadata_json jsonb not null default '{}'::jsonb`);
  await client.query(`alter table public.mesa_qr_tokens add column if not exists created_at timestamptz not null default now()`);
  await client.query(`alter table public.mesa_qr_tokens add column if not exists revoked_at timestamptz null`);
  await client.query(`update public.mesa_qr_tokens set is_active = true where is_active is null`);
  await client.query(`create index if not exists idx_mesa_qr_tokens_table_active on public.mesa_qr_tokens(mesa_id, is_active, created_at desc)`);
  await client.query(`create table if not exists public.restaurant_admin_settings (
    key text primary key,
    value_json jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now(),
    updated_by_user_id text null references public.app_users(id)
  )`);
}

function normalizeWifiSecurity(value) {
  const normalized = String(value || 'WPA').trim().toUpperCase();
  if (normalized === 'OPEN') return 'nopass';
  return WIFI_SECURITY_SET.has(normalized) ? normalized : 'WPA';
}

function escapeWifiValue(value) {
  return String(value || '').replace(/([\\;,:"])/g, '\\$1');
}

function buildWifiPayload({ ssid = '', password = '', security = 'WPA', hidden = false }) {
  const safeSsid = String(ssid || '').trim();
  if (!safeSsid) return '';
  const safeSecurity = normalizeWifiSecurity(security);
  const safePassword = String(password || '');
  const hiddenFlag = hidden ? 'true' : 'false';
  if (safeSecurity === 'nopass') {
    return `WIFI:T:nopass;S:${escapeWifiValue(safeSsid)};H:${hiddenFlag};;`;
  }
  return `WIFI:T:${safeSecurity};S:${escapeWifiValue(safeSsid)};P:${escapeWifiValue(safePassword)};H:${hiddenFlag};;`;
}

function buildQrImageUrl(payload, size = 320) {
  const value = String(payload || '').trim();
  if (!value) return null;
  return `https://api.qrserver.com/v1/create-qr-code/?size=${Number(size || 320)}x${Number(size || 320)}&data=${encodeURIComponent(value)}`;
}

function defaultQrAdminSettings() {
  return {
    restaurant_name: process.env.RESTAURANT_NAME || 'Restaurant OS',
    logo_url: process.env.RESTAURANT_LOGO_URL || '',
    wifi_ssid: process.env.RESTAURANT_WIFI_SSID || '',
    wifi_password: process.env.RESTAURANT_WIFI_PASSWORD || '',
    wifi_security: normalizeWifiSecurity(process.env.RESTAURANT_WIFI_SECURITY || 'WPA'),
    wifi_hidden: false,
    wifi_label: process.env.RESTAURANT_WIFI_LABEL || 'Wi-Fi clientes',
    print_note: 'Leia o QR da mesa na app do cliente para pedir. Use o QR Wi-Fi para entrar na internet.',
  };
}

async function getAdminSettingJson(client, key) {
  await ensureQrSchema(client);
  const result = await client.query(`select value_json from public.restaurant_admin_settings where key = $1 limit 1`, [key]);
  return result.rows[0]?.value_json || null;
}

async function setAdminSettingJson(client, key, value, updatedByUserId = null) {
  await ensureQrSchema(client);
  await client.query(
    `insert into public.restaurant_admin_settings (key, value_json, updated_at, updated_by_user_id)
     values ($1, $2::jsonb, now(), $3)
     on conflict (key)
     do update set value_json = excluded.value_json,
                   updated_at = now(),
                   updated_by_user_id = excluded.updated_by_user_id`,
    [key, JSON.stringify(value || {}), updatedByUserId]
  );
}

async function getQrAdminSettings(client) {
  const stored = await getAdminSettingJson(client, 'table_qr_settings');
  return {
    ...defaultQrAdminSettings(),
    ...(stored || {}),
    wifi_security: normalizeWifiSecurity(stored?.wifi_security || defaultQrAdminSettings().wifi_security),
    wifi_hidden: stored?.wifi_hidden === true,
  };
}

async function getActiveMesaQrToken(client, tableId) {
  await ensureQrSchema(client);
  const result = await client.query(
    `select id, mesa_id, token, is_active, created_at, revoked_at
       from public.mesa_qr_tokens
      where mesa_id = $1
        and is_active = true
      order by created_at desc
      limit 1`,
    [tableId]
  );
  return result.rows[0] || null;
}

async function createMesaQrToken(client, tableId, createdByUserId = null, reason = 'generated') {
  await ensureQrSchema(client);
  const token = crypto.randomBytes(18).toString('hex');
  const result = await client.query(
    `insert into public.mesa_qr_tokens (mesa_id, token, is_active, created_by_user_id, metadata_json)
     values ($1, $2, true, $3, $4::jsonb)
     returning id, mesa_id, token, is_active, created_at, revoked_at`,
    [tableId, token, createdByUserId, JSON.stringify({ reason })]
  );
  return result.rows[0];
}

async function getOrCreateMesaQrToken(client, tableId, createdByUserId = null) {
  const existing = await getActiveMesaQrToken(client, tableId);
  if (existing) return existing;
  return createMesaQrToken(client, tableId, createdByUserId, 'auto_created');
}

async function revokeActiveMesaQrTokens(client, tableId) {
  await ensureQrSchema(client);
  await client.query(
    `update public.mesa_qr_tokens
        set is_active = false,
            revoked_at = now()
      where mesa_id = $1
        and is_active = true`,
    [tableId]
  );
}
async function ensureCustomerFlowSchema(client) {
  await client.query(`create table if not exists public.customer_checkout_requests (
    id text primary key default fn_uuid(),
    sessao_id text not null references public.mesa_sessoes(id) on delete cascade,
    mesa_id text not null references public.mesas(id) on delete cascade,
    payment_method text not null,
    status text not null default 'awaiting_confirmation' check (status in ('awaiting_confirmation','paid','approved','released','cancelled','rejected')),
    amount_total numeric(12,2) not null default 0,
    customer_name text null,
    customer_phone text null,
    customer_nif text null,
    customer_email text null,
    mbway_contact text null,
    venue_type text null,
    requested_at timestamptz not null default now(),
    approved_at timestamptz null,
    approved_by_user_id text null references public.app_users(id),
    released_at timestamptz null,
    email_sent_at timestamptz null,
    metadata_json jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`);
  await client.query(`create index if not exists idx_customer_checkout_requests_status on public.customer_checkout_requests(status, requested_at desc)`);
  await client.query(`create index if not exists idx_customer_checkout_requests_session on public.customer_checkout_requests(sessao_id)`);
}

async function ensureCustomerActor(client) {
  let user = await getUserByEmail(client, 'customer@app.local');
  if (user) return user;
  const inserted = await client.query(
    `insert into app_users (name, email, password_hash, role, is_active)
     values ($1, $2, $3, $4, $5)
     returning id, name, email, role, is_active, password_hash, created_at, updated_at`,
    ['Cliente app', 'customer@app.local', 'customer-app-local', 'employee', true]
  );
  return inserted.rows[0];
}

async function getTableRowByCode(client, tableCode) {
  const raw = String(tableCode || '').trim();
  if (!raw) return null;
  await ensureQrSchema(client);
  const byToken = await client.query(
    `select m.id, m.codigo, m.nome, m.capacidade, m.ativa, l.id as local_id, l.nome as local_nome
       from public.mesa_qr_tokens qt
       join public.mesas m on m.id = qt.mesa_id
       join public.locais l on l.id = m.local_id
      where qt.token = $1
        and qt.is_active = true
      order by qt.created_at desc
      limit 1`,
    [raw]
  );
  if (byToken.rows[0]) return byToken.rows[0];
  const result = await client.query(
    `select m.id, m.codigo, m.nome, m.capacidade, m.ativa, l.id as local_id, l.nome as local_nome
       from mesas m
       join locais l on l.id = m.local_id
      where m.id = $1 or lower(m.codigo) = lower($1) or lower(m.nome) = lower($1)
      order by case when m.id = $1 then 0 when lower(m.codigo) = lower($1) then 1 else 2 end
      limit 1`,
    [raw]
  );
  return result.rows[0] || null;
}

async function getSessionRowById(client, sessionId) {
  const result = await client.query(
    `select s.id, s.mesa_id, s.local_id, s.origem, s.estado, s.criada_por_user_id,
            s.cliente_nome, s.cliente_qtd, s.nota, s.aberta_em, s.fechada_em, s.updated_at,
            m.nome as table_name, m.codigo as table_codigo
       from mesa_sessoes s
       join mesas m on m.id = s.mesa_id
      where s.id = $1
      limit 1`,
    [sessionId]
  );
  return result.rows[0] || null;
}

function menuItemsForLocal(menuItems = [], localNome = 'restaurante') {
  const today = new Date().getDay();
  const menuKey = mapLocalToMenuKey(localNome);
  return (Array.isArray(menuItems) ? menuItems : [])
    .filter((item) => item && item.active !== false)
    .filter((item) => Array.isArray(item.menu_rules?.[menuKey]) && item.menu_rules[menuKey].includes(today))
    .map((item) => {
      const matchedPrice = (Array.isArray(item.prices) ? item.prices : []).find((entry) => entry.local_nome === localNome && entry.active !== false)
        || (Array.isArray(item.prices) ? item.prices.find((entry) => entry.active !== false) : null)
        || null;
      return {
        ...item,
        display_price: parseMoney(matchedPrice?.price ?? item.price ?? 0),
        menu_key: menuKey,
      };
    });
}

async function getLatestCustomerCheckoutRequest(client, sessionId) {
  await ensureCustomerFlowSchema(client);
  const result = await client.query(
    `select ccr.*, m.nome as table_name, m.codigo as table_code
       from public.customer_checkout_requests ccr
       join public.mesas m on m.id = ccr.mesa_id
      where ccr.sessao_id = $1
      order by ccr.created_at desc
      limit 1`,
    [sessionId]
  );
  return result.rows[0] || null;
}

function mapCustomerPaymentRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    session_id: row.sessao_id,
    table_id: row.mesa_id,
    table_name: row.table_name || row.table_code || null,
    payment_method: uiPaymentType(row.payment_method),
    raw_payment_method: row.payment_method,
    status: row.status,
    amount_total: parseMoney(row.amount_total),
    customer_name: row.customer_name || '',
    customer_phone: row.customer_phone || '',
    customer_nif: row.customer_nif || '',
    customer_email: row.customer_email || '',
    mbway_contact: row.mbway_contact || '',
    venue_type: row.venue_type || '',
    requested_at: row.requested_at,
    approved_at: row.approved_at,
    released_at: row.released_at,
    email_sent_at: row.email_sent_at,
    metadata: row.metadata_json || {},
  };
}

async function releaseDraftKitchenItems(client, { session, actorUserId, terminalId = 'terminal_customer', itemNotes = new Map() }) {
  const draftRows = await client.query(
    `select pi.id, pi.pedido_id, pi.nome_snapshot as name, pi.quantidade as quantity, pi.observacao as note
       from pedido_itens pi
       join pedidos p on p.id = pi.pedido_id
      where p.sessao_id = $1
        and pi.estado = 'rascunho'
        and pi.sitio_prep_snapshot = 'cozinha'
      order by pi.created_at asc`,
    [session.id]
  );
  const selectedItems = draftRows.rows || [];
  if (!selectedItems.length) return { sent_items: 0, item_ids: [] };

  for (const item of selectedItems) {
    const note = itemNotes.get(String(item.id));
    if (note !== undefined) {
      await client.query(`update pedido_itens set observacao = $2, updated_at = now() where id = $1`, [item.id, note || null]);
    }
  }

  const itemIds = selectedItems.map((row) => row.id);
  await client.query(
    `update pedido_itens
        set estado = 'enviado'::public.item_estado,
            enviado_cozinha_em = coalesce(enviado_cozinha_em, now()),
            updated_at = now()
      where id = any($1::text[])
        and estado = 'rascunho'`,
    [itemIds]
  );

  const pedidoIds = [...new Set(selectedItems.map((row) => row.pedido_id))];
  if (pedidoIds.length) {
    await client.query(
      `update pedidos
          set estado = case when estado = 'rascunho' then 'enviado'::public.pedido_estado else estado end,
              updated_at = now()
        where id = any($1::text[])`,
      [pedidoIds]
    );
  }

  await insertAuditLog(client, {
    actor_user_id: actorUserId,
    terminal_id: terminalId,
    entity_type: 'table_session',
    entity_id: session.id,
    action_type: 'order_sent_to_kitchen',
    payload: {
      table_session_id: session.id,
      items_count: itemIds.length,
      item_ids: itemIds,
      item_names: selectedItems.map((item) => item.name),
      source: 'customer_payment_release',
    },
  });

  return { sent_items: itemIds.length, item_ids: itemIds };
}

async function sendCustomerOrderEmailIfNeeded({ customerEmail, customerName, sessionId, paymentMethod, amountTotal, tableName }) {
  if (!customerEmail || !resend) return { sent: false, reason: !customerEmail ? 'missing_email' : 'resend_not_configured' };
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'no-reply@techbridge.pt';
  const fromName = process.env.RESEND_FROM_NAME || 'Restaurant OS';
  await resend.emails.send({
    from: `${fromName} <${fromEmail}>`,
    to: [customerEmail],
    subject: `Pedido recebido · ${tableName || 'Restaurante'}`,
    html: `<div style="font-family:Arial,sans-serif;color:#0f172a"><h2>Pedido recebido</h2><p>Olá ${String(customerName || '').trim() || 'cliente'}, recebemos o teu pedido para ${tableName || 'a mesa'}.</p><p>Método de pagamento: <strong>${uiPaymentType(paymentMethod)}</strong></p><p>Total: <strong>${parseMoney(amountTotal).toFixed(2)} €</strong></p><p>Referência do pedido: <strong>${sessionId}</strong></p><p>Assim que o pagamento estiver validado, a produção arranca.</p></div>`,
  });
  return { sent: true, reason: null };
}

async function ensureMenuAvailabilitySchema(client) {
  if (menuAvailabilitySchemaReady) return;

  await client.query(`create table if not exists public.artigo_menu_disponibilidade (
    id text primary key default fn_uuid(),
    artigo_id text not null references public.artigos(id) on delete cascade,
    local_id smallint not null references public.locais(id) on delete cascade,
    dia_semana smallint not null check (dia_semana between 0 and 6),
    enabled boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (artigo_id, local_id, dia_semana)
  )`);
  await client.query(`create index if not exists idx_artigo_menu_disp_artigo_local on public.artigo_menu_disponibilidade(artigo_id, local_id)`);
  await client.query(`create index if not exists idx_artigo_menu_disp_local_dia on public.artigo_menu_disponibilidade(local_id, dia_semana)`);
  menuAvailabilitySchemaReady = true;
}

async function getAvailabilityMap(client) {
  await ensureMenuAvailabilitySchema(client);
  const result = await client.query(
    `select amd.artigo_id, l.nome as local_nome, amd.local_id, amd.dia_semana
       from public.artigo_menu_disponibilidade amd
       join public.locais l on l.id = amd.local_id
      where amd.enabled = true`,
    []
  );

  const map = new Map();
  for (const row of result.rows) {
    const articleKey = String(row.artigo_id);
    const localKey = String(row.local_nome);
    if (!map.has(articleKey)) map.set(articleKey, new Map());
    const localMap = map.get(articleKey);
    if (!localMap.has(localKey)) localMap.set(localKey, []);
    localMap.get(localKey).push(Number(row.dia_semana));
  }

  for (const localMap of map.values()) {
    for (const [localKey, days] of localMap.entries()) {
      localMap.set(localKey, [...new Set(days)].sort((a, b) => a - b));
    }
  }

  return map;
}

async function materializeDefaultAvailabilityForLocal(client, articleId, localId) {
  await ensureMenuAvailabilitySchema(client);
  const existing = await client.query(
    `select 1 from public.artigo_menu_disponibilidade where artigo_id = $1 and local_id = $2 limit 1`,
    [articleId, localId]
  );
  if (existing.rows[0]) return;

  await client.query(
    `insert into public.artigo_menu_disponibilidade (artigo_id, local_id, dia_semana, enabled)
     select $1, $2, gs.day, true
       from generate_series(0, 6) as gs(day)`,
    [articleId, localId]
  );
}


async function computeSessionTotals(client, sessionId) {
  const totalsRes = await client.query(
    `select
        coalesce(sum(pi.quantidade * pi.preco_unit_sem_iva), 0) as total_sem_iva,
        coalesce(sum(pi.quantidade * (pi.preco_unit_com_iva - pi.preco_unit_sem_iva)), 0) as total_iva,
        coalesce(sum(pi.quantidade * pi.preco_unit_com_iva), 0) as total
       from pedidos p
       join pedido_itens pi on pi.pedido_id = p.id
      where p.sessao_id = $1
        and pi.estado <> 'cancelado'`,
    [sessionId]
  );
  const items = await getSessionItems(client, sessionId);
  return {
    total_sem_iva: parseMoney(totalsRes.rows[0]?.total_sem_iva),
    total_iva: parseMoney(totalsRes.rows[0]?.total_iva),
    total: parseMoney(totalsRes.rows[0]?.total),
    items,
  };
}

async function sendInvoiceEmailIfNeeded({ customerEmail, customerName, invoiceNumber, invoiceHtml, invoiceUrl, total }) {
  if (!customerEmail) return { sent: false, reason: 'missing_email' };
  if (!resend) return { sent: false, reason: 'resend_not_configured' };

  const fromEmail = process.env.RESEND_FROM_EMAIL || 'no-reply@techbridge.pt';
  const fromName = process.env.RESEND_FROM_NAME || 'Restaurant OS';
  await resend.emails.send({
    from: `${fromName} <${fromEmail}>`,
    to: [customerEmail],
    subject: `Fatura ${invoiceNumber}`,
    html: `${invoiceHtml}${invoiceUrl ? `<p style="margin-top:18px">Também podes abrir a tua fatura aqui: <a href="${invoiceUrl}">${invoiceUrl}</a></p>` : ''}<p style="margin-top:18px;color:#475569">Total pago: ${parseMoney(total).toFixed(2)} €</p>`,
  });
  return { sent: true, reason: null };
}


function makeError(message, statusCode = 400, code = 'restaurant_error') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseMoney(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function deriveTableNumber(row) {
  const parsed = Number(String(row.codigo ?? '').replace(/\D+/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function deriveZoneFromLocal(localNome) {
  switch (String(localNome || '').toLowerCase()) {
    case 'bar':
      return 'Bar';
    case 'esplanada':
      return 'Esplanada';
    case 'takeaway':
      return 'Takeaway';
    default:
      return 'Sala';
  }
}

function mapMenuKeyToLocal(menuKey) {
  return MENU_PROFILE_DEFS.find((profile) => profile.id === menuKey)?.local_nome || 'restaurante';
}

function mapLocalToMenuKey(localNome) {
  return MENU_PROFILE_DEFS.find((profile) => profile.local_nome === localNome)?.id || 'sala';
}

function mapDbItemStatusToKitchen(status) {
  switch (status) {
    case 'enviado':
      return 'new';
    case 'em_preparo':
      return 'in_progress';
    case 'pronto':
      return 'ready';
    case 'entregue':
      return 'delivered';
    default:
      return 'new';
  }
}

function mapKitchenStatusToDb(status) {
  switch (status) {
    case 'new':
      return 'enviado';
    case 'in_progress':
      return 'em_preparo';
    case 'ready':
      return 'pronto';
    case 'delivered':
      return 'entregue';
    case 'cancelled':
      return 'cancelado';
    default:
      return null;
  }
}


function mapHistoryActionLabel(actionType, payload = {}) {
  const name = payload?.name || payload?.item_name || payload?.table_name || 'item';
  const quantity = Number(payload?.quantity || 0);
  const qtyText = quantity > 0 ? `${quantity}x ` : '';

  switch (actionType) {
    case 'table_opened':
      return `abriu a mesa`;
    case 'item_added':
      return `adicionou ${qtyText}${name}`.trim();
    case 'item_qty_changed':
      return `alterou a quantidade de ${name} para ${payload?.quantity}`;
    case 'item_removed':
      return `removeu ${qtyText}${name}`.trim();
    case 'order_sent_to_kitchen':
      return `enviou ${payload?.items_count || 0} item(ns) para a cozinha`;
    case 'kitchen_new':
      return `devolveu ${name} para novo`;
    case 'kitchen_in_progress':
      return `marcou ${name} em preparação`;
    case 'kitchen_ready':
      return `marcou ${name} como pronto`;
    case 'kitchen_delivered':
      return `marcou ${name} como entregue`;
    case 'kitchen_cancelled':
      return `cancelou ${qtyText}${name}`.trim();
    case 'service_ready':
      return `marcou ${name} como preparado`;
    case 'service_delivered':
      return `marcou ${name} como entregue`;
    case 'item_cancelled':
      return `cancelou ${qtyText}${name}`.trim();
    case 'table_closed':
      return `fechou a mesa`;
    default:
      return String(actionType || '').replaceAll('_', ' ');
  }
}

function deriveSessionUiStatus({ closedAt, items = [] }) {
  if (closedAt) return 'closed';
  if (!items.length) return 'open';

  const hasPending = items.some((item) => ['enviado', 'em_preparo'].includes(item.estado));
  const hasReady = items.some((item) => item.estado === 'pronto');
  const hasDraft = items.some((item) => item.estado === 'rascunho');

  if (hasPending) return 'sent';
  if (hasReady) return 'ready_partial';
  if (hasDraft) return 'open';
  return 'open';
}

function inferTipoFromCategory(category) {
  const normalized = String(category || '').toLowerCase();
  if (normalized.includes('bebid')) return 'bebida';
  if (normalized.includes('sobrem')) return 'sobremesa';
  if (normalized.includes('acomp')) return 'acompanhamento';
  if (normalized.includes('extra')) return 'extra';
  return 'principal';
}

function inferPrepSiteFromStation(station) {
  return String(station || '').toLowerCase() === 'bar' ? 'bar' : 'cozinha';
}

function getMenuRulesFromLocalNames(localNames = []) {
  const rules = {};
  for (const profile of MENU_PROFILE_DEFS) {
    rules[profile.id] = localNames.includes(profile.local_nome) ? [...DAY_SET] : [];
  }
  return rules;
}

async function getOrCreateTerminal(client, terminalId) {
  const existing = await client.query(
    `select id, name, current_operator_id, updated_at
       from terminals
      where id = $1`,
    [terminalId]
  );

  if (existing.rows[0]) return existing.rows[0];

  const inserted = await client.query(
    `insert into terminals (id, name)
     values ($1, $2)
     returning id, name, current_operator_id, updated_at`,
    [terminalId, terminalId]
  );

  return inserted.rows[0];
}

async function getTableRow(client, tableId) {
  const result = await client.query(
    `select m.id, m.codigo, m.nome, m.capacidade, m.ativa, l.id as local_id, l.nome as local_nome
       from mesas m
       join locais l on l.id = m.local_id
      where m.id = $1`,
    [tableId]
  );
  return result.rows[0] || null;
}

async function getActiveSessionRow(client, tableId) {
  const result = await client.query(
    `select s.id, s.mesa_id, s.local_id, s.origem, s.estado, s.criada_por_user_id,
            s.cliente_nome, s.cliente_qtd, s.nota, s.aberta_em, s.fechada_em, s.updated_at,
            m.nome as table_name, m.codigo as table_codigo
       from mesa_sessoes s
       join mesas m on m.id = s.mesa_id
      where s.mesa_id = $1
        and s.fechada_em is null
        and s.estado not in ('fechado','cancelado')
      order by s.aberta_em desc
      limit 1`,
    [tableId]
  );
  return result.rows[0] || null;
}

async function getLastSessionRow(client, tableId) {
  const result = await client.query(
    `select s.id, s.mesa_id, s.local_id, s.origem, s.estado, s.criada_por_user_id,
            s.cliente_nome, s.cliente_qtd, s.nota, s.aberta_em, s.fechada_em, s.updated_at,
            m.nome as table_name, m.codigo as table_codigo
       from mesa_sessoes s
       join mesas m on m.id = s.mesa_id
      where s.mesa_id = $1
      order by coalesce(s.fechada_em, s.aberta_em) desc
      limit 1`,
    [tableId]
  );
  return result.rows[0] || null;
}

async function getSessionItems(client, sessionId) {
  const result = await client.query(
    `select pi.id,
            pi.pedido_id,
            pi.artigo_id as menu_item_id,
            pi.nome_snapshot as name,
            pi.sitio_prep_snapshot as station,
            pi.quantidade as quantity,
            pi.preco_unit_com_iva as unit_price,
            pi.observacao as note,
            pi.estado,
            pi.enviado_cozinha_em,
            pi.pronto_em,
            pi.entregue_em,
            pi.created_at,
            pi.updated_at,
            a.prep_minutes,
            a.imagem_url,
            c.nome as category
       from pedido_itens pi
       join pedidos p on p.id = pi.pedido_id
       left join artigos a on a.id = pi.artigo_id
       left join categorias_artigos c on c.id = a.categoria_id
      where p.sessao_id = $1
      order by pi.created_at asc`,
    [sessionId]
  );

  return result.rows.map((row) => ({
    ...row,
    quantity: Number(row.quantity || 0),
    unit_price: parseMoney(row.unit_price),
    prep_minutes: Number(row.prep_minutes || 0),
  }));
}

async function ensureItemPriceForLocal(client, menuItemId, localId) {
  if (!menuItemId || !localId) return;
  const existing = await client.query(
    `select id
       from artigo_precos
      where artigo_id = $1
        and local_id = $2
        and ativo = true
      limit 1`,
    [menuItemId, localId]
  );
  if (existing.rows[0]) return;

  const fallback = await client.query(
    `select preco_sem_iva, taxa_iva
       from artigo_precos
      where artigo_id = $1
        and ativo = true
      order by case when local_id = $2 then 0 else 1 end, updated_at desc nulls last, created_at desc nulls last
      limit 1`,
    [menuItemId, localId]
  );
  const row = fallback.rows[0];
  if (!row) return;

  await client.query(
    `insert into artigo_precos (artigo_id, local_id, preco_sem_iva, taxa_iva, ativo)
     values ($1, $2, $3, $4, true)
     on conflict (artigo_id, local_id)
     do update set preco_sem_iva = excluded.preco_sem_iva,
                   taxa_iva = excluded.taxa_iva,
                   ativo = true,
                   updated_at = now()`,
    [menuItemId, localId, row.preco_sem_iva, row.taxa_iva]
  );
}

async function getLatestSessionPedidos(client, sessionId) {
  const result = await client.query(
    `select id, estado, origem, data_registo, updated_at
       from pedidos
      where sessao_id = $1
      order by data_registo desc`,
    [sessionId]
  );
  return result.rows;
}

async function getOrCreateDraftPedido(client, sessionId, operatorId) {
  const existing = await client.query(
    `select id
       from pedidos
      where sessao_id = $1
        and estado = 'rascunho'
      order by data_registo desc
      limit 1`,
    [sessionId]
  );

  if (existing.rows[0]) return existing.rows[0].id;

  const created = await client.query(
    `select criar_pedido_staff($1, $2, $3::text[]) as id`,
    [sessionId, operatorId, []]
  );
  return created.rows[0]?.id || null;
}

async function getOperators(client) {
  const result = await client.query(
    `select id, name, email, role, is_active
       from app_users
      where is_active = true
        and role <> 'admin'
        and lower(email) <> 'customer@app.local'
      order by name asc`
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    active: row.is_active,
  }));
}

async function getUserById(client, userId) {
  if (!userId) return null;
  const result = await client.query(
    `select id, name, email, role, is_active, password_hash, created_at, updated_at
       from app_users
      where id = $1
      limit 1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function getUserByEmail(client, email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  const result = await client.query(
    `select id, name, email, role, is_active, password_hash, created_at, updated_at
       from app_users
      where lower(email) = $1
      limit 1`,
    [normalized]
  );
  return result.rows[0] || null;
}


async function insertAuditLog(client, { actor_user_id = null, terminal_id = null, entity_type = 'table_session', entity_id, action_type, payload = {} }) {
  if (!entity_id || !action_type) return;
  await client.query(
    `insert into audit_log (actor_user_id, terminal_id, entity_type, entity_id, action_type, payload)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [actor_user_id, terminal_id, entity_type, entity_id, action_type, JSON.stringify(payload || {})]
  );
}

function mapAuthUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    active: row.is_active !== false,
    is_admin: row.role === 'admin',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function getMenuItemsFromDb(client) {
  await ensureMenuAvailabilitySchema(client);

  const [itemsRes, availabilityMap] = await Promise.all([
    client.query(
      `select a.id,
              a.nome as name,
              c.nome as category,
              c.sort_order as category_sort_order,
              a.sort_order,
              a.sitio_prep as station,
              a.prep_minutes,
              a.disponivel,
              a.stock_ilimitado,
              a.stock_qtd,
              a.imagem_url,
              json_agg(
                json_build_object(
                  'local_nome', l.nome,
                  'local_id', l.id,
                  'price', ap.preco_com_iva,
                  'active', ap.ativo,
                  'taxa_iva', ap.taxa_iva
                )
                order by l.id
              ) filter (where ap.id is not null) as prices
         from artigos a
         left join categorias_artigos c on c.id = a.categoria_id
         left join artigo_precos ap on ap.artigo_id = a.id
         left join locais l on l.id = ap.local_id
        group by a.id, c.nome, c.sort_order
        order by coalesce(c.sort_order, 999999), coalesce(c.nome, ''), coalesce(a.sort_order, 999999), a.nome`,
      []
    ),
    getAvailabilityMap(client),
  ]);

  return itemsRes.rows.map((row) => {
    const prices = Array.isArray(row.prices) ? row.prices.filter(Boolean) : [];
    const availabilityForArticle = availabilityMap.get(String(row.id)) || new Map();
    const menu_rules = {};

    for (const profile of MENU_PROFILE_DEFS) {
      const priceForLocal = prices.find((price) => price.local_nome === profile.local_nome && price.active !== false);
      const explicitDays = availabilityForArticle.get(profile.local_nome);
      menu_rules[profile.id] = Array.isArray(explicitDays)
        ? explicitDays
        : (priceForLocal ? [...DAY_SET] : []);
    }

    const activeLocals = MENU_PROFILE_DEFS
      .filter((profile) => Array.isArray(menu_rules[profile.id]) && menu_rules[profile.id].length > 0)
      .map((profile) => profile.local_nome);

    const restaurantPrice = prices.find((price) => price.local_nome === 'restaurante' && price.active !== false);
    const fallbackPrice = prices.find((price) => price.active !== false) || prices[0] || null;

    return {
      id: row.id,
      name: row.name,
      category: row.category || 'Sem categoria',
      station: row.station,
      flow: row.station,
      category_sort_order: Number(row.category_sort_order || 0),
      sort_order: Number(row.sort_order || 0),
      prep_minutes: Number(row.prep_minutes || 0),
      price: parseMoney(restaurantPrice?.price ?? fallbackPrice?.price ?? 0),
      image_url: row.imagem_url || null,
      imagem_url: row.imagem_url || null,
      active: row.disponivel !== false,
      stock_ilimitado: row.stock_ilimitado,
      stock_qtd: numberOrNull(row.stock_qtd),
      channels: MENU_PROFILE_DEFS.filter((profile) => activeLocals.includes(profile.local_nome)).map((profile) => profile.id),
      menu_rules,
      prices,
    };
  });
}

async function getCategoriesFromDb(client) {
  const result = await client.query(
    `select c.id,
            c.nome,
            c.sort_order,
            count(a.id)::int as items_count
       from categorias_artigos c
       left join artigos a on a.categoria_id = c.id
      group by c.id, c.nome, c.sort_order
      order by c.sort_order asc, c.nome asc`,
    []
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.nome,
    sort_order: Number(row.sort_order || 0),
    items_count: Number(row.items_count || 0),
  }));
}

async function listTablesDetailedDb(client) {
  const tablesResult = await client.query(
    `select m.id, m.codigo, m.nome, m.capacidade, m.ativa, m.estado, m.estado_pagamento,
            l.id as local_id, l.nome as local_nome
       from mesas m
       join locais l on l.id = m.local_id
      order by l.id, m.codigo`,
    []
  );

  const sessionsResult = await client.query(
    `select s.id, s.mesa_id, s.estado, s.aberta_em, s.fechada_em, s.updated_at, s.criada_por_user_id, s.nota
       from mesa_sessoes s
      where s.fechada_em is null
        and s.estado not in ('fechado','cancelado')`,
    []
  );

  const sessionMap = new Map(sessionsResult.rows.map((row) => [row.mesa_id, row]));
  const sessionIds = sessionsResult.rows.map((row) => row.id);

  const itemAggMap = new Map();
  if (sessionIds.length) {
    const itemAgg = await client.query(
      `select p.sessao_id,
              count(pi.id) as line_count,
              coalesce(sum(pi.quantidade), 0) as total_items,
              coalesce(sum(pi.quantidade * pi.preco_unit_com_iva), 0) as total,
              coalesce(sum(case when pi.sitio_prep_snapshot = 'cozinha' and pi.estado in ('enviado','em_preparo') then 1 else 0 end), 0) as pending_kitchen,
              coalesce(sum(case when pi.estado = 'pronto' then 1 else 0 end), 0) as ready_items,
              coalesce(sum(case when pi.estado = 'rascunho' then 1 else 0 end), 0) as draft_items
         from pedidos p
         left join pedido_itens pi on pi.pedido_id = p.id and pi.estado <> 'cancelado'
        where p.sessao_id = any($1::text[])
        group by p.sessao_id`,
      [sessionIds]
    );

    for (const row of itemAgg.rows) {
      itemAggMap.set(row.sessao_id, row);
    }
  }

  return tablesResult.rows
    .filter((row) => row.ativa !== false)
    .map((row) => {
      const session = sessionMap.get(row.id) || null;
      const agg = session ? itemAggMap.get(session.id) || null : null;
      const sessionStatus = session
        ? deriveSessionUiStatus({
            closedAt: session.fechada_em,
            items: [
              ...(Number(agg?.pending_kitchen || 0) ? [{ estado: 'enviado' }] : []),
              ...(Number(agg?.ready_items || 0) ? [{ estado: 'pronto' }] : []),
              ...(Number(agg?.draft_items || 0) ? [{ estado: 'rascunho' }] : []),
            ],
          })
        : null;

      return {
        id: row.id,
        restaurant_id: 'local_db',
        number: deriveTableNumber(row),
        codigo: row.codigo,
        name: row.nome || row.codigo,
        zone: deriveZoneFromLocal(row.local_nome),
        capacity: Number(row.capacidade || 0),
        active: row.ativa,
        local_id: row.local_id,
        local_nome: row.local_nome,
        estado_pagamento: row.estado_pagamento,
        session: session
          ? {
              id: session.id,
              status: sessionStatus,
              opened_at: session.aberta_em,
              updated_at: session.updated_at,
              operator_id: session.criada_por_user_id,
              note: session.nota || '',
            }
          : null,
        metrics: {
          total: parseMoney(agg?.total || 0),
          total_items: Number(agg?.total_items || 0),
          pending_kitchen: Number(agg?.pending_kitchen || 0),
        },
      };
    })
    .sort((a, b) => a.number - b.number || String(a.codigo).localeCompare(String(b.codigo)));
}

async function buildKitchenBoardDb(client) {
  const result = await client.query(
    `select pi.id,
            p.sessao_id as table_session_id,
            pi.id as order_item_id,
            pi.artigo_id as menu_item_id,
            pi.nome_snapshot as name,
            pi.sitio_prep_snapshot as station,
            pi.quantidade as quantity,
            pi.observacao as note,
            pi.estado,
            pi.enviado_cozinha_em as sent_to_kitchen_at,
            pi.updated_at,
            m.id as table_id,
            m.nome as table_name,
            m.codigo as table_codigo,
            a.prep_minutes,
            u.name as operator_name
       from pedido_itens pi
       join pedidos p on p.id = pi.pedido_id
       join mesa_sessoes s on s.id = p.sessao_id
       join mesas m on m.id = s.mesa_id
       left join artigos a on a.id = pi.artigo_id
       left join app_users u on u.id = p.quem_registou_id
      where s.fechada_em is null
        and s.estado not in ('fechado','cancelado')
        and pi.sitio_prep_snapshot = 'cozinha'
        and pi.estado in ('enviado','em_preparo','pronto','entregue')
      order by coalesce(pi.enviado_cozinha_em, pi.updated_at) asc`,
    []
  );

  const cards = result.rows.map((row) => {
    const status = mapDbItemStatusToKitchen(row.estado);
    const prepMinutes = Number(row.prep_minutes || 0);
    const sentAtMs = row.sent_to_kitchen_at ? new Date(row.sent_to_kitchen_at).getTime() : Date.now();
    const overdueByMinutes = prepMinutes > 0
      ? Math.max(0, Math.floor((Date.now() - sentAtMs) / 60000) - prepMinutes)
      : 0;

    return {
      id: row.id,
      table_session_id: row.table_session_id,
      order_item_id: row.order_item_id,
      menu_item_id: row.menu_item_id,
      name: row.name,
      station: row.station,
      quantity: Number(row.quantity || 0),
      note: row.note || '',
      status,
      created_at: row.sent_to_kitchen_at || row.updated_at,
      sent_to_kitchen_at: row.sent_to_kitchen_at,
      updated_at: row.updated_at,
      table_id: row.table_id,
      table_name: row.table_name || row.table_codigo,
      prep_minutes: prepMinutes,
      operator_name: row.operator_name || '—',
      sent_by: row.operator_name || '—',
      overdue_by_minutes: overdueByMinutes,
    };
  });

  const alertsRes = await client.query(
    `select al.id,
            al.action_type,
            al.created_at,
            coalesce(u.name, '—') as actor_name,
            al.payload
       from audit_log al
       left join app_users u on u.id = al.actor_user_id
      where al.action_type in ('kitchen_cancelled', 'order_sent_to_kitchen')
        and al.created_at >= now() - interval '8 hours'
      order by al.created_at desc
      limit 12`
  );

  const alerts = alertsRes.rows.map((row) => ({
    id: row.id,
    type: row.action_type,
    created_at: row.created_at,
    actor_name: row.actor_name,
    message:
      row.action_type === 'kitchen_cancelled'
        ? `${row.actor_name || '—'} cancelou ${row.payload?.quantity || 0}x ${row.payload?.name || 'item'}`
        : `${row.actor_name || '—'} enviou ${row.payload?.items_count || 0} item(ns) para a cozinha`,
  }));

  return {
    columns: {
      new: cards.filter((card) => card.status === 'new'),
      in_progress: cards.filter((card) => card.status === 'in_progress'),
      ready: cards.filter((card) => card.status === 'ready'),
      delivered: cards.filter((card) => card.status === 'delivered'),
      blocked: [],
    },
    totals: {
      total: cards.length,
      pending: cards.filter((card) => ['new', 'in_progress'].includes(card.status)).length,
      overdue: cards.filter((card) => card.overdue_by_minutes > 0).length,
    },
    alerts,
  };
}

export class RestaurantStore {
  async authenticateUser({ email, password }) {
    return withTransaction(async (client) => {
      const user = await getUserByEmail(client, email);
      if (!user || user.is_active === false) {
        throw makeError('Credenciais inválidas.', 401, 'invalid_credentials');
      }

      if (String(user.password_hash || '') !== String(password || '')) {
        throw makeError('Credenciais inválidas.', 401, 'invalid_credentials');
      }

      return { user: mapAuthUser(user) };
    });
  }

  async getAuthUser(userId) {
    return readCached('authUser', userId, 3000, () => withClient(async (client) => {
      const user = await getUserById(client, userId);
      return mapAuthUser(user);
    }));
  }

  async listWorkers() {
    return withTransaction(async (client) => {
      const result = await client.query(
        `select id, name, email, role, is_active, created_at, updated_at
           from app_users
          where lower(email) <> 'customer@app.local'
          order by case when role = 'admin' then 0 else 1 end, name asc`
      );

      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
        active: row.is_active,
        is_admin: row.role === 'admin',
        created_at: row.created_at,
        updated_at: row.updated_at,
      }));
    });
  }

  async createWorker({ name, email, password, role = 'employee', active = true }) {
    return withTransaction(async (client) => {
      const normalizedEmail = String(email || '').trim().toLowerCase();
      if (!normalizedEmail) throw makeError('Email obrigatório.', 400, 'email_required');
      if (!String(password || '').trim()) throw makeError('Password obrigatória.', 400, 'password_required');

      const existing = await getUserByEmail(client, normalizedEmail);
      if (existing) throw makeError('Já existe um utilizador com esse email.', 409, 'duplicate_email');

      const result = await client.query(
        `insert into app_users (name, email, password_hash, role, is_active)
         values ($1, $2, $3, $4, $5)
         returning id, name, email, role, is_active, created_at, updated_at`,
        [String(name || '').trim(), normalizedEmail, String(password), role, active !== false]
      );

      return { worker: mapAuthUser(result.rows[0]) };
    });
  }

  async updateWorker({ worker_id, name, email, password, role, active }) {
    return withTransaction(async (client) => {
      const current = await getUserById(client, worker_id);
      if (!current) throw makeError('Utilizador não encontrado.', 404, 'worker_not_found');

      const normalizedEmail = email !== undefined ? String(email || '').trim().toLowerCase() : current.email;
      if (normalizedEmail !== current.email.toLowerCase()) {
        const existing = await getUserByEmail(client, normalizedEmail);
        if (existing && existing.id !== worker_id) throw makeError('Já existe um utilizador com esse email.', 409, 'duplicate_email');
      }

      const result = await client.query(
        `update app_users
            set name = coalesce($2, name),
                email = coalesce($3, email),
                password_hash = case when $4 is null or $4 = '' then password_hash else $4 end,
                role = coalesce($5, role),
                is_active = coalesce($6, is_active),
                updated_at = now()
          where id = $1
        returning id, name, email, role, is_active, created_at, updated_at`,
        [worker_id, name !== undefined ? String(name || '').trim() : null, normalizedEmail, password ?? null, role ?? null, active !== undefined ? Boolean(active) : null]
      );

      return { worker: mapAuthUser(result.rows[0]) };
    });
  }

  async getBootstrap(terminalId = 'terminal_main') {

    const [operators, tables, menuItems, kitchen, terminalContext] = await Promise.all([
      this.listOperators(),
      this.listTables(),
      this.listMenuItems(),
      this.getKitchenBoard(),
      this.getOperatorContext(terminalId),
    ]);

    return {
      restaurant: { id: 'local_db', name: 'Restaurante Local', currency: 'EUR', timezone: 'Europe/Lisbon' },
      operators,
      terminal: terminalContext.terminal,
      menu_profiles: MENU_PROFILE_DEFS,
      tables,
      menu_items: menuItems,
      kitchen,
    };
  }

  async listOperators() {
    return readCached('operators', '', 3000, () => withClient(async (client) => getOperators(client)));
  }

  async selectOperator({ terminal_id = 'terminal_main', operator_id, pin = null }) {
    return withTransaction(async (client) => {
      const terminal = await getOrCreateTerminal(client, terminal_id);
      const operators = await getOperators(client);
      const operator = operators.find((row) => row.id === operator_id);

      if (!operator) {
        throw makeError('Operador não encontrado.', 404, 'operator_not_found');
      }

      if (pin !== null && pin !== '') {
        // O schema atual não tem PIN. Ignora-se só para testes locais sem quebrar o frontend.
      }

      const updated = await client.query(
        `update terminals
            set current_operator_id = $2,
                updated_at = now()
          where id = $1
        returning id, name, current_operator_id, updated_at`,
        [terminal.id, operator.id]
      );

      invalidateCache('operatorContext', 'operators', 'bootstrap', 'authUser');
      return {
        terminal: updated.rows[0],
        operator,
      };
    });
  }

  async getOperatorContext(terminal_id = 'terminal_main') {
    return readCached('operatorContext', terminal_id, HOT_CACHE_TTLS.operatorContext, () => withClient(async (client) => {
      const terminal = await getOrCreateTerminal(client, terminal_id);
      let operator = null;

      if (terminal.current_operator_id) {
        const operatorRes = await client.query(
          `select id, name, email, role, is_active
             from app_users
            where id = $1`,
          [terminal.current_operator_id]
        );
        operator = operatorRes.rows[0]
          ? {
              id: operatorRes.rows[0].id,
              name: operatorRes.rows[0].name,
              email: operatorRes.rows[0].email,
              role: operatorRes.rows[0].role,
              active: operatorRes.rows[0].is_active,
            }
          : null;
      }

      return { terminal, operator };
    }));
  }

  async listTables() {
    return readCached('tables', '', HOT_CACHE_TTLS.tables, () => withClient(async (client) => listTablesDetailedDb(client)));
  }

  async listTableDefinitions() {
    return withClient(async (client) => {
      await ensureQrSchema(client);
      const tables = await listTablesDetailedDb(client);
      const qrRows = await client.query(
        `select distinct on (mesa_id) mesa_id, token, created_at
           from public.mesa_qr_tokens
          where is_active = true
          order by mesa_id, created_at desc`
      );
      const qrByTable = new Map(qrRows.rows.map((row) => [String(row.mesa_id), row]));
      return tables.map((table) => ({
        ...table,
        has_active_session: Boolean(table.session),
        has_qr_token: qrByTable.has(String(table.id)),
        qr_token_created_at: qrByTable.get(String(table.id))?.created_at || null,
      }));
    });
  }

  async getTableQrAdminSettings() {
    return withClient(async (client) => getQrAdminSettings(client));
  }

  async updateTableQrAdminSettings({ restaurant_name = '', logo_url = '', wifi_ssid = '', wifi_password = '', wifi_security = 'WPA', wifi_hidden = false, wifi_label = '', print_note = '', operator_id = null }) {
    return withTransaction(async (client) => {
      const nextValue = {
        restaurant_name: String(restaurant_name || '').trim() || defaultQrAdminSettings().restaurant_name,
        logo_url: String(logo_url || '').trim(),
        wifi_ssid: String(wifi_ssid || '').trim(),
        wifi_password: String(wifi_password || '').trim(),
        wifi_security: normalizeWifiSecurity(wifi_security),
        wifi_hidden: wifi_hidden === true,
        wifi_label: String(wifi_label || '').trim() || defaultQrAdminSettings().wifi_label,
        print_note: String(print_note || '').trim() || defaultQrAdminSettings().print_note,
      };
      await setAdminSettingJson(client, 'table_qr_settings', nextValue, operator_id);
      return { settings: nextValue };
    });
  }

  async getTableQrBundle({ table_id, operator_id = null, regenerate = false }) {
    return withTransaction(async (client) => {
      await ensureQrSchema(client);
      const table = await getTableRow(client, table_id);
      if (!table) throw makeError('Mesa não encontrada.', 404, 'table_not_found');
      if (regenerate) {
        await revokeActiveMesaQrTokens(client, table_id);
      }
      const token = regenerate
        ? await createMesaQrToken(client, table_id, operator_id, 'manual_regenerate')
        : await getOrCreateMesaQrToken(client, table_id, operator_id);
      const settings = await getQrAdminSettings(client);
      const wifiPayload = buildWifiPayload({
        ssid: settings.wifi_ssid,
        password: settings.wifi_password,
        security: settings.wifi_security,
        hidden: settings.wifi_hidden,
      });
      return {
        table: {
          id: table.id,
          code: table.codigo,
          number: deriveTableNumber(table),
          name: table.nome || table.codigo,
          zone: deriveZoneFromLocal(table.local_nome),
          capacity: Number(table.capacidade || 0),
          local_nome: table.local_nome,
        },
        qr: {
          token: token.token,
          created_at: token.created_at,
          image_url: buildQrImageUrl(token.token, 360),
          text_to_encode: token.token,
        },
        wifi: {
          enabled: Boolean(settings.wifi_ssid),
          ssid: settings.wifi_ssid,
          security: settings.wifi_security,
          label: settings.wifi_label,
          payload: wifiPayload,
          image_url: wifiPayload ? buildQrImageUrl(wifiPayload, 320) : null,
        },
        print_meta: {
          restaurant_name: settings.restaurant_name,
          logo_url: settings.logo_url,
          print_note: settings.print_note,
        },
      };
    });
  }

  async buildTableQrPrintHtml({ table_id, operator_id = null, regenerate = false }) {
    const bundle = await this.getTableQrBundle({ table_id, operator_id, regenerate });
    const restaurantName = bundle.print_meta.restaurant_name || 'Restaurant OS';
    const note = bundle.print_meta.print_note || '';
    const logoHtml = bundle.print_meta.logo_url
      ? `<img src="${bundle.print_meta.logo_url}" alt="Logo" style="max-height:72px;max-width:220px;object-fit:contain;" />`
      : `<div style="font-size:30px;font-weight:900;color:#0f172a;letter-spacing:-0.03em;">${restaurantName}</div>`;
    const wifiBlock = bundle.wifi.enabled
      ? `
        <div class="qr-box">
          <div class="qr-title">${bundle.wifi.label || 'Wi-Fi clientes'}</div>
          <img class="qr-image" src="${bundle.wifi.image_url}" alt="QR Wi-Fi" />
          <div class="qr-caption"><strong>Rede:</strong> ${bundle.wifi.ssid}</div>
          <div class="tiny">Ao ler este QR, o telemóvel pode entrar automaticamente na internet.</div>
        </div>`
      : `
        <div class="qr-box muted">
          <div class="qr-title">Wi-Fi clientes</div>
          <div class="tiny">Ainda não configuraste SSID/password no admin.</div>
        </div>`;
    return `<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8" />
<title>QR mesa ${bundle.table.name}</title>
<style>
  @page { size: A4 portrait; margin: 12mm; }
  * { box-sizing:border-box; }
  body { font-family: Arial, sans-serif; color:#0f172a; margin:0; background:#f8fafc; }
  .page { width:100%; min-height:calc(297mm - 24mm); display:flex; align-items:center; justify-content:center; }
  .card { width: 178mm; min-height: 110mm; background:#fff; border:2px solid #e2e8f0; border-radius:24px; padding:18mm 16mm; display:flex; flex-direction:column; gap:14mm; box-shadow:0 10px 30px rgba(15,23,42,.08); }
  .header { display:flex; align-items:center; justify-content:space-between; gap:16px; }
  .meta { text-align:right; }
  .eyebrow { font-size:12px; text-transform:uppercase; letter-spacing:.12em; color:#64748b; font-weight:700; }
  .mesa-name { font-size:42px; line-height:1; font-weight:900; margin-top:8px; }
  .mesa-sub { font-size:18px; color:#475569; margin-top:8px; }
  .qr-grid { display:grid; grid-template-columns: 1fr 1fr; gap:12mm; align-items:stretch; }
  .qr-box { border:1px solid #cbd5e1; border-radius:20px; padding:8mm; display:flex; flex-direction:column; align-items:center; justify-content:flex-start; text-align:center; }
  .qr-box.muted { justify-content:center; }
  .qr-title { font-size:22px; font-weight:800; margin-bottom:6mm; }
  .qr-image { width:62mm; height:62mm; object-fit:contain; }
  .qr-caption { margin-top:5mm; font-size:15px; line-height:1.4; color:#334155; word-break:break-word; }
  .tiny { font-size:12px; line-height:1.4; color:#64748b; margin-top:2mm; }
  .footer { border-top:1px dashed #cbd5e1; padding-top:6mm; display:flex; justify-content:space-between; gap:8mm; align-items:flex-end; }
  .token { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:13px; color:#475569; }
  .print-btn { position:fixed; right:16px; top:16px; padding:10px 14px; border-radius:999px; border:0; background:#2563eb; color:#fff; font-weight:700; cursor:pointer; }
  @media print { .print-btn { display:none; } body { background:#fff; } .page { min-height:auto; } .card { box-shadow:none; } }
</style>
</head>
<body>
<button class="print-btn" onclick="window.print()">Imprimir / PDF</button>
<div class="page">
  <div class="card">
    <div class="header">
      <div>${logoHtml}</div>
      <div class="meta">
        <div class="eyebrow">Mesa / zona</div>
        <div class="mesa-name">${bundle.table.name}</div>
        <div class="mesa-sub">Mesa ${bundle.table.number} · ${bundle.table.zone}</div>
      </div>
    </div>
    <div class="qr-grid">
      <div class="qr-box">
        <div class="qr-title">Pedir na mesa</div>
        <img class="qr-image" src="${bundle.qr.image_url}" alt="QR mesa" />
        <div class="qr-caption">Abra a app do cliente e leia este QR para entrar diretamente na mesa.</div>
        <div class="tiny">Código interno: ${bundle.table.code}</div>
      </div>
      ${wifiBlock}
    </div>
    <div class="footer">
      <div>
        <div class="eyebrow">Instruções</div>
        <div style="font-size:15px;line-height:1.5;color:#334155;max-width:110mm;">${note}</div>
      </div>
      <div class="token">QR mesa: ${bundle.qr.token}</div>
    </div>
  </div>
</div>
<script>setTimeout(() => { window.focus(); }, 150);</script>
</body>
</html>`;
  }

  async createTable({ number, name, zone = 'Sala', capacity = 4, active = true, operator_id, terminal_id = 'terminal_main' }) {
    return withTransaction(async (client) => {
      const localNome = mapMenuKeyToLocal(String(zone || '').toLowerCase()) || (() => {
        const normalized = String(zone || '').toLowerCase();
        if (normalized.includes('bar')) return 'bar';
        if (normalized.includes('esplan')) return 'esplanada';
        if (normalized.includes('take')) return 'takeaway';
        return 'restaurante';
      })();

      const localRes = await client.query(`select id from locais where nome = $1`, [localNome]);
      if (!localRes.rows[0]) {
        throw makeError('Local inválido.', 400, 'invalid_local');
      }

      const codigo = String(number);
      const inserted = await client.query(
        `insert into mesas (codigo, nome, local_id, capacidade, ativa, nota)
         values ($1, $2, $3, $4, $5, $6)
         returning id`,
        [codigo, String(name || `Mesa ${number}`), localRes.rows[0].id, Math.max(1, Number(capacity || 4)), active !== false, `Criada por ${operator_id} no terminal ${terminal_id}`]
      );

      const table = await getTableRow(client, inserted.rows[0].id);
      const qrToken = await createMesaQrToken(client, inserted.rows[0].id, operator_id, 'table_created');
      invalidateCache('tables', 'bootstrap', 'serviceBoard');
      return {
        table: {
          id: table.id,
          restaurant_id: 'local_db',
          number: deriveTableNumber(table),
          codigo: table.codigo,
          name: table.nome || table.codigo,
          zone: deriveZoneFromLocal(table.local_nome),
          capacity: Number(table.capacidade || 0),
          active: table.ativa,
          local_id: table.local_id,
          local_nome: table.local_nome,
        },
        qr: {
          token: qrToken.token,
          created_at: qrToken.created_at,
          image_url: buildQrImageUrl(qrToken.token, 320),
        },
      };

      if (includeHistory) {
        response.history = session ? await this.getHistory(table_id, client, session.id) : [];
      }

      return response;
    });
  }

  async updateTableDefinition({ table_id, number, name, zone, capacity, active }) {
    return withTransaction(async (client) => {
      const table = await getTableRow(client, table_id);
      if (!table) throw makeError('Mesa não encontrada.', 404, 'table_not_found');

      let localId = table.local_id;
      if (zone !== undefined) {
        const normalized = String(zone || '').toLowerCase();
        const localNome = normalized.includes('bar')
          ? 'bar'
          : normalized.includes('esplan')
            ? 'esplanada'
            : normalized.includes('take')
              ? 'takeaway'
              : 'restaurante';
        const localRes = await client.query(`select id from locais where nome = $1`, [localNome]);
        if (!localRes.rows[0]) throw makeError('Local inválido.', 400, 'invalid_local');
        localId = localRes.rows[0].id;
      }

      await client.query(
        `update mesas
            set codigo = coalesce($2, codigo),
                nome = coalesce($3, nome),
                local_id = $4,
                capacidade = coalesce($5, capacidade),
                ativa = coalesce($6, ativa)
          where id = $1`,
        [
          table_id,
          number !== undefined ? String(number) : null,
          name !== undefined ? String(name || table.nome || '') : null,
          localId,
          capacity !== undefined ? Math.max(1, Number(capacity || table.capacidade || 1)) : null,
          active !== undefined ? Boolean(active) : null,
        ]
      );

      const updated = await getTableRow(client, table_id);
      return {
        table: {
          id: updated.id,
          restaurant_id: 'local_db',
          number: deriveTableNumber(updated),
          codigo: updated.codigo,
          name: updated.nome || updated.codigo,
          zone: deriveZoneFromLocal(updated.local_nome),
          capacity: Number(updated.capacidade || 0),
          active: updated.ativa,
          local_id: updated.local_id,
          local_nome: updated.local_nome,
        },
      };

      if (includeHistory) {
        response.history = session ? await this.getHistory(table_id, client, session.id) : [];
      }

      return response;
    });
  }

  async archiveTableDefinition({ table_id }) {
    return withTransaction(async (client) => {
      const activeSession = await getActiveSessionRow(client, table_id);
      if (activeSession) {
        throw makeError('Não podes ocultar uma mesa que está aberta.', 409, 'table_has_active_session');
      }

      const result = await client.query(
        `update mesas
            set ativa = false
          where id = $1
        returning id`,
        [table_id]
      );

      if (!result.rows[0]) throw makeError('Mesa não encontrada.', 404, 'table_not_found');
      invalidateCache('tables', 'bootstrap', 'serviceBoard');
      return { removed: true };
    });
  }

  async getTableDetails(table_id, options = {}) {
    const includeHistory = options?.includeHistory === true;
    return withClient(async (client) => {
      const table = await getTableRow(client, table_id);
      if (!table) throw makeError('Mesa não encontrada.', 404, 'table_not_found');

      const session = await getActiveSessionRow(client, table_id);
      const orderItems = session ? await getSessionItems(client, session.id) : [];
      const visibleOrderItems = orderItems.filter((item) => item.estado !== 'cancelado');
      const kitchenItems = visibleOrderItems.filter((item) => ['enviado', 'em_preparo', 'pronto', 'entregue'].includes(item.estado));
      const total = visibleOrderItems.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unit_price || 0), 0);

      invalidateCache('tables', 'bootstrap', 'serviceBoard');
      const response = {
        table: {
          id: table.id,
          restaurant_id: 'local_db',
          number: deriveTableNumber(table),
          codigo: table.codigo,
          name: table.nome || table.codigo,
          zone: deriveZoneFromLocal(table.local_nome),
          capacity: Number(table.capacidade || 0),
          active: table.ativa,
          local_id: table.local_id,
          local_nome: table.local_nome,
        },
        session: session
          ? {
              id: session.id,
              status: deriveSessionUiStatus({ closedAt: session.fechada_em, items: orderItems }),
              opened_at: session.aberta_em,
              updated_at: session.updated_at,
              operator_id: session.criada_por_user_id,
              note: session.nota || '',
              cliente_nome: session.cliente_nome,
              cliente_qtd: session.cliente_qtd,
              closed_at: session.fechada_em,
            }
          : null,
        order_items: visibleOrderItems.map((item) => ({
          id: item.id,
          table_session_id: session?.id || null,
          menu_item_id: item.menu_item_id,
          name: item.name,
          station: item.station,
          flow: item.station,
          category: item.category || 'Sem categoria',
          image_url: item.imagem_url || null,
          imagem_url: item.imagem_url || null,
          quantity: item.quantity,
          prep_minutes: Number(item.prep_minutes || 0),
          unit_price: item.unit_price,
          note: item.note || '',
          status: mapDbItemStatusToKitchen(item.estado === 'rascunho' ? 'enviado' : item.estado),
          raw_status: item.estado,
          created_at: item.created_at,
          updated_at: item.updated_at,
        })),
        kitchen_items: kitchenItems.map((item) => ({
          id: item.id,
          table_session_id: session?.id || null,
          order_item_id: item.id,
          menu_item_id: item.menu_item_id,
          name: item.name,
          station: item.station,
          quantity: item.quantity,
          note: item.note || '',
          status: mapDbItemStatusToKitchen(item.estado),
          created_at: item.enviado_cozinha_em || item.created_at,
          sent_to_kitchen_at: item.enviado_cozinha_em,
          updated_at: item.updated_at,
        })),
        totals: {
          total,
          total_items: visibleOrderItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
        },
      };

      if (includeHistory) {
        response.history = session ? await this.getHistory(table_id, client, session.id) : [];
      }

      return response;
    });
  }

  async getHistory(table_id, externalClient = null, forcedSessionId = null) {
    const run = async (client) => {
      const session = forcedSessionId
        ? { id: forcedSessionId }
        : (await getActiveSessionRow(client, table_id)) || (await getLastSessionRow(client, table_id));

      if (!session) return [];

      const result = await client.query(
        `select al.id,
                al.entity_type,
                al.entity_id,
                al.action_type,
                al.payload,
                al.created_at,
                coalesce(u.name, '—') as actor_name
           from audit_log al
           left join app_users u on u.id = al.actor_user_id
          where al.entity_id = $1
             or al.payload->>'table_session_id' = $1
          order by al.created_at desc
          limit 100`,
        [session.id]
      );

      return result.rows.map((row) => ({
        ...row,
        actor_name: row.actor_name || '—',
        action_label: mapHistoryActionLabel(row.action_type, row.payload || {}),
      }));
    };

    if (externalClient) return run(externalClient);
    return readCached('history', table_id || forcedSessionId || '', 1200, () => withClient(run));
  }

  async openTable({ table_id, operator_id, terminal_id = 'terminal_main', note = '' }) {
    return withTransaction(async (client) => {
      const terminal = await getOrCreateTerminal(client, terminal_id);
      if (!terminal.current_operator_id) {
        await client.query(`update terminals set current_operator_id = $2 where id = $1`, [terminal_id, operator_id]);
      }

      const result = await client.query(
        `select abrir_mesa_staff($1, $2, $3, $4, $5) as id`,
        [table_id, operator_id, null, null, note || null]
      );

      const sessionId = result.rows[0]?.id;
      const session = await getActiveSessionRow(client, table_id);
      await insertAuditLog(client, {
        actor_user_id: operator_id,
        terminal_id,
        entity_type: 'table_session',
        entity_id: sessionId,
        action_type: 'table_opened',
        payload: {
          table_session_id: sessionId,
          table_id,
          table_name: session?.table_name || null,
          note: note || '',
        },
      });
      invalidateCache('tables', 'kitchen', 'serviceBoard', 'history', 'bootstrap');
      return {
        session: {
          id: sessionId,
          restaurant_id: 'local_db',
          table_id,
          table_name: session?.table_name || null,
          status: 'open',
          operator_id,
          note: note || '',
          opened_at: session?.aberta_em || new Date().toISOString(),
          updated_at: session?.updated_at || new Date().toISOString(),
          closed_at: null,
        },
      };

      if (includeHistory) {
        response.history = session ? await this.getHistory(table_id, client, session.id) : [];
      }

      return response;
    });
  }

  async addItem({ table_id, menu_item_id, quantity = 1, operator_id, note = '', terminal_id = 'terminal_main' }) {
    return withTransaction(async (client) => {
      const session = await getActiveSessionRow(client, table_id);
      if (!session) throw makeError('A mesa não está aberta.', 409, 'table_not_open');

      const pedidoId = await getOrCreateDraftPedido(client, session.id, operator_id);
      await ensureItemPriceForLocal(client, menu_item_id, session.local_id);
      const inserted = await client.query(
        `select adicionar_item_pedido($1, $2, $3, $4) as id`,
        [pedidoId, menu_item_id, Math.max(1, Number(quantity || 1)), note || null]
      );

      const itemId = inserted.rows[0]?.id;
      const itemRes = await client.query(
        `select pi.id,
                pi.artigo_id as menu_item_id,
                pi.nome_snapshot as name,
                pi.sitio_prep_snapshot as station,
                pi.quantidade as quantity,
                pi.preco_unit_com_iva as unit_price,
                pi.observacao as note,
                pi.estado,
                pi.created_at,
                pi.updated_at
           from pedido_itens pi
          where pi.id = $1`,
        [itemId]
      );

      const item = itemRes.rows[0];
      await insertAuditLog(client, {
        actor_user_id: operator_id,
        terminal_id,
        entity_type: 'table_session',
        entity_id: session.id,
        action_type: 'item_added',
        payload: {
          table_session_id: session.id,
          item_id: item.id,
          name: item.name,
          quantity: Number(item.quantity || 0),
        },
      });
      invalidateCache('tables', 'kitchen', 'serviceBoard', 'history', 'bootstrap');
      return {
        item: {
          id: item.id,
          table_session_id: session.id,
          menu_item_id: item.menu_item_id,
          name: item.name,
          station: item.station,
          quantity: Number(item.quantity || 0),
          unit_price: parseMoney(item.unit_price),
          note: item.note || '',
          status: 'draft',
          raw_status: item.estado,
          created_at: item.created_at,
          updated_at: item.updated_at,
        },
      };

      if (includeHistory) {
        response.history = session ? await this.getHistory(table_id, client, session.id) : [];
      }

      return response;
    });
  }

  async updateItemQuantity({ table_id, order_item_id, quantity, operator_id, terminal_id = 'terminal_main' }) {
    return withTransaction(async (client) => {
      const session = await getActiveSessionRow(client, table_id);
      if (!session) throw makeError('Mesa não aberta.', 409, 'table_not_open');

      const result = await client.query(
        `update pedido_itens pi
            set quantidade = $3,
                updated_at = now()
           from pedidos p
          where pi.id = $1
            and p.id = pi.pedido_id
            and p.sessao_id = $2
            and pi.estado = 'rascunho'
        returning pi.id,
                  pi.artigo_id as menu_item_id,
                  pi.nome_snapshot as name,
                  pi.sitio_prep_snapshot as station,
                  pi.quantidade as quantity,
                  pi.preco_unit_com_iva as unit_price,
                  pi.observacao as note,
                  pi.estado,
                  pi.created_at,
                  pi.updated_at`,
        [order_item_id, session.id, Math.max(1, Number(quantity || 1))]
      );

      if (!result.rows[0]) {
        throw makeError('Só podes alterar itens em rascunho da mesa aberta.', 409, 'item_not_editable');
      }

      const item = result.rows[0];
      await insertAuditLog(client, {
        actor_user_id: operator_id,
        terminal_id,
        entity_type: 'table_session',
        entity_id: session.id,
        action_type: 'item_qty_changed',
        payload: {
          table_session_id: session.id,
          item_id: item.id,
          name: item.name,
          quantity: Number(item.quantity || 0),
        },
      });
      invalidateCache('tables', 'kitchen', 'serviceBoard', 'history', 'bootstrap');
      return {
        item: {
          id: item.id,
          table_session_id: session.id,
          menu_item_id: item.menu_item_id,
          name: item.name,
          station: item.station,
          quantity: Number(item.quantity || 0),
          unit_price: parseMoney(item.unit_price),
          note: item.note || '',
          status: 'draft',
          raw_status: item.estado,
          created_at: item.created_at,
          updated_at: item.updated_at,
        },
      };

      if (includeHistory) {
        response.history = session ? await this.getHistory(table_id, client, session.id) : [];
      }

      return response;
    });
  }

  async removeItem({ table_id, order_item_id, operator_id, terminal_id = 'terminal_main' }) {
    return withTransaction(async (client) => {
      const session = await getActiveSessionRow(client, table_id);
      if (!session) throw makeError('Mesa não aberta.', 409, 'table_not_open');

      const result = await client.query(
        `delete from pedido_itens pi
         using pedidos p
         where pi.id = $1
           and p.id = pi.pedido_id
           and p.sessao_id = $2
           and pi.estado = 'rascunho'
        returning pi.id, pi.nome_snapshot as name, pi.quantidade as quantity`,
        [order_item_id, session.id]
      );

      if (!result.rows[0]) {
        throw makeError('Só podes remover itens em rascunho da mesa aberta.', 409, 'item_not_removable');
      }

      await insertAuditLog(client, {
        actor_user_id: operator_id,
        terminal_id,
        entity_type: 'table_session',
        entity_id: session.id,
        action_type: 'item_removed',
        payload: {
          table_session_id: session.id,
          item_id: result.rows[0].id,
          name: result.rows[0].name,
          quantity: Number(result.rows[0].quantity || 0),
        },
      });

      invalidateCache('tables', 'kitchen', 'serviceBoard', 'history', 'bootstrap');
      return { removed: true };
    });
  }

  async sendTableToKitchen({ table_id, operator_id, terminal_id = 'terminal_main', items = [] }) {
    return withTransaction(async (client) => {
      const session = await getActiveSessionRow(client, table_id);
      if (!session) throw makeError('Mesa não aberta.', 409, 'table_not_open');

      const draftKitchenItems = await client.query(
        `select pi.id, pi.pedido_id, pi.nome_snapshot as name, pi.quantidade as quantity, pi.observacao as note
           from pedido_itens pi
           join pedidos p on p.id = pi.pedido_id
          where p.sessao_id = $1
            and pi.estado = 'rascunho'
            and pi.sitio_prep_snapshot = 'cozinha'
          order by pi.created_at asc`,
        [session.id]
      );

      if (!draftKitchenItems.rows.length) {
        throw makeError('Não existem itens de cozinha em rascunho para enviar.', 409, 'no_draft_kitchen_items');
      }

      const selectedItems = Array.isArray(items) && items.length
        ? draftKitchenItems.rows.filter((row) => items.some((candidate) => String(candidate?.order_item_id || candidate?.id) === String(row.id)))
        : draftKitchenItems.rows;

      if (!selectedItems.length) {
        throw makeError('Seleciona pelo menos um item para enviar.', 400, 'no_items_selected');
      }

      const noteMap = new Map((Array.isArray(items) ? items : []).map((entry) => [String(entry?.order_item_id || entry?.id), String(entry?.note || '')]));
      for (const item of selectedItems) {
        if (noteMap.has(String(item.id))) {
          await client.query(
            `update pedido_itens
                set observacao = $2,
                    updated_at = now()
              where id = $1`,
            [item.id, noteMap.get(String(item.id)) || null]
          );
        }
      }

      const itemIds = selectedItems.map((row) => row.id);
      await client.query(
        `update pedido_itens
            set estado = 'enviado'::public.item_estado,
                enviado_cozinha_em = coalesce(enviado_cozinha_em, now()),
                updated_at = now()
          where id = any($1::text[])
            and estado = 'rascunho'`,
        [itemIds]
      );

      const pedidoIds = [...new Set(selectedItems.map((row) => row.pedido_id))];
      if (pedidoIds.length) {
        await client.query(
          `update pedidos
              set estado = case when estado = 'rascunho' then 'enviado'::public.pedido_estado else estado end,
                  updated_at = now()
            where id = any($1::text[])`,
          [pedidoIds]
        );
      }

      await insertAuditLog(client, {
        actor_user_id: operator_id,
        terminal_id,
        entity_type: 'table_session',
        entity_id: session.id,
        action_type: 'order_sent_to_kitchen',
        payload: {
          table_session_id: session.id,
          items_count: itemIds.length,
          item_ids: itemIds,
          item_names: selectedItems.map((item) => item.name),
        },
      });

      invalidateCache('tables', 'kitchen', 'serviceBoard', 'history', 'bootstrap');
      return {
        session_id: session.id,
        sent_items: itemIds.length,
      };
    });
  }

  async updateOrderItemStatus({ table_id, order_item_id, status, operator_id, terminal_id = 'terminal_main' }) {
    return withTransaction(async (client) => {
      const session = await getActiveSessionRow(client, table_id);
      if (!session) throw makeError('Mesa não aberta.', 409, 'table_not_open');

      const statusMap = new Map([
        ['draft', 'rascunho'],
        ['new', 'enviado'],
        ['in_progress', 'em_preparo'],
        ['ready', 'pronto'],
        ['delivered', 'entregue'],
        ['cancelled', 'cancelado'],
      ]);
      const dbStatus = statusMap.get(String(status || '').trim());
      if (!dbStatus) throw makeError('Estado inválido para o item.', 400, 'invalid_order_item_status');

      const result = await client.query(
        `update pedido_itens pi
            set estado = $3::public.item_estado,
                pronto_em = case when $4 then coalesce(pronto_em, now()) else pronto_em end,
                entregue_em = case when $5 then coalesce(entregue_em, now()) else entregue_em end,
                updated_at = now()
           from pedidos p
          where pi.id = $1
            and p.id = pi.pedido_id
            and p.sessao_id = $2
            and (pi.estado <> 'entregue' or $3::public.item_estado = 'entregue')
        returning pi.id,
                  pi.artigo_id as menu_item_id,
                  pi.nome_snapshot as name,
                  pi.sitio_prep_snapshot as station,
                  pi.quantidade as quantity,
                  pi.observacao as note,
                  pi.estado,
                  pi.enviado_cozinha_em as sent_to_kitchen_at,
                  pi.updated_at,
                  p.sessao_id as table_session_id`,
        [order_item_id, session.id, dbStatus, dbStatus === 'pronto', dbStatus === 'entregue']
      );

      if (!result.rows[0]) throw makeError('Item não encontrado na mesa selecionada.', 404, 'order_item_not_found');
      const item = result.rows[0];
      const isKitchenItem = String(item.station || '').toLowerCase() === 'cozinha';
      let actionType = 'item_status_changed';
      if (dbStatus === 'cancelado') actionType = isKitchenItem ? 'kitchen_cancelled' : 'item_cancelled';
      else if (dbStatus === 'enviado') actionType = isKitchenItem ? 'kitchen_new' : 'item_status_changed';
      else if (dbStatus === 'em_preparo') actionType = isKitchenItem ? 'kitchen_in_progress' : 'item_status_changed';
      else if (dbStatus === 'pronto') actionType = isKitchenItem ? 'kitchen_ready' : 'service_ready';
      else if (dbStatus === 'entregue') actionType = isKitchenItem ? 'kitchen_delivered' : 'service_delivered';
      await insertAuditLog(client, {
        actor_user_id: operator_id,
        terminal_id,
        entity_type: 'table_session',
        entity_id: item.table_session_id || session.id,
        action_type: actionType,
        payload: {
          table_session_id: item.table_session_id || session.id,
          item_id: item.id,
          name: item.name,
          quantity: Number(item.quantity || 0),
          status: item.estado,
        },
      });
      invalidateCache('tables', 'kitchen', 'serviceBoard', 'history', 'bootstrap');
      return {
        item: {
          id: item.id,
          order_item_id: item.id,
          menu_item_id: item.menu_item_id,
          name: item.name,
          station: item.station,
          flow: item.station,
          quantity: Number(item.quantity || 0),
          note: item.note || '',
          status: mapDbItemStatusToKitchen(item.estado === 'rascunho' ? 'enviado' : item.estado),
          raw_status: item.estado,
          created_at: item.sent_to_kitchen_at || item.updated_at,
          sent_to_kitchen_at: item.sent_to_kitchen_at,
          updated_at: item.updated_at,
        },
      };

      if (includeHistory) {
        response.history = session ? await this.getHistory(table_id, client, session.id) : [];
      }

      return response;
    });
  }


  async getCheckoutPreview({ table_id }) {
    return withTransaction(async (client) => {
      await ensureCheckoutSchema(client);
      const session = await getActiveSessionRow(client, table_id);
      if (!session) throw makeError('Mesa não aberta.', 409, 'table_not_open');
      const totals = await computeSessionTotals(client, session.id);
      const pendingItems = totals.items.filter((item) => !['entregue', 'cancelado'].includes(item.estado));
      return {
        table_id,
        session_id: session.id,
        table_name: session.table_name || session.table_codigo || null,
        total_sem_iva: totals.total_sem_iva,
        total_iva: totals.total_iva,
        total: totals.total,
        can_close: pendingItems.length === 0,
        pending_items: pendingItems.map((item) => ({
          id: item.id,
          name: item.name,
          raw_status: item.estado,
          quantity: Number(item.quantity || 0),
        })),
        suggested_payment_types: ['dinheiro', 'mbway', 'multibanco'],
      };
    });
  }

  async processCheckout({
    table_id,
    operator_id,
    terminal_id = 'terminal_main',
    payment_type,
    amount_received = null,
    customer_nif = '',
    customer_name = '',
    customer_email = '',
    mbway_contact = '',
    send_email = false,
  }) {
    const payload = await withTransaction(async (client) => {
      await ensureCheckoutSchema(client);
      const session = await getActiveSessionRow(client, table_id);
      if (!session) throw makeError('Mesa não aberta.', 409, 'table_not_open');

      const totals = await computeSessionTotals(client, session.id);
      if (!totals.items.length) throw makeError('A mesa não tem itens para faturar.', 409, 'no_items_to_invoice');
      const pending = totals.items.filter((item) => !['entregue', 'cancelado'].includes(item.estado));
      if (pending.length) {
        throw makeError('Ainda existem itens não entregues/cancelados. Fecha a produção/serviço antes de faturar.', 409, 'pending_items_before_checkout');
      }

      const normalizedPayment = normalizePaymentType(payment_type);
      const amountReceived = parseMoney(amount_received ?? totals.total);
      const changeAmount = normalizedPayment === 'dinheiro' ? parseMoney(amountReceived - totals.total) : 0;
      if (normalizedPayment === 'dinheiro' && amountReceived < totals.total) {
        throw makeError('Valor recebido inferior ao total da conta.', 400, 'insufficient_cash');
      }

      const nifDigits = digitsOnly(customer_nif);
      if (customer_nif && nifDigits.length !== 9) {
        throw makeError('NIF inválido. Usa 9 dígitos ou deixa vazio.', 400, 'invalid_nif');
      }

      const numberRes = await client.query(`select count(*)::int + 1 as next_number from public.faturas where created_at::date = current_date`);
      const createdAt = new Date().toISOString();
      const invoiceNumber = buildInvoiceNumber(createdAt, Number(numberRes.rows[0]?.next_number || 1));
      const invoiceFileName = `${invoiceNumber.toLowerCase()}.html`;
      const invoiceFilePath = `/invoices/${invoiceFileName}`;

      const insertedFatura = await client.query(
        `insert into public.faturas (
          sessao_id, pedido_id, total_sem_iva, total_iva, total, file_path, estado, tipo_pagamento, quem_faturou_id,
          numero_documento, cliente_nif, cliente_nome, cliente_email, checkout_origem
        )
        values ($1, null, $2, $3, $4, $5, 'pago', $6::public.tipo_pagamento, $7, $8, $9, $10, $11, $12)
        returning id, created_at`,
        [
          session.id,
          totals.total_sem_iva,
          totals.total_iva,
          totals.total,
          invoiceFilePath,
          normalizedPayment,
          operator_id,
          invoiceNumber,
          nifDigits || null,
          String(customer_name || '').trim() || null,
          String(customer_email || '').trim().toLowerCase() || null,
          terminal_id,
        ]
      );
      const fatura = insertedFatura.rows[0];

      await client.query(
        `insert into public.pagamentos (
          sessao_id, fatura_id, tipo_pagamento, valor, dinheiro_recebido, troco, mbway_contacto, referencia, processed_by_user_id
        ) values ($1, $2, $3::public.tipo_pagamento, $4, $5, $6, $7, $8, $9)`,
        [
          session.id,
          fatura.id,
          normalizedPayment,
          totals.total,
          normalizedPayment === 'dinheiro' ? amountReceived : null,
          normalizedPayment === 'dinheiro' ? changeAmount : null,
          normalizedPayment === 'mbway' ? String(mbway_contact || '').trim() || null : null,
          normalizedPayment === 'mbway' ? String(mbway_contact || '').trim() || null : uiPaymentType(normalizedPayment),
          operator_id,
        ]
      );

      await client.query(
        `update public.pedidos
            set quem_faturou_id = $2,
                data_faturacao = now(),
                tipo_pagamento = $3::public.tipo_pagamento,
                estado = case when estado <> 'cancelado' then 'fechado'::public.pedido_estado else estado end,
                updated_at = now()
          where sessao_id = $1`,
        [session.id, operator_id, normalizedPayment]
      );

      await client.query(`select public.fechar_sessao($1, $2)`, [session.id, operator_id]);

      await insertAuditLog(client, {
        actor_user_id: operator_id,
        terminal_id,
        entity_type: 'table_session',
        entity_id: session.id,
        action_type: 'checkout_completed',
        payload: {
          table_session_id: session.id,
          table_id,
          table_name: session.table_name || null,
          invoice_id: fatura.id,
          invoice_number: invoiceNumber,
          payment_type: uiPaymentType(normalizedPayment),
          total: totals.total,
        },
      });

      const invoiceHtml = buildInvoiceHtml({
        invoiceNumber,
        createdAt: fatura.created_at || createdAt,
        customerName: String(customer_name || '').trim() || null,
        customerNif: nifDigits || null,
        customerEmail: String(customer_email || '').trim().toLowerCase() || null,
        paymentType: normalizedPayment,
        amountReceived: normalizedPayment === 'dinheiro' ? amountReceived : totals.total,
        changeAmount,
        tableName: session.table_name || session.table_codigo || null,
        items: totals.items,
        totalSemIva: totals.total_sem_iva,
        totalIva: totals.total_iva,
        total: totals.total,
      });

      return {
        invoice_id: fatura.id,
        invoice_number: invoiceNumber,
        invoice_file_path: invoiceFilePath,
        invoice_html: invoiceHtml,
        invoice_created_at: fatura.created_at || createdAt,
        customer_email: String(customer_email || '').trim().toLowerCase() || null,
        customer_name: String(customer_name || '').trim() || null,
        total: totals.total,
        total_sem_iva: totals.total_sem_iva,
        total_iva: totals.total_iva,
        payment_type: normalizedPayment,
        amount_received: normalizedPayment === 'dinheiro' ? amountReceived : totals.total,
        change_amount: changeAmount,
        table_name: session.table_name || session.table_codigo || null,
      };
    });

    const invoiceDiskPath = path.join(PUBLIC_INVOICES_DIR, path.basename(payload.invoice_file_path));
    fs.writeFileSync(invoiceDiskPath, payload.invoice_html, 'utf8');

    const appBaseUrl = String(process.env.APP_BASE_URL || '').replace(/\/$/, '');
    const invoiceUrl = appBaseUrl ? `${appBaseUrl}${payload.invoice_file_path}` : payload.invoice_file_path;

    let emailResult = { sent: false, reason: send_email ? 'missing_email' : 'not_requested' };
    if (send_email && payload.customer_email) {
      try {
        emailResult = await sendInvoiceEmailIfNeeded({
          customerEmail: payload.customer_email,
          customerName: payload.customer_name,
          invoiceNumber: payload.invoice_number,
          invoiceHtml: payload.invoice_html,
          invoiceUrl,
          total: payload.total,
        });
        if (emailResult.sent) {
          await withTransaction(async (client) => {
            await ensureCheckoutSchema(client);
            await client.query(`update public.faturas set enviada_por_email_em = now() where id = $1`, [payload.invoice_id]);
          });
        }
      } catch (error) {
        emailResult = { sent: false, reason: error.message || 'email_send_failed' };
      }
    }

    invalidateCache('tables', 'kitchen', 'serviceBoard', 'history', 'bootstrap');

    return {
      ok: true,
      invoice: {
        id: payload.invoice_id,
        number: payload.invoice_number,
        file_path: payload.invoice_file_path,
        url: invoiceUrl,
        total: payload.total,
        total_sem_iva: payload.total_sem_iva,
        total_iva: payload.total_iva,
        created_at: payload.invoice_created_at,
        customer_email: payload.customer_email,
      },
      payment: {
        type: uiPaymentType(payload.payment_type),
        amount_received: payload.amount_received,
        change_amount: payload.change_amount,
      },
      email: emailResult,
      message: emailResult.sent
        ? 'Pagamento registado, fatura gerada e email enviado.'
        : send_email
          ? `Pagamento registado e fatura gerada. Email não enviado: ${emailResult.reason || 'falha desconhecida'}.`
          : 'Pagamento registado e fatura gerada.',
    };
  }

  async moveTableToTakeaway({ table_id, operator_id, terminal_id = 'terminal_main', target_takeaway_table_id = null }) {
    return withTransaction(async (client) => {
      const sourceSession = await getActiveSessionRow(client, table_id);
      if (!sourceSession) throw makeError('Mesa não aberta.', 409, 'table_not_open');
      const sourceItems = await getSessionItems(client, sourceSession.id);
      if (!sourceItems.length) throw makeError('A mesa não tem itens para enviar.', 409, 'no_items_to_move');
      const blocked = sourceItems.filter((item) => item.estado !== 'rascunho');
      if (blocked.length) {
        throw makeError('Só podes enviar para takeaway itens ainda em rascunho. Se já foram enviados/preparados, finaliza primeiro.', 409, 'takeaway_only_draft_items');
      }

      let targetTable = null;
      if (target_takeaway_table_id) {
        targetTable = await getTableRow(client, target_takeaway_table_id);
        if (!targetTable || targetTable.local_nome !== 'takeaway') throw makeError('Slot takeaway inválido.', 400, 'invalid_takeaway_slot');
      } else {
        const freeRes = await client.query(
          `select m.id
             from public.mesas m
             join public.locais l on l.id = m.local_id
            where l.nome = 'takeaway'
              and m.ativa = true
              and not exists (
                select 1 from public.mesa_sessoes s
                 where s.mesa_id = m.id
                   and s.fechada_em is null
                   and s.estado not in ('fechado','cancelado')
              )
            order by m.codigo asc
            limit 1`
        );
        if (!freeRes.rows[0]) throw makeError('Não existe slot takeaway livre.', 409, 'no_free_takeaway_slot');
        targetTable = await getTableRow(client, freeRes.rows[0].id);
      }

      let targetSession = await getActiveSessionRow(client, targetTable.id);
      if (!targetSession) {
        await client.query(`select public.abrir_mesa_staff($1, $2, $3, $4, $5)`, [targetTable.id, operator_id, null, sourceSession.cliente_nome, `Transferido de ${sourceSession.table_name || sourceSession.table_codigo}`]);
        targetSession = await getActiveSessionRow(client, targetTable.id);
      }
      const targetPedidoId = await getOrCreateDraftPedido(client, targetSession.id, operator_id);

      for (const item of sourceItems) {
        await client.query(`select public.adicionar_item_pedido($1, $2, $3, $4)`, [targetPedidoId, item.menu_item_id, item.quantity, item.note || null]);
      }

      await client.query(
        `delete from public.pedido_itens pi using public.pedidos p where p.id = pi.pedido_id and p.sessao_id = $1 and pi.estado = 'rascunho'`,
        [sourceSession.id]
      );
      await client.query(`delete from public.pedidos where sessao_id = $1 and estado = 'rascunho'`, [sourceSession.id]);
      await client.query(`select public.fechar_sessao($1, $2)`, [sourceSession.id, operator_id]);

      await insertAuditLog(client, {
        actor_user_id: operator_id,
        terminal_id,
        entity_type: 'table_session',
        entity_id: sourceSession.id,
        action_type: 'sent_to_takeaway',
        payload: {
          table_session_id: sourceSession.id,
          target_table_id: targetTable.id,
          target_table_name: targetTable.nome || targetTable.codigo,
          items_count: sourceItems.length,
        },
      });
      await insertAuditLog(client, {
        actor_user_id: operator_id,
        terminal_id,
        entity_type: 'table_session',
        entity_id: targetSession.id,
        action_type: 'received_from_room',
        payload: {
          table_session_id: targetSession.id,
          source_table_id: table_id,
          source_table_name: sourceSession.table_name || sourceSession.table_codigo,
          items_count: sourceItems.length,
        },
      });

      return {
        ok: true,
        source_table_id: table_id,
        takeaway_table_id: targetTable.id,
        takeaway_table_name: targetTable.nome || targetTable.codigo,
        moved_items: sourceItems.length,
        message: `Pedido transferido para ${targetTable.nome || targetTable.codigo} com preços takeaway.`,
      };
    });
  }


  async reorderMenuItem({ menu_item_id, direction = 'up' }) {
    return withTransaction(async (client) => {
      const currentRes = await client.query(
        `select id, categoria_id, sort_order, nome
           from artigos
          where id = $1`,
        [menu_item_id]
      );
      const current = currentRes.rows[0];
      if (!current) throw makeError('Prato não encontrado.', 404, 'menu_item_not_found');

      const isUp = String(direction || 'up').toLowerCase() === 'up';
      const adjacentRes = await client.query(
        `select id, sort_order, nome
           from artigos
          where id <> $1
            and categoria_id is not distinct from $2
            and (
              ($3 = true and (sort_order < $4 or (sort_order = $4 and nome < $5)))
              or
              ($3 = false and (sort_order > $4 or (sort_order = $4 and nome > $5)))
            )
          order by
            case when $3 = true then sort_order end desc,
            case when $3 = true then nome end desc,
            case when $3 = false then sort_order end asc,
            case when $3 = false then nome end asc
          limit 1`,
        [menu_item_id, current.categoria_id, isUp, Number(current.sort_order || 0), String(current.nome || '')]
      );

      const adjacent = adjacentRes.rows[0];
      if (!adjacent) return { ok: true, moved: false };

      await client.query(`update artigos set sort_order = -999999 where id = $1`, [current.id]);
      await client.query(`update artigos set sort_order = $2, updated_at = now() where id = $1`, [adjacent.id, Number(current.sort_order || 0)]);
      await client.query(`update artigos set sort_order = $2, updated_at = now() where id = $1`, [current.id, Number(adjacent.sort_order || 0)]);

      return { ok: true, moved: true };
    });
  }

  async listLocalInvoices() {
    return withTransaction(async (client) => {
      await ensureCheckoutSchema(client);
      const result = await client.query(
        `select f.id,
                coalesce(f.numero_documento, f.id) as numero_documento,
                f.created_at,
                f.total,
                f.tipo_pagamento,
                f.file_path,
                f.cliente_nome,
                f.cliente_nif,
                f.cliente_email,
                f.enviada_por_email_em,
                coalesce(m.nome, m.codigo, '—') as mesa_nome,
                coalesce(u.name, '—') as faturado_por
           from public.faturas f
           left join public.mesa_sessoes s on s.id = f.sessao_id
           left join public.mesas m on m.id = s.mesa_id
           left join public.app_users u on u.id = f.quem_faturou_id
          order by f.created_at desc
          limit 100`
      );
      return result.rows.map((row) => ({
        id: row.id,
        number: row.numero_documento,
        created_at: row.created_at,
        total: parseMoney(row.total),
        payment_type: uiPaymentType(row.tipo_pagamento),
        file_path: row.file_path,
        customer_name: row.cliente_nome,
        customer_nif: row.cliente_nif,
        customer_email: row.cliente_email,
        emailed_at: row.enviada_por_email_em,
        table_name: row.mesa_nome,
        invoiced_by: row.faturado_por,
      }));
    });
  }

  async closeTable({ table_id, operator_id, terminal_id = 'terminal_main' }) {
    return withTransaction(async (client) => {
      const session = await getActiveSessionRow(client, table_id);
      if (!session) throw makeError('Mesa não aberta.', 409, 'table_not_open');

      try {
        await client.query(`select fechar_sessao($1, $2)`, [session.id, operator_id]);
      } catch (error) {
        const totals = await computeSessionTotals(client, session.id);
        if (totals.items.some((item) => item.estado !== 'cancelado')) throw error;
        await client.query(
          `update mesa_sessoes
              set estado = 'fechado',
                  fechada_em = now(),
                  updated_at = now()
            where id = $1`,
          [session.id]
        );
      }
      await insertAuditLog(client, {
        actor_user_id: operator_id,
        terminal_id,
        entity_type: 'table_session',
        entity_id: session.id,
        action_type: 'table_closed',
        payload: {
          table_session_id: session.id,
          table_id,
          table_name: session.table_name || session.table_codigo || null,
        },
      });
      const closed = await getLastSessionRow(client, table_id);

      invalidateCache('tables', 'kitchen', 'serviceBoard', 'history', 'bootstrap');
      return {
        session: {
          id: closed.id,
          restaurant_id: 'local_db',
          table_id,
          table_name: closed.table_name,
          status: 'closed',
          operator_id: closed.criada_por_user_id,
          note: closed.nota || '',
          opened_at: closed.aberta_em,
          updated_at: closed.updated_at,
          closed_at: closed.fechada_em,
        },
      };

      if (includeHistory) {
        response.history = session ? await this.getHistory(table_id, client, session.id) : [];
      }

      return response;
    });
  }

  async getKitchenBoard() {
    return readCached('kitchen', '', HOT_CACHE_TTLS.kitchen, () => withClient(async (client) => buildKitchenBoardDb(client)));
  }

  async updateKitchenStatus({ kitchen_item_id, status, operator_id, terminal_id = 'terminal_kitchen' }) {
    return withTransaction(async (client) => {
      if (status === 'blocked') {
        throw makeError('O schema atual não suporta o estado blocked. Usa in_progress ou altera o enum/item flow antes.', 400, 'blocked_not_supported');
      }

      if (!KITCHEN_STATUSES.includes(status)) {
        throw makeError('Estado de cozinha inválido.', 400, 'invalid_kitchen_status');
      }

      const dbStatus = mapKitchenStatusToDb(status);
      if (!dbStatus) throw makeError('Estado de cozinha inválido.', 400, 'invalid_kitchen_status');

      const result = await client.query(
        `update pedido_itens pi
            set estado = $2::public.item_estado,
                updated_at = now(),
                pronto_em = case when $3 then coalesce(pronto_em, now()) else pronto_em end,
                entregue_em = case when $4 then coalesce(entregue_em, now()) else entregue_em end
           from pedidos p
          where pi.id = $1
            and p.id = pi.pedido_id
            and pi.estado in ('enviado','em_preparo','pronto','entregue')
        returning pi.id,
                  pi.artigo_id as menu_item_id,
                  pi.nome_snapshot as name,
                  pi.sitio_prep_snapshot as station,
                  pi.quantidade as quantity,
                  pi.observacao as note,
                  pi.estado,
                  pi.enviado_cozinha_em as sent_to_kitchen_at,
                  pi.updated_at,
                  p.sessao_id as table_session_id`,
        [kitchen_item_id, dbStatus, dbStatus === 'pronto', dbStatus === 'entregue']
      );

      if (!result.rows[0]) {
        throw makeError('Item de cozinha não encontrado.', 404, 'kitchen_item_not_found');
      }

      const item = result.rows[0];
      await insertAuditLog(client, {
        actor_user_id: operator_id,
        terminal_id,
        entity_type: 'table_session',
        entity_id: item.table_session_id,
        action_type: `kitchen_${status}`,
        payload: {
          table_session_id: item.table_session_id,
          item_id: item.id,
          name: item.name,
          quantity: Number(item.quantity || 0),
        },
      });
      invalidateCache('tables', 'kitchen', 'serviceBoard', 'history', 'bootstrap');
      return {
        item: {
          id: item.id,
          order_item_id: item.id,
          menu_item_id: item.menu_item_id,
          name: item.name,
          station: item.station,
          quantity: Number(item.quantity || 0),
          note: item.note || '',
          status,
          created_at: item.sent_to_kitchen_at || item.updated_at,
          sent_to_kitchen_at: item.sent_to_kitchen_at,
          updated_at: item.updated_at,
        },
      };

      if (includeHistory) {
        response.history = session ? await this.getHistory(table_id, client, session.id) : [];
      }

      return response;
    });
  }

  async listCategories() {
    return readCached('categories', '', HOT_CACHE_TTLS.categories, () => withClient(async (client) => getCategoriesFromDb(client)));
  }

  async createCategory({ name, sort_order = 0 }) {
    return withTransaction(async (client) => {
      const value = String(name || '').trim();
      if (!value) throw makeError('Nome da categoria obrigatório.', 400, 'category_name_required');
      const result = await client.query(
        `insert into categorias_artigos (nome, sort_order)
         values ($1, $2)
         returning id, nome, sort_order`,
        [value, Math.max(0, Number(sort_order || 0))]
      );
      invalidateCache('categories', 'menuItems', 'bootstrap');
      return { category: { id: result.rows[0].id, name: result.rows[0].nome, sort_order: Number(result.rows[0].sort_order || 0) } };
    });
  }

  async updateCategory({ category_id, name, sort_order }) {
    return withTransaction(async (client) => {
      const result = await client.query(
        `update categorias_artigos
            set nome = coalesce(nullif($2, ''), nome),
                sort_order = coalesce($3, sort_order),
                updated_at = now()
          where id = $1
        returning id, nome, sort_order`,
        [category_id, name !== undefined ? String(name).trim() : null, sort_order !== undefined ? Math.max(0, Number(sort_order || 0)) : null]
      );
      if (!result.rows[0]) throw makeError('Categoria não encontrada.', 404, 'category_not_found');
      invalidateCache('categories', 'menuItems', 'bootstrap');
      return { category: { id: result.rows[0].id, name: result.rows[0].nome, sort_order: Number(result.rows[0].sort_order || 0) } };
    });
  }

  async deleteCategory({ category_id }) {
    return withTransaction(async (client) => {
      const result = await client.query(`delete from categorias_artigos where id = $1 returning id`, [category_id]);
      if (!result.rows[0]) throw makeError('Categoria não encontrada.', 404, 'category_not_found');
      invalidateCache('categories', 'menuItems', 'bootstrap');
      return { deleted: true };
    });
  }

  async listMenuProfiles() {
    return MENU_PROFILE_DEFS;
  }

  async getMenuConfig(menu_key = 'sala', day = new Date().getDay()) {
    const profile = MENU_PROFILE_DEFS.find((row) => row.id === menu_key) || null;
    const items = await this.listMenuItems();
    return {
      day: Number(day),
      menu_key,
      profile,
      items: items.map((item) => ({
        ...item,
        enabled_for_selected_day: item.active !== false && Array.isArray(item.menu_rules?.[menu_key]) && item.menu_rules[menu_key].includes(Number(day)),
      })),
      enabled_items: items.filter((item) => item.active !== false && Array.isArray(item.menu_rules?.[menu_key]) && item.menu_rules[menu_key].includes(Number(day))),
    };
  }

  async setMenuItemAvailability({ menu_key, menu_item_id, day, enabled, operator_id, terminal_id = 'terminal_main' }) {
    return withTransaction(async (client) => {
      await ensureMenuAvailabilitySchema(client);
      const localNome = mapMenuKeyToLocal(menu_key);
      const localRes = await client.query(`select id from locais where nome = $1`, [localNome]);
      if (!localRes.rows[0]) throw makeError('Menu/local inválido.', 400, 'invalid_menu_local');
      const localId = localRes.rows[0].id;
      const targetDay = Number(day);
      if (!Number.isInteger(targetDay) || targetDay < 0 || targetDay > 6) throw makeError('Dia inválido.', 400, 'invalid_day');

      await materializeDefaultAvailabilityForLocal(client, menu_item_id, localId);

      if (Boolean(enabled)) {
        await client.query(
          `insert into public.artigo_menu_disponibilidade (artigo_id, local_id, dia_semana, enabled)
           values ($1, $2, $3, true)
           on conflict (artigo_id, local_id, dia_semana)
           do update set enabled = excluded.enabled, updated_at = now()`,
          [menu_item_id, localId, targetDay]
        );
      } else {
        await client.query(
          `delete from public.artigo_menu_disponibilidade
            where artigo_id = $1 and local_id = $2 and dia_semana = $3`,
          [menu_item_id, localId, targetDay]
        );
      }

      await insertAuditLog(client, {
        actor_user_id: operator_id,
        terminal_id,
        entity_type: 'menu_item',
        entity_id: menu_item_id,
        action_type: 'menu_day_toggled',
        payload: { menu_key, local_nome: localNome, day: targetDay, enabled: Boolean(enabled) },
      });

      invalidateCache('menuItems', 'serviceBoard', 'history', 'bootstrap');
      const item = (await getMenuItemsFromDb(client)).find((row) => row.id === menu_item_id);
      return { item };
    });
  }

  async setMenuItemDays({ menu_key, menu_item_id, days = [], operator_id, terminal_id = 'terminal_main' }) {
    return withTransaction(async (client) => {
      await ensureMenuAvailabilitySchema(client);
      const localNome = mapMenuKeyToLocal(menu_key);
      const localRes = await client.query(`select id from locais where nome = $1`, [localNome]);
      if (!localRes.rows[0]) throw makeError('Menu/local inválido.', 400, 'invalid_menu_local');
      const localId = localRes.rows[0].id;
      const normalizedDays = [...new Set((Array.isArray(days) ? days : []).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0 && value <= 6))].sort((a, b) => a - b);

      await materializeDefaultAvailabilityForLocal(client, menu_item_id, localId);
      await client.query(`delete from public.artigo_menu_disponibilidade where artigo_id = $1 and local_id = $2`, [menu_item_id, localId]);
      if (normalizedDays.length) {
        await client.query(
          `insert into public.artigo_menu_disponibilidade (artigo_id, local_id, dia_semana, enabled)
           select $1, $2, x.day, true
             from unnest($3::smallint[]) as x(day)`,
          [menu_item_id, localId, normalizedDays]
        );
      }

      await insertAuditLog(client, {
        actor_user_id: operator_id,
        terminal_id,
        entity_type: 'menu_item',
        entity_id: menu_item_id,
        action_type: 'menu_days_updated',
        payload: { menu_key, local_nome: localNome, days: normalizedDays },
      });

      invalidateCache('menuItems', 'serviceBoard', 'history', 'bootstrap');
      const item = (await getMenuItemsFromDb(client)).find((row) => row.id === menu_item_id);
      return { item };
    });
  }

  async listMenuItems() {
    return readCached('menuItems', '', HOT_CACHE_TTLS.menuItems, () => withClient(async (client) => getMenuItemsFromDb(client)));
  }

  async createMenuItem({ name, category, flow, station, prep_minutes, price, channels = ['sala'], image_url = null, imagem_url = null, menu_rules = null }) {
    return withTransaction(async (client) => {
      let categoriaId = null;
      if (category) {
        const existingCategory = await client.query(`select id from categorias_artigos where nome = $1`, [String(category)]);
        if (existingCategory.rows[0]) {
          categoriaId = existingCategory.rows[0].id;
        } else {
          const createdCategory = await client.query(
            `insert into categorias_artigos (nome) values ($1) returning id`,
            [String(category)]
          );
          categoriaId = createdCategory.rows[0].id;
        }
      }

      const normalizedFlow = flow || station || 'cozinha';
      const effectiveImageUrl = image_url ?? imagem_url ?? null;
      const sortOrderRes = await client.query(
        `select coalesce(max(sort_order), 0) + 1 as next_sort
           from artigos
          where categoria_id is not distinct from $1`,
        [categoriaId]
      );
      const nextSortOrder = Number(sortOrderRes.rows[0]?.next_sort || 1);
      const artigo = await client.query(
        `insert into artigos (
           nome,
           categoria_id,
           tipo,
           sitio_prep,
           disponivel,
           prep_minutes,
           stock_ilimitado,
           quem_registou_id,
           imagem_url,
           sort_order
         )
         values ($1, $2, $3::tipo_prato, $4::sitio_preparacao, true, $5, true, null, $6, $7)
         returning id`,
        [
          String(name || 'Novo prato'),
          categoriaId,
          inferTipoFromCategory(category),
          inferPrepSiteFromStation(normalizedFlow),
          Math.max(0, Number(prep_minutes || 0)),
          effectiveImageUrl ? String(effectiveImageUrl).trim() : null,
          nextSortOrder,
        ]
      );

      const artigoId = artigo.rows[0].id;
      const derivedMenuKeys = menu_rules && typeof menu_rules === 'object'
        ? Object.entries(menu_rules).filter(([, days]) => Array.isArray(days) && days.length).map(([key]) => key)
        : [];
      const menuKeys = Array.isArray(channels) && channels.length ? channels : (derivedMenuKeys.length ? derivedMenuKeys : ['sala']);
      for (const menuKey of menuKeys) {
        const localNome = mapMenuKeyToLocal(menuKey);
        const local = await client.query(`select id from locais where nome = $1`, [localNome]);
        if (!local.rows[0]) continue;
        await client.query(
          `insert into artigo_precos (artigo_id, local_id, preco_sem_iva, taxa_iva, ativo)
           values ($1, $2, round(($3 / 1.23)::numeric, 2), 23, true)
           on conflict (artigo_id, local_id)
           do update set preco_sem_iva = excluded.preco_sem_iva,
                         taxa_iva = excluded.taxa_iva,
                         ativo = excluded.ativo,
                         updated_at = now()`,
          [artigoId, local.rows[0].id, Number(price || 0)]
        );
      }

      const items = await getMenuItemsFromDb(client);
      const item = items.find((row) => row.id === artigoId);
      invalidateCache('menuItems', 'bootstrap', 'serviceBoard');
      return { item };
    });
  }

  async updateMenuItem({ menu_item_id, name, category, flow, station, prep_minutes, price, channels, active, image_url, imagem_url, menu_rules }) {
    return withTransaction(async (client) => {
      const existing = await client.query(`select id, categoria_id from artigos where id = $1`, [menu_item_id]);
      if (!existing.rows[0]) throw makeError('Prato não encontrado.', 404, 'menu_item_not_found');

      let categoriaId = existing.rows[0].categoria_id;
      if (category !== undefined) {
        const existingCategory = await client.query(`select id from categorias_artigos where nome = $1`, [String(category)]);
        if (existingCategory.rows[0]) {
          categoriaId = existingCategory.rows[0].id;
        } else {
          const createdCategory = await client.query(
            `insert into categorias_artigos (nome) values ($1) returning id`,
            [String(category)]
          );
          categoriaId = createdCategory.rows[0].id;
        }
      }

      const normalizedFlow = flow ?? station;
      const effectiveImageUrl = image_url !== undefined ? image_url : imagem_url;
      await client.query(
        `update artigos
            set nome = coalesce($2, nome),
                categoria_id = $3,
                tipo = coalesce($4::tipo_prato, tipo),
                sitio_prep = coalesce($5::sitio_preparacao, sitio_prep),
                prep_minutes = coalesce($6, prep_minutes),
                disponivel = coalesce($7, disponivel),
                imagem_url = case when $8 = '__KEEP__' then imagem_url else nullif($8, '') end,
                updated_at = now()
          where id = $1`,
        [
          menu_item_id,
          name !== undefined ? String(name || '') : null,
          categoriaId,
          category !== undefined ? inferTipoFromCategory(category) : null,
          normalizedFlow !== undefined ? inferPrepSiteFromStation(normalizedFlow) : null,
          prep_minutes !== undefined ? Math.max(0, Number(prep_minutes || 0)) : null,
          active !== undefined ? Boolean(active) : null,
          effectiveImageUrl !== undefined ? String(effectiveImageUrl || '').trim() : '__KEEP__',
        ]
      );

      if (price !== undefined || channels !== undefined || menu_rules !== undefined) {
        const derivedMenuKeys = menu_rules && typeof menu_rules === 'object'
          ? Object.entries(menu_rules).filter(([, days]) => Array.isArray(days) && days.length).map(([key]) => key)
          : [];
        const menuKeys = Array.isArray(channels) && channels.length ? channels : (derivedMenuKeys.length ? derivedMenuKeys : MENU_PROFILE_DEFS.map((profile) => profile.id));
        for (const profile of MENU_PROFILE_DEFS) {
          const local = await client.query(`select id from locais where nome = $1`, [profile.local_nome]);
          if (!local.rows[0]) continue;
          const shouldBeActive = menuKeys.includes(profile.id);
          if (price !== undefined) {
            await client.query(
              `insert into artigo_precos (artigo_id, local_id, preco_sem_iva, taxa_iva, ativo)
               values ($1, $2, round(($3 / 1.23)::numeric, 2), 23, $4)
               on conflict (artigo_id, local_id)
               do update set preco_sem_iva = excluded.preco_sem_iva,
                             taxa_iva = excluded.taxa_iva,
                             ativo = excluded.ativo,
                             updated_at = now()`,
              [menu_item_id, local.rows[0].id, Number(price || 0), shouldBeActive]
            );
          } else {
            await client.query(
              `update artigo_precos
                  set ativo = $3,
                      updated_at = now()
                where artigo_id = $1
                  and local_id = $2`,
              [menu_item_id, local.rows[0].id, shouldBeActive]
            );
          }
        }
      }

      const items = await getMenuItemsFromDb(client);
      const item = items.find((row) => row.id === menu_item_id);
      invalidateCache('menuItems', 'bootstrap', 'serviceBoard');
      return { item };
    });
  }

  async archiveMenuItem({ menu_item_id }) {
    return withTransaction(async (client) => {
      const result = await client.query(
        `update artigos
            set disponivel = false,
                updated_at = now()
          where id = $1
        returning id`,
        [menu_item_id]
      );

      if (!result.rows[0]) throw makeError('Prato não encontrado.', 404, 'menu_item_not_found');
      invalidateCache('menuItems', 'bootstrap', 'serviceBoard');
      return { item: { id: menu_item_id, active: false } };
    });
  }

  async getServiceBoard() {
    return readCached('serviceBoard', '', 1500, async () => {
    const [tables, kitchen, closedSessionsRes] = await Promise.all([
      this.listTables(),
      this.getKitchenBoard(),
      withTransaction(async (client) =>
        client.query(
          `select s.id,
                  m.id as table_id,
                  coalesce(m.nome, m.codigo) as table_name,
                  coalesce(s.fechada_em, s.aberta_em) as updated_at,
                  s.aberta_em as opened_at,
                  coalesce(u.name, '—') as operator_name,
                  coalesce(sum(pi.quantidade * pi.preco_unit_com_iva), 0) as total,
                  coalesce(sum(pi.quantidade), 0) as item_count
             from mesa_sessoes s
             join mesas m on m.id = s.mesa_id
             left join app_users u on u.id = coalesce(s.fechada_por_id, s.aberta_por_id, s.criada_por_user_id)
             left join pedidos p on p.sessao_id = s.id
             left join pedido_itens pi on pi.pedido_id = p.id and pi.estado <> 'cancelado'
            where s.fechada_em is not null
            group by s.id, m.id, m.nome, m.codigo, s.fechada_em, s.aberta_em, u.name
            order by coalesce(s.fechada_em, s.aberta_em) desc
            limit 12`
        )
      ),
    ]);

    const openTables = tables.filter((table) => Boolean(table.session));
    const recentSessions = openTables
      .map((table) => ({
        id: table.session.id,
        table_id: table.id,
        table_name: table.name,
        status: table.session.status,
        opened_at: table.session.opened_at,
        updated_at: table.session.updated_at,
        operator_id: table.session.operator_id,
        total: table.metrics.total,
        item_count: table.metrics.total_items,
      }))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));

    return {
      open_tables: openTables,
      recent_sessions: recentSessions.slice(0, 12),
      closed_sessions: closedSessionsRes.rows.map((row) => ({
        id: row.id,
        table_id: row.table_id,
        table_name: row.table_name,
        status: 'closed',
        opened_at: row.opened_at,
        updated_at: row.updated_at,
        operator_name: row.operator_name,
        total: parseMoney(row.total),
        item_count: Number(row.item_count || 0),
      })),
      recent_events: [],
      kitchen,
    };
    });
  }

  async resetDemoData(includeExamples = true) {
    return withTransaction(async (client) => {
      await client.query(`delete from audit_log`);
      await client.query(`delete from faturas`);
      await client.query(`delete from pedido_itens`);
      await client.query(`delete from pedidos`);
      await client.query(`delete from mesa_sessoes`);
      await client.query(`delete from customer_web_sessions`);
      await client.query(`delete from mesa_qr_tokens`);
      await client.query(`delete from user_menu_order`);
      await client.query(`delete from artigo_precos`);
      await client.query(`delete from artigos`);
      await client.query(`delete from categorias_artigos`);
      await client.query(`delete from mesas`);
      await client.query(`delete from terminals`);

      const demoUsers = [
        { name: 'Administrador', email: 'admin@rest.local', password: 'admin123', role: 'admin' },
        { name: 'Trabalhador', email: 'worker@rest.local', password: 'worker123', role: 'employee' },
        { name: 'Ana Sala', email: 'ana.sala@rest.local', password: '1234', role: 'employee' },
        { name: 'Rui Bar', email: 'rui.bar@rest.local', password: '1234', role: 'bar' },
        { name: 'João Cozinha', email: 'joao.cozinha@rest.local', password: '1234', role: 'kitchen' },
        { name: 'Maria Gestora', email: 'maria.gestora@rest.local', password: '1234', role: 'manager' },
      ];

      for (const user of demoUsers) {
        await client.query(
          `insert into app_users (name, email, password_hash, role, is_active)
           values ($1, $2, $3, $4, true)
           on conflict (email)
           do update set name = excluded.name,
                         password_hash = excluded.password_hash,
                         role = excluded.role,
                         is_active = true,
                         updated_at = now()`,
          [user.name, user.email, user.password, user.role]
        );
      }

      const usersRes = await client.query(
        `select id, email, name, role from app_users where lower(email) = any($1::text[])`,
        [demoUsers.map((user) => user.email.toLowerCase())]
      );
      const userByEmail = new Map(usersRes.rows.map((row) => [row.email.toLowerCase(), row]));

      const terminalRows = [
        { id: 'terminal_main', name: 'Terminal Principal', email: 'ana.sala@rest.local' },
        { id: 'terminal_bar', name: 'Receção Bar', email: 'rui.bar@rest.local' },
        { id: 'terminal_takeaway', name: 'Takeaway', email: 'maria.gestora@rest.local' },
        { id: 'terminal_kitchen', name: 'Painel Cozinha', email: 'joao.cozinha@rest.local' },
      ];
      for (const terminal of terminalRows) {
        const user = userByEmail.get(terminal.email);
        await client.query(
          `insert into terminals (id, name, current_operator_id)
           values ($1, $2, $3)`,
          [terminal.id, terminal.name, user?.id || null]
        );
      }

      const tableRows = [
        { id: 'mesa_rest_1', codigo: 'M1', nome: 'Mesa 1', local: 'restaurante', capacidade: 4 },
        { id: 'mesa_rest_2', codigo: 'M2', nome: 'Mesa 2', local: 'restaurante', capacidade: 4 },
        { id: 'mesa_rest_3', codigo: 'M3', nome: 'Mesa 3', local: 'restaurante', capacidade: 6 },
        { id: 'mesa_rest_4', codigo: 'M4', nome: 'Mesa 4', local: 'restaurante', capacidade: 2 },
        { id: 'mesa_rest_5', codigo: 'M5', nome: 'Mesa 5', local: 'restaurante', capacidade: 4 },
        { id: 'mesa_espl_1', codigo: 'E1', nome: 'Esplanada 1', local: 'esplanada', capacidade: 4 },
        { id: 'mesa_espl_2', codigo: 'E2', nome: 'Esplanada 2', local: 'esplanada', capacidade: 4 },
        { id: 'mesa_bar_1', codigo: 'B1', nome: 'Bar 1', local: 'bar', capacidade: 2 },
        { id: 'mesa_bar_2', codigo: 'B2', nome: 'Bar 2', local: 'bar', capacidade: 2 },
        { id: 'mesa_take_1', codigo: 'T1', nome: 'Takeaway 1', local: 'takeaway', capacidade: 1 },
        { id: 'mesa_take_2', codigo: 'T2', nome: 'Takeaway 2', local: 'takeaway', capacidade: 1 },
        { id: 'mesa_take_3', codigo: 'T3', nome: 'Takeaway 3', local: 'takeaway', capacidade: 1 },
      ];
      for (const table of tableRows) {
        const localRes = await client.query(`select id from locais where nome = $1 limit 1`, [table.local]);
        await client.query(
          `insert into mesas (id, codigo, nome, local_id, capacidade, ativa, nota)
           values ($1, $2, $3, $4, $5, true, null)`,
          [table.id, table.codigo, table.nome, localRes.rows[0].id, table.capacidade]
        );
      }

      const categoryRows = [
        { id: 'cat_pratos', nome: 'Pratos', sort: 1 },
        { id: 'cat_entradas', nome: 'Entradas', sort: 2 },
        { id: 'cat_bebidas', nome: 'Bebidas', sort: 3 },
        { id: 'cat_sobremesas', nome: 'Sobremesas', sort: 4 },
        { id: 'cat_snacks', nome: 'Snacks', sort: 5 },
        { id: 'cat_extras', nome: 'Extras', sort: 6 },
      ];
      for (const category of categoryRows) {
        await client.query(
          `insert into categorias_artigos (id, nome, sort_order)
           values ($1, $2, $3)`,
          [category.id, category.nome, category.sort]
        );
      }

      const articleRows = [
        { id: 'art_bife', nome: 'Bife da Casa', categoria: 'cat_pratos', tipo: 'principal', prep: 'cozinha', minutos: 16, price: 12.5, locals: ['restaurante', 'esplanada', 'takeaway'] },
        { id: 'art_feijoada', nome: 'Feijoada', categoria: 'cat_pratos', tipo: 'principal', prep: 'cozinha', minutos: 18, price: 15.0, locals: ['restaurante', 'esplanada'] },
        { id: 'art_hamburger', nome: 'Hambúrguer da Casa', categoria: 'cat_pratos', tipo: 'principal', prep: 'cozinha', minutos: 14, price: 9.5, locals: ['restaurante', 'esplanada', 'takeaway'] },
        { id: 'art_sopa', nome: 'Sopa do Dia', categoria: 'cat_entradas', tipo: 'acompanhamento', prep: 'cozinha', minutos: 4, price: 2.5, locals: ['restaurante', 'takeaway'] },
        { id: 'art_salada', nome: 'Salada Mista', categoria: 'cat_extras', tipo: 'acompanhamento', prep: 'cozinha', minutos: 3, price: 3.0, locals: ['restaurante', 'esplanada', 'takeaway'] },
        { id: 'art_batata', nome: 'Batata Frita', categoria: 'cat_extras', tipo: 'extra', prep: 'cozinha', minutos: 6, price: 3.0, locals: ['restaurante', 'esplanada', 'takeaway', 'bar'] },
        { id: 'art_cola', nome: 'Coca-Cola', categoria: 'cat_bebidas', tipo: 'bebida', prep: 'bar', minutos: 1, price: 2.0, locals: ['restaurante', 'esplanada', 'takeaway', 'bar'] },
        { id: 'art_cafe', nome: 'Café', categoria: 'cat_bebidas', tipo: 'bebida', prep: 'bar', minutos: 1, price: 1.1, locals: ['restaurante', 'esplanada', 'takeaway', 'bar'] },
        { id: 'art_pudim', nome: 'Pudim', categoria: 'cat_sobremesas', tipo: 'sobremesa', prep: 'cozinha', minutos: 2, price: 3.5, locals: ['restaurante', 'esplanada', 'bar'] },
        { id: 'art_prego', nome: 'Prego no Pão', categoria: 'cat_snacks', tipo: 'principal', prep: 'cozinha', minutos: 10, price: 6.5, locals: ['takeaway', 'bar', 'esplanada'] },
        { id: 'art_tosta', nome: 'Tosta Mista', categoria: 'cat_snacks', tipo: 'principal', prep: 'cozinha', minutos: 7, price: 4.5, locals: ['takeaway', 'bar', 'esplanada'] },
        { id: 'art_agua', nome: 'Água 50cl', categoria: 'cat_bebidas', tipo: 'bebida', prep: 'bar', minutos: 1, price: 1.4, locals: ['restaurante', 'esplanada', 'takeaway', 'bar'] },
      ];
      for (const article of articleRows) {
        await client.query(
          `insert into artigos (id, nome, categoria_id, tipo, sitio_prep, stock_ilimitado, disponivel, prep_minutes, sort_order, descricao_curta)
           values ($1, $2, $3, $4, $5, true, true, $6, $7, $8)`,
          [article.id, article.nome, article.categoria, article.tipo, article.prep, article.minutos, articleRows.findIndex((row) => row.id === article.id) + 1, article.nome]
        );

        for (const localNome of article.locals) {
          const localRes = await client.query(`select id from locais where nome = $1 limit 1`, [localNome]);
          await client.query(
            `insert into artigo_precos (artigo_id, local_id, preco_sem_iva, taxa_iva, ativo)
             values ($1, $2, round(($3 / 1.23)::numeric, 2), 23, true)`,
            [article.id, localRes.rows[0].id, article.price]
          );
        }
      }

      if (includeExamples) {
        const anaId = userByEmail.get('ana.sala@rest.local')?.id;
        const ruiId = userByEmail.get('rui.bar@rest.local')?.id;
        const joaoId = userByEmail.get('joao.cozinha@rest.local')?.id;
        const mariaId = userByEmail.get('maria.gestora@rest.local')?.id;

        const openRestaurantSession = (await client.query(`select abrir_mesa_staff($1, $2, $3, $4, $5) as id`, ['mesa_rest_1', anaId, 4, 'Mesa Família Silva', 'Jantar principal'])).rows[0].id;
        const openRestaurantPedido = (await client.query(`select criar_pedido_staff($1, $2, $3::text[]) as id`, [openRestaurantSession, anaId, ['Sem pimenta numa dose']])).rows[0].id;
        await client.query(`select adicionar_item_pedido($1, $2, $3, $4)`, [openRestaurantPedido, 'art_bife', 2, 'Um mal passado']);
        await client.query(`select adicionar_item_pedido($1, $2, $3, $4)`, [openRestaurantPedido, 'art_cola', 2, '']);
        await client.query(`select adicionar_item_pedido($1, $2, $3, $4)`, [openRestaurantPedido, 'art_batata', 1, '']);
        await client.query(`select enviar_pedido($1)`, [openRestaurantPedido]);
        await client.query(`update pedido_itens set estado = 'em_preparo', updated_at = now() where pedido_id = $1 and artigo_id = 'art_bife'`, [openRestaurantPedido]);
        await client.query(`update pedido_itens set estado = 'pronto', pronto_em = now(), updated_at = now() where pedido_id = $1 and artigo_id = 'art_cola'`, [openRestaurantPedido]);

        const openBarSession = (await client.query(`select abrir_mesa_staff($1, $2, $3, $4, $5) as id`, ['mesa_bar_1', ruiId, 2, 'Cliente balcão', 'Bar activo'])).rows[0].id;
        const openBarPedido = (await client.query(`select criar_pedido_staff($1, $2, $3::text[]) as id`, [openBarSession, ruiId, []])).rows[0].id;
        await client.query(`select adicionar_item_pedido($1, $2, $3, $4)`, [openBarPedido, 'art_cafe', 2, '']);
        await client.query(`select adicionar_item_pedido($1, $2, $3, $4)`, [openBarPedido, 'art_prego', 1, 'Sem mostarda']);
        await client.query(`select enviar_pedido($1)`, [openBarPedido]);
        await client.query(`update pedido_itens set estado = 'pronto', pronto_em = now(), updated_at = now() where pedido_id = $1 and artigo_id = 'art_cafe'`, [openBarPedido]);
        await client.query(`update pedido_itens set estado = 'enviado', updated_at = now() where pedido_id = $1 and artigo_id = 'art_prego'`, [openBarPedido]);

        const takeawaySession = (await client.query(`select abrir_mesa_staff($1, $2, $3, $4, $5) as id`, ['mesa_take_1', mariaId, 1, 'Takeaway Pedro', 'Levantamento 20:15'])).rows[0].id;
        const takeawayPedido = (await client.query(`select criar_pedido_staff($1, $2, $3::text[]) as id`, [takeawaySession, mariaId, ['Cliente leva consigo']])).rows[0].id;
        await client.query(`select adicionar_item_pedido($1, $2, $3, $4)`, [takeawayPedido, 'art_hamburger', 1, 'Sem cebola']);
        await client.query(`select adicionar_item_pedido($1, $2, $3, $4)`, [takeawayPedido, 'art_agua', 1, '']);

        const closedSession = (await client.query(`select abrir_mesa_staff($1, $2, $3, $4, $5) as id`, ['mesa_rest_2', anaId, 2, 'Casal jantar', 'Fechar com cartão'])).rows[0].id;
        const closedPedido = (await client.query(`select criar_pedido_staff($1, $2, $3::text[]) as id`, [closedSession, anaId, []])).rows[0].id;
        await client.query(`select adicionar_item_pedido($1, $2, $3, $4)`, [closedPedido, 'art_feijoada', 1, '']);
        await client.query(`select adicionar_item_pedido($1, $2, $3, $4)`, [closedPedido, 'art_pudim', 2, '']);
        await client.query(`select adicionar_item_pedido($1, $2, $3, $4)`, [closedPedido, 'art_agua', 2, '']);
        await client.query(`select enviar_pedido($1)`, [closedPedido]);
        await client.query(`update pedido_itens set estado = 'entregue', entregue_em = now(), updated_at = now() where pedido_id = $1`, [closedPedido]);
        await client.query(`select faturar_sessao($1, $2, 'cartao', null)`, [closedSession, anaId]);
        await client.query(`select fechar_sessao($1, $2)`, [closedSession, anaId]);
      }

      const counts = await client.query(
        `select
            (select count(*) from app_users where is_active = true) as users_count,
            (select count(*) from mesas) as tables_count,
            (select count(*) from artigos where disponivel = true) as items_count,
            (select count(*) from faturas) as invoices_count`
      );

      return {
        ok: true,
        message: includeExamples
          ? 'Base de dados populada com utilizadores, mesas, menus, pedidos e faturas exemplo.'
          : 'Base estrutural reposta com utilizadores, mesas e menu exemplo.',
        counts: counts.rows[0],
        credentials: {
          admin: { email: 'admin@rest.local', password: 'admin123' },
          worker: { email: 'worker@rest.local', password: 'worker123' },
        },
      };

      if (includeHistory) {
        response.history = session ? await this.getHistory(table_id, client, session.id) : [];
      }

      return response;
    });
  }


  async resolveCustomerTable({ table_code, venue_type = '' }) {
    return withClient(async (client) => {
      const table = await getTableRowByCode(client, table_code);
      if (!table || table.ativa === false) throw makeError('Mesa não encontrada.', 404, 'table_not_found');
      const localNome = String(table.local_nome || 'restaurante');
      const normalizedVenue = String(venue_type || '').trim().toLowerCase();
      if (normalizedVenue === 'bar' && !['bar', 'esplanada'].includes(localNome)) {
        throw makeError('Este QR não pertence ao bar.', 409, 'venue_table_mismatch');
      }
      if (normalizedVenue === 'restaurante' && localNome === 'bar') {
        throw makeError('Este QR pertence ao bar.', 409, 'venue_table_mismatch');
      }
      return {
        table: {
          id: table.id,
          code: table.codigo,
          number: deriveTableNumber(table),
          name: table.nome || table.codigo,
          zone: deriveZoneFromLocal(table.local_nome),
          capacity: Number(table.capacidade || 0),
          local_nome: localNome,
          menu_key: mapLocalToMenuKey(localNome),
        }
      };
    });
  }

  async startCustomerSession({ table_code, venue_type = '', customer_name = '', customer_phone = '', customer_email = '', customer_nif = '', customer_count = 1 }) {
    const payload = await withTransaction(async (client) => {
      await ensureCustomerFlowSchema(client);
      const table = await getTableRowByCode(client, table_code);
      if (!table || table.ativa === false) throw makeError('Mesa não encontrada.', 404, 'table_not_found');
      const localNome = String(table.local_nome || 'restaurante');
      const normalizedVenue = String(venue_type || '').trim().toLowerCase();
      if (normalizedVenue === 'bar' && !['bar', 'esplanada'].includes(localNome)) {
        throw makeError('Este QR não pertence ao bar.', 409, 'venue_table_mismatch');
      }
      if (normalizedVenue === 'restaurante' && localNome === 'bar') {
        throw makeError('Este QR pertence ao bar.', 409, 'venue_table_mismatch');
      }
      const actor = await ensureCustomerActor(client);
      let session = await getActiveSessionRow(client, table.id);
      if (!session) {
        await client.query(`select abrir_mesa_staff($1, $2, $3, $4, $5) as id`, [
          table.id,
          actor.id,
          Math.max(1, Number(customer_count || 1)),
          String(customer_name || '').trim() || null,
          'self_service_customer',
        ]);
        session = await getActiveSessionRow(client, table.id);
      }
      if (!session) throw makeError('Não foi possível iniciar a sessão.', 500, 'session_open_failed');
      await client.query(
        `update mesa_sessoes
            set cliente_nome = coalesce(nullif($2, ''), cliente_nome),
                cliente_qtd = coalesce($3, cliente_qtd),
                nota = trim(both from concat_ws(' · ', nullif($4, ''), nullif($5, ''), nullif($6, ''))),
                updated_at = now()
          where id = $1`,
        [session.id, String(customer_name || '').trim(), Math.max(1, Number(customer_count || 1)), String(customer_phone || '').trim(), String(customer_email || '').trim().toLowerCase(), digitsOnly(customer_nif)]
      );
      const menuItems = menuItemsForLocal(await getMenuItemsFromDb(client), localNome);
      const items = await getSessionItems(client, session.id);
      const visibleItems = items.filter((item) => item.estado !== 'cancelado');
      const totals = {
        total: visibleItems.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unit_price || 0), 0),
        total_items: visibleItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
      };
      return {
        session: {
          id: session.id,
          table_id: table.id,
          table_code: table.codigo,
          table_name: table.nome || table.codigo,
          zone: deriveZoneFromLocal(localNome),
          local_nome: localNome,
          menu_key: mapLocalToMenuKey(localNome),
          venue_type: normalizedVenue || (localNome === 'bar' ? 'bar' : 'restaurante'),
          customer_name: String(customer_name || '').trim(),
          customer_phone: String(customer_phone || '').trim(),
          customer_email: String(customer_email || '').trim().toLowerCase(),
          customer_nif: digitsOnly(customer_nif),
          customer_count: Math.max(1, Number(customer_count || 1)),
          opened_at: session.aberta_em,
        },
        menu_items: menuItems,
        order_items: visibleItems.map((item) => ({
          id: item.id,
          menu_item_id: item.menu_item_id,
          name: item.name,
          station: item.station,
          flow: item.station,
          category: item.category || 'Sem categoria',
          image_url: item.imagem_url || null,
          quantity: item.quantity,
          prep_minutes: Number(item.prep_minutes || 0),
          unit_price: item.unit_price,
          note: item.note || '',
          raw_status: item.estado,
        })),
        totals,
      };
    });
    return payload;
  }

  async getCustomerSession({ session_id }) {
    return withClient(async (client) => {
      await ensureCustomerFlowSchema(client);
      const session = await getSessionRowById(client, session_id);
      if (!session || session.fechada_em) throw makeError('Sessão não encontrada.', 404, 'session_not_found');
      const table = await getTableRow(client, session.mesa_id);
      const items = await getSessionItems(client, session.id);
      const visibleItems = items.filter((item) => item.estado !== 'cancelado');
      const menuItems = menuItemsForLocal(await getMenuItemsFromDb(client), session.local_id ? String(table?.local_nome || 'restaurante') : 'restaurante');
      const paymentRequest = mapCustomerPaymentRequest(await getLatestCustomerCheckoutRequest(client, session.id));
      return {
        session: {
          id: session.id,
          table_id: session.mesa_id,
          table_code: session.table_codigo,
          table_name: session.table_name || session.table_codigo,
          zone: deriveZoneFromLocal(table?.local_nome),
          local_nome: table?.local_nome || 'restaurante',
          menu_key: mapLocalToMenuKey(table?.local_nome || 'restaurante'),
          customer_name: session.cliente_nome || '',
          customer_count: Number(session.cliente_qtd || 1),
          note: session.nota || '',
          opened_at: session.aberta_em,
          updated_at: session.updated_at,
        },
        menu_items: menuItems,
        order_items: visibleItems.map((item) => ({
          id: item.id,
          menu_item_id: item.menu_item_id,
          name: item.name,
          station: item.station,
          flow: item.station,
          category: item.category || 'Sem categoria',
          image_url: item.imagem_url || null,
          quantity: item.quantity,
          prep_minutes: Number(item.prep_minutes || 0),
          unit_price: item.unit_price,
          note: item.note || '',
          raw_status: item.estado,
          status: mapDbItemStatusToKitchen(item.estado === 'rascunho' ? 'enviado' : item.estado),
        })),
        totals: {
          total: visibleItems.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unit_price || 0), 0),
          total_items: visibleItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
        },
        payment_request: paymentRequest,
      };
    });
  }

  async addCustomerItem({ session_id, menu_item_id, quantity = 1, note = '' }) {
    return withTransaction(async (client) => {
      const actor = await ensureCustomerActor(client);
      const session = await getSessionRowById(client, session_id);
      if (!session || session.fechada_em) throw makeError('Sessão não encontrada.', 404, 'session_not_found');
      const latestRequest = await getLatestCustomerCheckoutRequest(client, session.id);
      if (latestRequest && ['awaiting_confirmation', 'paid', 'approved', 'released'].includes(String(latestRequest.status))) {
        throw makeError('O pedido já foi submetido para pagamento. Já não podes alterar itens.', 409, 'customer_order_locked');
      }
      const pedidoId = await getOrCreateDraftPedido(client, session.id, actor.id);
      await ensureItemPriceForLocal(client, menu_item_id, session.local_id);
      await client.query(`select adicionar_item_pedido($1, $2, $3, $4) as id`, [pedidoId, menu_item_id, Math.max(1, Number(quantity || 1)), note || null]);
      invalidateCache('tables', 'history', 'bootstrap', 'serviceBoard');
      return this.getCustomerSession({ session_id: session.id });
    });
  }

  async updateCustomerItem({ session_id, order_item_id, quantity }) {
    return withTransaction(async (client) => {
      const session = await getSessionRowById(client, session_id);
      if (!session || session.fechada_em) throw makeError('Sessão não encontrada.', 404, 'session_not_found');
      const latestRequest = await getLatestCustomerCheckoutRequest(client, session.id);
      if (latestRequest && ['awaiting_confirmation', 'paid', 'approved', 'released'].includes(String(latestRequest.status))) {
        throw makeError('O pedido já foi submetido para pagamento. Já não podes alterar itens.', 409, 'customer_order_locked');
      }
      await client.query(
        `update pedido_itens pi
            set quantidade = $3,
                updated_at = now()
           from pedidos p
          where pi.id = $1
            and p.id = pi.pedido_id
            and p.sessao_id = $2
            and pi.estado = 'rascunho'`,
        [order_item_id, session.id, Math.max(1, Number(quantity || 1))]
      );
      invalidateCache('tables', 'history', 'bootstrap', 'serviceBoard');
      return this.getCustomerSession({ session_id: session.id });
    });
  }

  async removeCustomerItem({ session_id, order_item_id }) {
    return withTransaction(async (client) => {
      const session = await getSessionRowById(client, session_id);
      if (!session || session.fechada_em) throw makeError('Sessão não encontrada.', 404, 'session_not_found');
      const latestRequest = await getLatestCustomerCheckoutRequest(client, session.id);
      if (latestRequest && ['awaiting_confirmation', 'paid', 'approved', 'released'].includes(String(latestRequest.status))) {
        throw makeError('O pedido já foi submetido para pagamento. Já não podes alterar itens.', 409, 'customer_order_locked');
      }
      await client.query(
        `delete from pedido_itens pi
         using pedidos p
         where pi.id = $1
           and p.id = pi.pedido_id
           and p.sessao_id = $2
           and pi.estado = 'rascunho'`,
        [order_item_id, session.id]
      );
      invalidateCache('tables', 'history', 'bootstrap', 'serviceBoard');
      return this.getCustomerSession({ session_id: session.id });
    });
  }

  async submitCustomerOrder({ session_id, payment_method, customer_name = '', customer_phone = '', customer_email = '', customer_nif = '', mbway_contact = '', venue_type = '', send_email = false }) {
    const payload = await withTransaction(async (client) => {
      await ensureCustomerFlowSchema(client);
      const actor = await ensureCustomerActor(client);
      const session = await getSessionRowById(client, session_id);
      if (!session || session.fechada_em) throw makeError('Sessão não encontrada.', 404, 'session_not_found');
      const existingRequest = await getLatestCustomerCheckoutRequest(client, session.id);
      if (existingRequest && ['awaiting_confirmation', 'paid', 'approved', 'released'].includes(String(existingRequest.status))) {
        throw makeError('Já existe um pedido submetido para pagamento nesta mesa.', 409, 'customer_payment_request_exists');
      }
      const totals = await computeSessionTotals(client, session.id);
      const visibleItems = totals.items.filter((item) => item.estado !== 'cancelado');
      const draftItems = visibleItems.filter((item) => item.estado === 'rascunho');
      if (!draftItems.length) throw makeError('Não tens itens em rascunho para submeter.', 409, 'no_draft_items');
      const normalizedPayment = normalizePaymentType(payment_method);
      const initialStatus = normalizedPayment === 'mbway' ? 'paid' : 'awaiting_confirmation';
      const inserted = await client.query(
        `insert into public.customer_checkout_requests (
          sessao_id, mesa_id, payment_method, status, amount_total,
          customer_name, customer_phone, customer_nif, customer_email, mbway_contact, venue_type, metadata_json
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
        returning *`,
        [session.id, session.mesa_id, normalizedPayment, initialStatus, totals.total, String(customer_name || '').trim() || session.cliente_nome || null, String(customer_phone || '').trim() || null, digitsOnly(customer_nif) || null, String(customer_email || '').trim().toLowerCase() || null, String(mbway_contact || '').trim() || null, String(venue_type || '').trim() || null, JSON.stringify({ send_email: send_email === true, draft_item_ids: draftItems.map((item) => item.id) })]
      );
      let requestRow = inserted.rows[0];
      let released = { sent_items: 0, item_ids: [] };
      if (normalizedPayment === 'mbway') {
        released = await releaseDraftKitchenItems(client, { session, actorUserId: actor.id, terminalId: 'terminal_customer' });
        const updated = await client.query(
          `update public.customer_checkout_requests
              set status = 'released',
                  approved_at = now(),
                  released_at = now(),
                  approved_by_user_id = null,
                  updated_at = now()
            where id = $1
        returning *`,
          [requestRow.id]
        );
        requestRow = updated.rows[0];
      }
      await insertAuditLog(client, {
        actor_user_id: actor.id,
        terminal_id: 'terminal_customer',
        entity_type: 'table_session',
        entity_id: session.id,
        action_type: 'customer_payment_requested',
        payload: {
          table_session_id: session.id,
          payment_method: uiPaymentType(normalizedPayment),
          amount_total: totals.total,
          request_id: requestRow.id,
          released_to_production: normalizedPayment === 'mbway',
        },
      });
      invalidateCache('tables', 'history', 'bootstrap', 'serviceBoard', 'kitchen');
      return { request: mapCustomerPaymentRequest({ ...requestRow, table_name: session.table_name || session.table_codigo, table_code: session.table_codigo }), released, session_id: session.id, customer_email: requestRow.customer_email, customer_name: requestRow.customer_name, send_email: send_email === true, table_name: session.table_name || session.table_codigo };
    });
    let email = { sent: false, reason: 'not_requested' };
    if (payload.send_email === true) {
      email = await sendCustomerOrderEmailIfNeeded({ customerEmail: payload.customer_email, customerName: payload.customer_name, sessionId: payload.session_id, paymentMethod: payload.request.raw_payment_method, amountTotal: payload.request.amount_total, tableName: payload.table_name });
      if (email.sent) {
        await withTransaction(async (client) => {
          await ensureCustomerFlowSchema(client);
          await client.query(`update public.customer_checkout_requests set email_sent_at = now(), updated_at = now() where id = $1`, [payload.request.id]);
        });
      }
    }
    return { payment_request: payload.request, released: payload.released, email };
  }

  async listPendingPaymentRequests({ terminal_id = 'terminal_main' } = {}) {
    return withClient(async (client) => {
      await ensureCustomerFlowSchema(client);
      const rows = await client.query(
        `select ccr.*, m.nome as table_name, m.codigo as table_code, l.nome as local_nome
           from public.customer_checkout_requests ccr
           join public.mesas m on m.id = ccr.mesa_id
           join public.locais l on l.id = m.local_id
          where ccr.status in ('awaiting_confirmation')
          order by ccr.requested_at asc`
      );
      const normalizedTerminal = String(terminal_id || 'terminal_main').toLowerCase();
      const items = rows.rows.filter((row) => {
        const localNome = String(row.local_nome || '').toLowerCase();
        if (normalizedTerminal === 'terminal_bar') return ['bar', 'esplanada'].includes(localNome);
        if (normalizedTerminal === 'terminal_takeaway') return localNome === 'takeaway';
        return !['bar'].includes(localNome);
      }).map((row) => ({
        ...mapCustomerPaymentRequest({ ...row, table_name: row.table_name, table_code: row.table_code }),
        local_nome: row.local_nome,
      }));
      return { items, total: items.length };
    });
  }

  async approvePaymentRequest({ request_id, operator_id, terminal_id = 'terminal_main' }) {
    return withTransaction(async (client) => {
      await ensureCustomerFlowSchema(client);
      const result = await client.query(
        `select ccr.*, m.nome as table_name, m.codigo as table_code
           from public.customer_checkout_requests ccr
           join public.mesas m on m.id = ccr.mesa_id
          where ccr.id = $1
          limit 1`,
        [request_id]
      );
      const requestRow = result.rows[0];
      if (!requestRow) throw makeError('Pedido de pagamento não encontrado.', 404, 'payment_request_not_found');
      if (String(requestRow.status) !== 'awaiting_confirmation') throw makeError('Este pedido já não está pendente.', 409, 'payment_request_not_pending');
      const session = await getSessionRowById(client, requestRow.sessao_id);
      if (!session || session.fechada_em) throw makeError('Sessão já não está ativa.', 409, 'session_not_active');
      await client.query(
        `update public.customer_checkout_requests
            set status = 'approved',
                approved_at = now(),
                approved_by_user_id = $2,
                updated_at = now()
          where id = $1`,
        [requestRow.id, operator_id]
      );
      const released = await releaseDraftKitchenItems(client, { session, actorUserId: operator_id, terminalId: terminal_id });
      const updated = await client.query(
        `update public.customer_checkout_requests
            set status = 'released',
                released_at = now(),
                updated_at = now()
          where id = $1
        returning *`,
        [requestRow.id]
      );
      await insertAuditLog(client, {
        actor_user_id: operator_id,
        terminal_id,
        entity_type: 'table_session',
        entity_id: session.id,
        action_type: 'customer_payment_approved',
        payload: {
          table_session_id: session.id,
          request_id: requestRow.id,
          payment_method: uiPaymentType(requestRow.payment_method),
          released_items: released.sent_items,
        },
      });
      invalidateCache('tables', 'history', 'bootstrap', 'serviceBoard', 'kitchen');
      return { payment_request: mapCustomerPaymentRequest({ ...updated.rows[0], table_name: requestRow.table_name, table_code: requestRow.table_code }), released };
    });
  }
}

export const restaurantStore = new RestaurantStore();
