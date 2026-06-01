import { query } from '../src/db.js';

const PERFORMANCE_INDEXES = [
  `create index concurrently if not exists idx_rest_mesas_codigo_lower on public.mesas (lower(codigo))`,
  `create index concurrently if not exists idx_rest_mesas_nome_lower on public.mesas (lower(nome))`,
  `create index concurrently if not exists idx_rest_mesas_local_ativa on public.mesas (local_id, ativa)`,
  `create index concurrently if not exists idx_rest_mesa_sessoes_active_mesa on public.mesa_sessoes (mesa_id, estado, aberta_em desc) where fechada_em is null`,
  `create index concurrently if not exists idx_rest_mesa_sessoes_id_open on public.mesa_sessoes (id) where fechada_em is null`,
  `create index concurrently if not exists idx_rest_pedidos_sessao on public.pedidos (sessao_id, created_at desc)`,
  `create index concurrently if not exists idx_rest_pedido_itens_pedido_estado on public.pedido_itens (pedido_id, estado)`,
  `create index concurrently if not exists idx_rest_pedido_itens_kitchen_status on public.pedido_itens (sitio_prep_snapshot, estado, enviado_cozinha_em, updated_at)`,
  `create index concurrently if not exists idx_rest_artigo_precos_artigo_local on public.artigo_precos (artigo_id, local_id, ativo)`,
  `create index concurrently if not exists idx_rest_categorias_sort on public.categorias_artigos (sort_order, nome)`,
  `create index concurrently if not exists idx_rest_checkout_intents_session_status on public.checkout_payment_intents (sessao_id, status, expires_at, created_at desc)`,
  `create index concurrently if not exists idx_rest_audit_entity_created on public.audit_log (entity_id, created_at desc)`,
  `create index concurrently if not exists idx_rest_audit_payload_session_created on public.audit_log ((payload->>'table_session_id'), created_at desc)`,
  `create index concurrently if not exists idx_rest_mesa_qr_tokens_active_token on public.mesa_qr_tokens (token) where is_active = true`,
  `create index concurrently if not exists idx_rest_mesa_qr_tokens_active_mesa on public.mesa_qr_tokens (mesa_id, created_at desc) where is_active = true`,
  `create index concurrently if not exists idx_rest_customer_checkout_session_created on public.customer_checkout_requests (sessao_id, created_at desc)`,
  `create index concurrently if not exists idx_rest_customer_note_threads_session_item on public.customer_note_threads (sessao_id, order_item_id, updated_at desc)`,
  `create index concurrently if not exists idx_rest_customer_note_messages_thread_created on public.customer_note_messages (thread_id, created_at asc)`,
  `create index concurrently if not exists idx_rest_takeaway_chat_status_updated on public.takeaway_chat_orders (status, updated_at desc)`,
  `create index concurrently if not exists idx_rest_takeaway_chat_pickup_at on public.takeaway_chat_orders (pickup_at) where pickup_at is not null`,
];

let started = false;

export async function ensureRestaurantPerformanceIndexes() {
  if (started || process.env.RESTAURANT_SKIP_PERFORMANCE_INDEXES === 'true') return;
  started = true;

  for (const statement of PERFORMANCE_INDEXES) {
    try {
      await query(statement);
    } catch (error) {
      // Não bloqueia o arranque: alguns ambientes antigos podem ainda não ter todas as tabelas/colunas.
      console.warn('[restaurant-performance] índice ignorado:', error?.message || error);
    }
  }
}
