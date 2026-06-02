import { withClient } from '../src/db.js';
import { restaurantStore } from './restaurant.store.js';

const DAY_LABELS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const MONEY = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' });
const SUGGESTIONS = [
  'Quais são os pratos ativos hoje?',
  'Há mesas abertas ou pagamentos por fazer?',
  'Quais foram os pratos mais vendidos hoje?',
  'Quantos takeaways entraram pelo chat online?',
  'Quantos pagamentos MB WAY foram feitos hoje e quantas faturas foram por email?',
  'Quem registou a última fatura?',
  'Mostra pratos desativados / sem stock.',
];

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function euro(value) {
  return MONEY.format(Number(value || 0));
}

function todayIndex() {
  return new Date().getDay();
}

function itemEnabledForMenuToday(item, menuKey, day = todayIndex()) {
  return item?.active !== false && Array.isArray(item?.menu_rules?.[menuKey]) && item.menu_rules[menuKey].includes(day);
}

function formatList(items, limit = 12) {
  const rows = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!rows.length) return 'Sem dados para mostrar.';
  return rows.slice(0, limit).map((item, index) => `${index + 1}. ${item}`).join('\n');
}

function extractDishTarget(message, active) {
  const text = String(message || '').trim();
  const patterns = active
    ? [/(?:ativar|activar|liga(?:r)?|disponibilizar|meter\s+ativo|por\s+ativo)\s+(?:o|a|os|as|prato|artigo|item)?\s*(.+)$/i]
    : [/(?:desativar|desactivar|tirar|remover|ocultar|esgotar|sem\s+stock|fora\s+de\s+stock)\s+(?:o|a|os|as|prato|artigo|item)?\s*(.+)$/i];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1]
        .replace(/\b(do|da|dos|das|no|na|nos|nas|menu|stock|pratos?|artigos?)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }
  return '';
}

function scoreDish(item, target) {
  const name = normalize(item?.name);
  const category = normalize(item?.category);
  const needle = normalize(target);
  if (!needle || !name) return 0;
  if (name === needle) return 100;
  if (name.includes(needle)) return 85;
  if (needle.includes(name)) return 75;
  const words = needle.split(' ').filter((word) => word.length >= 3);
  if (!words.length) return 0;
  const matchedNameWords = words.filter((word) => name.includes(word)).length;
  const matchedCategoryWords = words.filter((word) => category.includes(word)).length;
  return matchedNameWords * 22 + matchedCategoryWords * 6;
}

async function findDishForAction(target, desiredActive) {
  const items = await restaurantStore.listMenuItems();
  const scored = items
    .map((item) => ({ item, score: scoreDish(item, target) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || String(a.item.name).localeCompare(String(b.item.name), 'pt'));

  const best = scored[0] || null;
  if (!best || best.score < 35) {
    const candidates = items
      .filter((item) => desiredActive ? item.active === false : item.active !== false)
      .slice(0, 8)
      .map((item) => item.name);
    return { match: null, candidates, ambiguous: false };
  }
  const close = scored.filter((row) => row.score >= Math.max(35, best.score - 12)).slice(0, 5);
  if (close.length > 1 && best.score < 85) {
    return { match: null, candidates: close.map((row) => row.item.name), ambiguous: true };
  }
  return { match: best.item, candidates: close.map((row) => row.item.name), ambiguous: false };
}

function inferIntent(message) {
  const n = normalize(message);
  if (!n) return 'help';
  if (/\b(ajuda|sugestoes|sugestoes de perguntas|o que posso perguntar)\b/.test(n)) return 'help';
  if (/\b(ultima fatura|ultima factura|quem faturou|quem facturou|trabalhador.*fatura|trabalhador.*factura)\b/.test(n)) return 'last_invoice_worker';
  if (/\b(mbway|mb way|email|e mail|fatura enviada|factura enviada)\b/.test(n)) return 'payment_email_stats';
  if (/\b(takeaway|take away|chat online|chat web|encomendas online)\b/.test(n) && /\b(quantos|numero|n de|feitos|entraram|pedidos)\b/.test(n)) return 'takeaway_chat_stats';
  if (/\b(mais vendidos|pratos vendidos|vendidos hoje|top pratos|top vendas)\b/.test(n)) return 'top_sold_items';
  if (/\b(mesas abertas|mesas ocupadas|pagamentos pendentes|pagamentos por fazer|contas por pagar|por pagar)\b/.test(n)) return 'open_tables';
  if (/\b(desativados|desactivados|inativos|inactivos|sem stock|esgotados|ocultos|indisponiveis|indisponíveis)\b/.test(n) && /\b(lista|mostra|quais|pratos|artigos)\b/.test(n)) return 'inactive_items';
  if (/\b(ativos hoje|activos hoje|menu de hoje|pratos ativos|pratos activos|quais.*ativos|quais.*activos)\b/.test(n)) return 'active_today';
  if (/\b(ativar|activar|liga|disponibilizar|meter ativo|por ativo)\b/.test(n)) return 'activate_item';
  if (/\b(desativar|desactivar|tirar|remover|ocultar|esgotar|sem stock|fora de stock)\b/.test(n)) return 'deactivate_item';
  return 'help';
}

async function buildActiveTodayAnswer() {
  const [profiles, items] = await Promise.all([restaurantStore.listMenuProfiles(), restaurantStore.listMenuItems()]);
  const day = todayIndex();
  const cards = profiles.map((profile) => {
    const enabled = items
      .filter((item) => itemEnabledForMenuToday(item, profile.id, day))
      .sort((a, b) => String(a.category || '').localeCompare(String(b.category || ''), 'pt') || String(a.name || '').localeCompare(String(b.name || ''), 'pt'));
    return {
      title: profile.name,
      subtitle: `${enabled.length} prato(s) ativos em ${DAY_LABELS[day]}`,
      lines: enabled.slice(0, 18).map((item) => `${item.name}${item.category ? ` · ${item.category}` : ''}`),
    };
  });
  const total = cards.reduce((sum, card) => sum + Number(String(card.subtitle).match(/^\d+/)?.[0] || 0), 0);
  return {
    answer: `Hoje é ${DAY_LABELS[day]}. Encontrei ${total} ativações distribuídas pelos menus.`,
    cards,
  };
}

async function buildInactiveItemsAnswer() {
  const items = await restaurantStore.listMenuItems();
  const inactive = items
    .filter((item) => item.active === false)
    .sort((a, b) => String(a.category || '').localeCompare(String(b.category || ''), 'pt') || String(a.name || '').localeCompare(String(b.name || ''), 'pt'));
  return {
    answer: inactive.length
      ? `Há ${inactive.length} prato(s) desativados/sem stock. Estes não devem aparecer nos menus nem para adicionar às mesas.`
      : 'Não encontrei pratos globalmente desativados/sem stock.',
    cards: [{ title: 'Pratos desativados / sem stock', lines: inactive.slice(0, 30).map((item) => `${item.name}${item.category ? ` · ${item.category}` : ''}`) }],
  };
}

async function buildOpenTablesAnswer() {
  const tables = await restaurantStore.listTables();
  const open = tables.filter((table) => Boolean(table.session));
  const pending = tables.filter((table) => table.has_pending_checkout_payment);
  const openLines = open.map((table) => `${table.name || table.codigo} · ${table.local_nome || table.zone || 'sala'} · ${Number(table.metrics?.total_items || 0)} item(ns) · ${euro(table.metrics?.total || 0)}${table.has_pending_checkout_payment ? ` · ${table.payment_pending_label || 'pagamento pendente'}` : ''}`);
  const pendingLines = pending.map((table) => `${table.name || table.codigo} · ${table.payment_pending_label || 'pagamento pendente'} · ${euro(table.metrics?.total || 0)}`);
  return {
    answer: open.length || pending.length
      ? `Há ${open.length} mesa(s) aberta(s) e ${pending.length} pagamento(s) pendente(s).`
      : 'Não encontrei mesas abertas nem pagamentos pendentes neste momento.',
    cards: [
      { title: 'Mesas abertas', subtitle: `${open.length} aberta(s)`, lines: openLines },
      { title: 'Pagamentos por fazer', subtitle: `${pending.length} pendente(s)`, lines: pendingLines },
    ],
  };
}

async function buildTopSoldItemsAnswer() {
  const rows = await withClient(async (client) => {
    const result = await client.query(
      `select pi.artigo_id,
              coalesce(pi.nome_snapshot, a.nome, 'Artigo') as name,
              coalesce(sum(pi.quantidade), 0)::numeric as quantity,
              coalesce(sum(pi.quantidade * pi.preco_unit_com_iva), 0)::numeric as total
         from public.faturas f
         join public.mesa_sessoes s on s.id = f.sessao_id
         join public.pedidos p on p.sessao_id = s.id
         join public.pedido_itens pi on pi.pedido_id = p.id and pi.estado <> 'cancelado'
         left join public.artigos a on a.id = pi.artigo_id
        where f.created_at >= current_date
          and f.created_at < current_date + interval '1 day'
        group by pi.artigo_id, coalesce(pi.nome_snapshot, a.nome, 'Artigo')
        order by quantity desc, total desc, name asc
        limit 15`
    );
    return result.rows;
  });
  return {
    answer: rows.length
      ? `Top de pratos faturados hoje: ${rows.length} artigo(s) com venda registada.`
      : 'Ainda não encontrei pratos faturados hoje. Mesas abertas sem fatura ainda não entram nesta contagem.',
    cards: [{
      title: 'Pratos mais vendidos hoje',
      subtitle: 'Baseado em faturas emitidas hoje',
      lines: rows.map((row) => `${row.name} · ${Number(row.quantity || 0)} un. · ${euro(row.total)}`),
    }],
  };
}

async function buildTakeawayChatStatsAnswer() {
  const row = await withClient(async (client) => {
    const result = await client.query(
      `select count(*)::int as total,
              count(*) filter (where status = 'pending_staff_confirmation')::int as pending_staff,
              count(*) filter (where status = 'accepted')::int as accepted,
              count(*) filter (where status = 'completed')::int as completed,
              count(*) filter (where status = 'rejected')::int as rejected,
              count(*) filter (where status = 'draft')::int as drafts
         from public.takeaway_chat_orders
        where created_at >= current_date
          and created_at < current_date + interval '1 day'
          and coalesce(source, 'web_chat') = 'web_chat'`
    );
    return result.rows[0] || {};
  });
  return {
    answer: `Hoje entraram ${Number(row.total || 0)} pedido(s) pelo chat online. ${Number(row.pending_staff || 0)} aguardam confirmação da equipa.`,
    cards: [{
      title: 'Takeaway via chat online hoje',
      lines: [
        `Total: ${Number(row.total || 0)}`,
        `A aguardar staff: ${Number(row.pending_staff || 0)}`,
        `Aceites: ${Number(row.accepted || 0)}`,
        `Concluídos: ${Number(row.completed || 0)}`,
        `Rejeitados: ${Number(row.rejected || 0)}`,
        `Rascunhos/testes: ${Number(row.drafts || 0)}`,
      ],
    }],
  };
}

async function buildPaymentEmailStatsAnswer() {
  const row = await withClient(async (client) => {
    const result = await client.query(
      `select count(*)::int as invoices_total,
              count(*) filter (where tipo_pagamento = 'mbway')::int as mbway_invoices,
              coalesce(sum(total) filter (where tipo_pagamento = 'mbway'), 0)::numeric as mbway_total,
              count(*) filter (where nullif(cliente_email, '') is not null)::int as invoices_with_email,
              count(*) filter (where enviada_por_email_em is not null)::int as invoices_email_sent
         from public.faturas
        where created_at >= current_date
          and created_at < current_date + interval '1 day'`
    );
    return result.rows[0] || {};
  });
  const mbwayCount = Number(row.mbway_invoices || 0);
  const withEmail = Number(row.invoices_with_email || 0);
  const sent = Number(row.invoices_email_sent || 0);
  return {
    answer: `Hoje há ${mbwayCount} pagamento(s) por MB WAY (${euro(row.mbway_total)}). Fatura por email: nem todas; ${withEmail} fatura(s) têm email preenchido e ${sent} ficaram marcadas como enviadas.`,
    cards: [{
      title: 'Pagamentos e faturas por email hoje',
      lines: [
        `Faturas totais: ${Number(row.invoices_total || 0)}`,
        `MB WAY: ${mbwayCount} · ${euro(row.mbway_total)}`,
        `Com email do cliente: ${withEmail}`,
        `Marcadas como enviadas por email: ${sent}`,
      ],
    }],
  };
}

async function buildLastInvoiceWorkerAnswer() {
  const row = await withClient(async (client) => {
    const result = await client.query(
      `select f.id,
              coalesce(f.numero_documento, f.id) as number,
              f.created_at,
              f.total,
              f.tipo_pagamento,
              f.cliente_nome,
              f.cliente_email,
              coalesce(u.name, '—') as worker_name,
              u.email as worker_email
         from public.faturas f
         left join public.app_users u on u.id = f.quem_faturou_id
        order by f.created_at desc
        limit 1`
    );
    return result.rows[0] || null;
  });
  if (!row) return { answer: 'Ainda não encontrei faturas registadas.', cards: [] };
  return {
    answer: `A última fatura foi registada por ${row.worker_name || '—'}.`,
    cards: [{
      title: 'Última fatura',
      lines: [
        `Documento: ${row.number}`,
        `Trabalhador: ${row.worker_name || '—'}`,
        `Total: ${euro(row.total)}`,
        `Pagamento: ${row.tipo_pagamento || '—'}`,
        `Cliente: ${row.cliente_nome || '—'}`,
        `Email cliente: ${row.cliente_email || 'não indicado'}`,
        `Data: ${row.created_at ? new Date(row.created_at).toLocaleString('pt-PT') : '—'}`,
      ],
    }],
  };
}

async function buildDishActionAnswer(message, desiredActive) {
  const target = extractDishTarget(message, desiredActive);
  if (!target || /^(este|esta|isso|esse|essa|prato|artigo)$/i.test(target)) {
    return {
      answer: `Diz-me o nome do prato que queres ${desiredActive ? 'ativar' : 'desativar/sem stock'}. Ex.: “${desiredActive ? 'Ativar' : 'Desativar'} arroz de pato”.`,
      cards: [],
    };
  }
  const found = await findDishForAction(target, desiredActive);
  if (!found.match) {
    return {
      answer: found.ambiguous
        ? `Encontrei várias hipóteses para “${target}”. Escreve o nome mais completo.`
        : `Não encontrei nenhum prato suficientemente parecido com “${target}”.`,
      cards: found.candidates?.length ? [{ title: 'Hipóteses próximas', lines: found.candidates }] : [],
    };
  }
  const item = found.match;
  const already = desiredActive ? item.active !== false : item.active === false;
  if (already) {
    return {
      answer: `${item.name} já está ${desiredActive ? 'ativo/com stock' : 'desativado/sem stock'}.`,
      cards: [{ title: 'Prato encontrado', lines: [`${item.name} · ${item.category || 'Sem categoria'}`] }],
    };
  }
  return {
    answer: `Vou preparar a alteração, mas preciso de confirmação. ${desiredActive ? 'Ativar' : 'Desativar/sem stock'} “${item.name}”?`,
    pending_action: {
      type: 'set_menu_item_active',
      item_id: item.id,
      item_name: item.name,
      active: desiredActive,
      label: `${desiredActive ? 'Ativar' : 'Desativar'} ${item.name}`,
      warning: desiredActive
        ? 'O prato volta a aparecer nos menus onde estiver configurado.'
        : 'O prato sai dos menus e deixa de aparecer para adicionar em mesas/bar/takeaway.',
    },
    cards: [{ title: 'Alteração proposta', lines: [`Prato: ${item.name}`, `Categoria: ${item.category || 'Sem categoria'}`, `Novo estado: ${desiredActive ? 'ativo/com stock' : 'desativado/sem stock'}`] }],
  };
}

function helpAnswer() {
  return {
    answer: 'Pergunta-me pelo estado do restaurante, menus, mesas, pagamentos, takeaways, faturas ou stock dos pratos. Alterações críticas ficam sempre à espera da tua confirmação.',
    cards: [{ title: 'Sugestões de perguntas', lines: SUGGESTIONS }],
  };
}

export const ownerAssistantService = {
  async handleMessage({ message = '' } = {}) {
    const intent = inferIntent(message);
    let payload;
    if (intent === 'active_today') payload = await buildActiveTodayAnswer();
    else if (intent === 'inactive_items') payload = await buildInactiveItemsAnswer();
    else if (intent === 'open_tables') payload = await buildOpenTablesAnswer();
    else if (intent === 'top_sold_items') payload = await buildTopSoldItemsAnswer();
    else if (intent === 'takeaway_chat_stats') payload = await buildTakeawayChatStatsAnswer();
    else if (intent === 'payment_email_stats') payload = await buildPaymentEmailStatsAnswer();
    else if (intent === 'last_invoice_worker') payload = await buildLastInvoiceWorkerAnswer();
    else if (intent === 'activate_item') payload = await buildDishActionAnswer(message, true);
    else if (intent === 'deactivate_item') payload = await buildDishActionAnswer(message, false);
    else payload = helpAnswer();

    return {
      ok: true,
      intent,
      answer: payload.answer,
      cards: payload.cards || [],
      pending_action: payload.pending_action || null,
      suggestions: SUGGESTIONS,
      source: 'backend_rules_safe_assistant',
    };
  },

  async confirmAction({ action = {}, operator_id = null, terminal_id = 'terminal_main' } = {}) {
    if (!action || action.type !== 'set_menu_item_active') {
      const error = new Error('Ação inválida ou expirada. Pede novamente ao assistente.');
      error.statusCode = 400;
      error.code = 'invalid_assistant_action';
      throw error;
    }
    if (!action.item_id) {
      const error = new Error('Prato obrigatório para confirmar ação.');
      error.statusCode = 400;
      error.code = 'assistant_action_missing_item';
      throw error;
    }
    const result = await restaurantStore.updateMenuItem({
      menu_item_id: action.item_id,
      active: Boolean(action.active),
      operator_id,
      terminal_id,
    });
    const item = result?.item || null;
    return {
      ok: true,
      answer: item
        ? `${item.name} ficou ${item.active !== false ? 'ativo/com stock' : 'desativado/sem stock'}.`
        : `Estado do prato atualizado.`,
      item,
      suggestions: SUGGESTIONS,
    };
  },
};
