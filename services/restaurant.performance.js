import { query } from '../src/db.js';

const PERFORMANCE_INDEXES = [
  { table: 'public.mesas', sql: `create index concurrently if not exists idx_rest_mesas_codigo_lower on public.mesas (lower(codigo))` },
  { table: 'public.mesas', sql: `create index concurrently if not exists idx_rest_mesas_nome_lower on public.mesas (lower(nome))` },
  { table: 'public.mesas', sql: `create index concurrently if not exists idx_rest_mesas_local_ativa on public.mesas (local_id, ativa)` },
  { table: 'public.locais', sql: `create index concurrently if not exists idx_rest_locais_nome_lower on public.locais (lower(nome))` },

  { table: 'public.mesa_sessoes', sql: `create index concurrently if not exists idx_rest_mesa_sessoes_active_mesa on public.mesa_sessoes (mesa_id, estado, aberta_em desc) where fechada_em is null` },
  { table: 'public.mesa_sessoes', sql: `create index concurrently if not exists idx_rest_mesa_sessoes_id_open on public.mesa_sessoes (id) where fechada_em is null` },
  { table: 'public.mesa_sessoes', sql: `create index concurrently if not exists idx_rest_mesa_sessoes_fechada on public.mesa_sessoes (fechada_em desc) where fechada_em is not null` },

  { table: 'public.pedidos', sql: `create index concurrently if not exists idx_rest_pedidos_sessao on public.pedidos (sessao_id, created_at desc)` },
  { table: 'public.pedido_itens', sql: `create index concurrently if not exists idx_rest_pedido_itens_pedido_estado on public.pedido_itens (pedido_id, estado)` },
  { table: 'public.pedido_itens', sql: `create index concurrently if not exists idx_rest_pedido_itens_kitchen_status on public.pedido_itens (sitio_prep_snapshot, estado, enviado_cozinha_em, updated_at)` },
  { table: 'public.pedido_itens', sql: `create index concurrently if not exists idx_rest_pedido_itens_nome_snapshot_lower on public.pedido_itens (lower(nome_snapshot))` },

  { table: 'public.artigos', sql: `create index concurrently if not exists idx_rest_artigos_categoria_disponivel on public.artigos (categoria_id, disponivel, sort_order, nome)` },
  { table: 'public.artigos', sql: `create index concurrently if not exists idx_rest_artigos_nome_lower on public.artigos (lower(nome))` },
  { table: 'public.artigo_precos', sql: `create index concurrently if not exists idx_rest_artigo_precos_artigo_local on public.artigo_precos (artigo_id, local_id, ativo)` },
  { table: 'public.menu_item_availability', sql: `create index concurrently if not exists idx_rest_menu_item_availability_lookup on public.menu_item_availability (artigo_id, local_nome, day_of_week, enabled)` },
  { table: 'public.categorias_artigos', sql: `create index concurrently if not exists idx_rest_categorias_sort on public.categorias_artigos (sort_order, nome)` },

  { table: 'public.checkout_payment_intents', sql: `create index concurrently if not exists idx_rest_checkout_intents_session_status on public.checkout_payment_intents (sessao_id, status, expires_at, created_at desc)` },
  { table: 'public.customer_checkout_requests', sql: `create index concurrently if not exists idx_rest_customer_checkout_session_created on public.customer_checkout_requests (sessao_id, created_at desc)` },
  { table: 'public.customer_checkout_requests', sql: `create index concurrently if not exists idx_rest_customer_checkout_status_requested on public.customer_checkout_requests (status, requested_at asc)` },

  { table: 'public.faturas', sql: `create index concurrently if not exists idx_rest_faturas_created_at on public.faturas (created_at desc)` },
  { table: 'public.faturas', sql: `create index concurrently if not exists idx_rest_faturas_sessao on public.faturas (sessao_id)` },
  { table: 'public.pagamentos', sql: `create index concurrently if not exists idx_rest_pagamentos_created_tipo on public.pagamentos (created_at desc, tipo_pagamento)` },

  { table: 'public.audit_log', sql: `create index concurrently if not exists idx_rest_audit_entity_created on public.audit_log (entity_id, created_at desc)` },
  { table: 'public.audit_log', sql: `create index concurrently if not exists idx_rest_audit_payload_session_created on public.audit_log ((payload->>'table_session_id'), created_at desc)` },

  { table: 'public.mesa_qr_tokens', sql: `create index concurrently if not exists idx_rest_mesa_qr_tokens_active_token on public.mesa_qr_tokens (token) where is_active = true` },
  { table: 'public.mesa_qr_tokens', sql: `create index concurrently if not exists idx_rest_mesa_qr_tokens_active_mesa on public.mesa_qr_tokens (mesa_id, created_at desc) where is_active = true` },

  { table: 'public.customer_note_threads', sql: `create index concurrently if not exists idx_rest_customer_note_threads_session_item on public.customer_note_threads (sessao_id, order_item_id, updated_at desc)` },
  { table: 'public.customer_note_messages', sql: `create index concurrently if not exists idx_rest_customer_note_messages_thread_created on public.customer_note_messages (thread_id, created_at asc)` },

  { table: 'public.takeaway_chat_orders', sql: `create index concurrently if not exists idx_rest_takeaway_chat_status_updated on public.takeaway_chat_orders (status, updated_at desc)` },
  { table: 'public.takeaway_chat_orders', sql: `create index concurrently if not exists idx_rest_takeaway_chat_pickup_at on public.takeaway_chat_orders (pickup_at) where pickup_at is not null` },
];

let started = false;
const tableExistenceCache = new Map();

async function tableExists(tableName) {
  if (tableExistenceCache.has(tableName)) return tableExistenceCache.get(tableName);
  const result = await query(`select to_regclass($1) as table_name`, [tableName]);
  const exists = Boolean(result.rows?.[0]?.table_name);
  tableExistenceCache.set(tableName, exists);
  return exists;
}

export async function ensureRestaurantPerformanceIndexes() {
  if (started || process.env.RESTAURANT_SKIP_PERFORMANCE_INDEXES === 'true') return;
  started = true;

  for (const definition of PERFORMANCE_INDEXES) {
    try {
      if (!(await tableExists(definition.table))) continue;
      await query(definition.sql);
    } catch (error) {
      // Não bloqueia o arranque: alguns ambientes antigos podem ainda não ter todas as colunas.
      console.warn('[restaurant-performance] índice ignorado:', error?.message || error);
    }
  }
}
