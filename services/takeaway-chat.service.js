import { withClient, withTransaction } from '../src/db.js';

const APP_TIMEZONE = process.env.TZ || process.env.APP_TIMEZONE || 'Europe/Lisbon';
process.env.TZ = APP_TIMEZONE;

const ACTIVE_STATUSES = ['pending_staff_confirmation', 'confirmed_by_staff'];
const FINAL_STATUSES = ['rejected_by_staff', 'cancelled_by_customer', 'completed'];
const STAFF_ALLOWED_STATUSES = new Set([...ACTIVE_STATUSES, ...FINAL_STATUSES]);

let schemaReady = false;

function makeError(message, statusCode = 400, code = 'takeaway_chat_error') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function safeText(value, max = 4000) {
  return String(value ?? '').replace(/\s+$/g, '').slice(0, max);
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function normalizePhone(value) {
  const raw = String(value || '').trim();
  const compact = raw.replace(/[^+\d]+/g, '');
  if (!compact) return '';
  const digits = compact.replace(/\D+/g, '');
  if (digits.length < 9 || digits.length > 15) return raw.slice(0, 40);
  if (compact.startsWith('+')) return `+${digits}`;
  if (digits.length === 9 && digits.startsWith('9')) return `+351${digits}`;
  return compact;
}

function extractPhone(text) {
  const raw = String(text || '');
  const match = raw.match(/(?:\+\d{1,3}[\s.-]*)?(?:\d[\s.-]*){9,14}/);
  return normalizePhone(match?.[0] || '');
}

function looksLikeYes(text) {
  const normalized = normalizeText(text);
  return /^(sim|s|confirmo|confirmar|ok|okay|certo|pode ser|esta certo|isso)$/i.test(normalized);
}

function looksLikeNo(text) {
  const normalized = normalizeText(text);
  return /^(nao|não|n|cancelar|cancela|errado|alterar|mudar)$/i.test(normalized);
}

function extractName(text) {
  const clean = safeText(text, 120).trim();
  const normalized = normalizeText(clean);
  const prefixed = clean.match(/(?:chamo-me|sou|nome(?:\s+e|\s+é)?|em nome de)\s+(.+)/i);
  const candidate = (prefixed?.[1] || clean).replace(/[.!?]+$/g, '').trim();
  if (!candidate || extractPhone(candidate)) return '';
  if (normalizeText(candidate).split(/\s+/).length > 6) return '';
  if (/\b(dose|doses|prato|pratos|sopa|arroz|batata|levantar|takeaway|encomenda|hoje|amanha|amanhã)\b/i.test(normalized)) return '';
  return candidate.slice(0, 120);
}

function parsePickupAt(text, now = new Date()) {
  const raw = String(text || '');
  const normalized = normalizeText(raw);
  const timeMatch = normalized.match(/(?:as|às|para|pelas|\b)(?:\s*)(\d{1,2})(?:[:h](\d{2}))?/i);
  if (!timeMatch) return null;

  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2] || 0);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  const date = new Date(now);
  date.setSeconds(0, 0);

  if (/\bamanha\b/.test(normalized)) {
    date.setDate(date.getDate() + 1);
  } else {
    const weekdayMap = [
      ['domingo', 0],
      ['segunda', 1],
      ['terca', 2],
      ['terça', 2],
      ['quarta', 3],
      ['quinta', 4],
      ['sexta', 5],
      ['sabado', 6],
      ['sábado', 6],
    ];
    const target = weekdayMap.find(([name]) => normalized.includes(normalizeText(name)));
    if (target) {
      const current = date.getDay();
      const wanted = Number(target[1]);
      let delta = wanted - current;
      if (delta <= 0) delta += 7;
      date.setDate(date.getDate() + delta);
    }
  }

  date.setHours(hour, minute, 0, 0);
  if (!/\b(hoje|amanha|domingo|segunda|terca|terça|quarta|quinta|sexta|sabado|sábado)\b/.test(normalized) && date.getTime() + 60 * 60 * 1000 < now.getTime()) {
    date.setDate(date.getDate() + 1);
  }
  return date;
}

function extractPickupText(text) {
  const raw = safeText(text, 500).trim();
  if (!raw) return '';
  const normalized = normalizeText(raw);
  if (/\b(hoje|amanha|amanhã|domingo|segunda|terca|terça|quarta|quinta|sexta|sabado|sábado|levantar|recolher|buscar|apanhar)\b/.test(normalized)) return raw;
  if (/\b\d{1,2}[:h]\d{2}\b/.test(normalized)) return raw;
  return '';
}

function extractItemsText(text) {
  const raw = safeText(text, 2500).trim();
  if (!raw) return '';
  const lines = raw
    .split(/\n|\r|\.|;|,/)
    .map((line) => line.trim())
    .filter(Boolean);

  const itemLines = lines.filter((line) => {
    const normalized = normalizeText(line);
    if (/^(bom dia|boa tarde|boa noite|ola|olá|obrigado|obrigada|sim|nao|não)$/.test(normalized)) return false;
    if (/\b(gostava|queria|pretendo|possivel|possível|encomenda|takeaway|levar)\b/.test(normalized) && !/\b(dose|doses|prato|salmao|salmão|dourada|bacalhau|bife|sopa|arroz|batata|salada)\b/.test(normalized)) return false;
    if (extractPickupText(line) && !/\b(dose|doses|prato|salmao|salmão|dourada|bacalhau|bife|sopa|arroz|batata|salada)\b/.test(normalized)) return false;
    if (extractPhone(line)) return false;
    return /\b(\d+|uma|um|duas|dois|tres|três|dose|doses|prato|menu|sopa|arroz|batata|salada|carne|peixe|salmao|salmão|dourada|bacalhau|bife|frango|hamburguer|hambúrguer)\b/.test(normalized);
  });

  return itemLines.join('\n').slice(0, 2500);
}

function mergeDraftFromMessage(draft, message, stage) {
  const next = { ...(draft || {}) };
  const text = safeText(message, 4000).trim();
  const phone = extractPhone(text);
  const pickupText = extractPickupText(text);
  const pickupAt = parsePickupAt(text);

  if (phone && !next.customer_phone) next.customer_phone = phone;
  if (pickupText && !next.pickup_text) next.pickup_text = pickupText;
  if (pickupAt && !next.pickup_at) next.pickup_at = pickupAt.toISOString();

  if (stage === 'ask_name') {
    const name = extractName(text);
    if (name) next.customer_name = name;
  } else if (stage === 'ask_phone') {
    if (phone) next.customer_phone = phone;
  } else if (stage === 'ask_pickup') {
    next.pickup_text = pickupText || text;
    if (pickupAt) next.pickup_at = pickupAt.toISOString();
  } else if (stage === 'ask_items') {
    const itemsText = extractItemsText(text);
    if (itemsText) next.items_text = itemsText;
  } else {
    const maybeName = extractName(text);
    const itemsText = extractItemsText(text);
    if (itemsText && (!next.items_text || itemsText.length > String(next.items_text || '').length)) next.items_text = itemsText;
    if (maybeName && !next.customer_name) next.customer_name = maybeName;
  }

  return next;
}

function nextStageForDraft(draft) {
  if (!String(draft?.items_text || '').trim()) return 'ask_items';
  if (!String(draft?.pickup_text || '').trim()) return 'ask_pickup';
  if (!String(draft?.customer_name || '').trim()) return 'ask_name';
  if (!String(draft?.customer_phone || '').trim()) return 'ask_phone';
  return 'confirm';
}

function formatPickupForSummary(draft) {
  if (draft?.pickup_at) {
    const date = new Date(draft.pickup_at);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleString('pt-PT', { timeZone: APP_TIMEZONE, dateStyle: 'short', timeStyle: 'short' });
    }
  }
  return String(draft?.pickup_text || '—');
}

function buildAssistantMessage(stage, draft) {
  if (stage === 'ask_items') {
    return 'Claro! Fazemos take-away com todo o gosto. 🛍️\n\nQuais os pratos e número de doses que pretende encomendar?';
  }
  if (stage === 'ask_pickup') {
    return 'Anotado! 📝\n\nPara que dia e hora pretende levantar a encomenda?\nEx: hoje às 12h30, amanhã às 13h ou sexta às 19h30.';
  }
  if (stage === 'ask_name') {
    return 'Perfeito! 👍\n\nQual é o seu nome para a encomenda?';
  }
  if (stage === 'ask_phone') {
    return 'Só falta o contacto. 📱\n\nQual é o número de telefone para a equipa confirmar a disponibilidade?';
  }
  if (stage === 'confirm') {
    return `✅ Resumo da encomenda:\n\n🍽️ Pratos:\n${String(draft.items_text || '—').trim()}\n\n📅 Data/hora: ${formatPickupForSummary(draft)}\n👤 Nome: ${String(draft.customer_name || '—').trim()}\n📱 Telefone: ${String(draft.customer_phone || '—').trim()}\n\nConfirma esta encomenda? Responde "sim" para confirmar ou "não" para cancelar.`;
  }
  if (stage === 'submitted') {
    return 'Encomenda registada! 🎉\n\nA nossa equipa irá confirmar a disponibilidade e entrar em contacto consigo brevemente.\n\nObrigado! 😊';
  }
  if (stage === 'cancelled') {
    return 'Sem problema. A encomenda foi cancelada. Pode escrever uma nova mensagem para começar de novo.';
  }
  return 'Não consegui perceber. Pode repetir, por favor?';
}

function mapOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    customer_name: row.customer_name || '',
    customer_phone: row.customer_phone || '',
    items_text: row.items_text || '',
    pickup_text: row.pickup_text || '',
    pickup_at: row.pickup_at || null,
    staff_notes: row.staff_notes || '',
    ai_provider: row.ai_provider || 'rules',
    created_at: row.created_at,
    updated_at: row.updated_at,
    accepted_at: row.accepted_at || null,
    rejected_at: row.rejected_at || null,
    completed_at: row.completed_at || null,
    message_count: Array.isArray(row.conversation_json) ? row.conversation_json.length : Number(row.message_count || 0),
    conversation: row.conversation_json || [],
  };
}

async function ensureSchema(client) {
  if (schemaReady) return;
  await client.query(`create table if not exists public.takeaway_chat_orders (
    id text primary key default fn_uuid(),
    status text not null default 'draft',
    customer_name text,
    customer_phone text,
    items_text text,
    pickup_text text,
    pickup_at timestamptz,
    source text not null default 'web_chat',
    conversation_json jsonb not null default '[]'::jsonb,
    ai_provider text not null default 'rules',
    staff_notes text,
    accepted_by_user_id text null references public.app_users(id),
    accepted_at timestamptz,
    rejected_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`);
  await client.query(`alter table public.takeaway_chat_orders add column if not exists status text not null default 'draft'`);
  await client.query(`alter table public.takeaway_chat_orders add column if not exists customer_name text`);
  await client.query(`alter table public.takeaway_chat_orders add column if not exists customer_phone text`);
  await client.query(`alter table public.takeaway_chat_orders add column if not exists items_text text`);
  await client.query(`alter table public.takeaway_chat_orders add column if not exists pickup_text text`);
  await client.query(`alter table public.takeaway_chat_orders add column if not exists pickup_at timestamptz`);
  await client.query(`alter table public.takeaway_chat_orders add column if not exists source text not null default 'web_chat'`);
  await client.query(`alter table public.takeaway_chat_orders add column if not exists conversation_json jsonb not null default '[]'::jsonb`);
  await client.query(`alter table public.takeaway_chat_orders add column if not exists ai_provider text not null default 'rules'`);
  await client.query(`alter table public.takeaway_chat_orders add column if not exists staff_notes text`);
  await client.query(`alter table public.takeaway_chat_orders add column if not exists accepted_by_user_id text null references public.app_users(id)`);
  await client.query(`alter table public.takeaway_chat_orders add column if not exists accepted_at timestamptz`);
  await client.query(`alter table public.takeaway_chat_orders add column if not exists rejected_at timestamptz`);
  await client.query(`alter table public.takeaway_chat_orders add column if not exists completed_at timestamptz`);
  await client.query(`alter table public.takeaway_chat_orders add column if not exists created_at timestamptz not null default now()`);
  await client.query(`alter table public.takeaway_chat_orders add column if not exists updated_at timestamptz not null default now()`);
  await client.query(`create index if not exists idx_takeaway_chat_orders_status_updated on public.takeaway_chat_orders(status, updated_at desc)`);
  await client.query(`create index if not exists idx_takeaway_chat_orders_pickup_at on public.takeaway_chat_orders(pickup_at) where pickup_at is not null`);
  schemaReady = true;
}

const AI_EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items_text: { type: 'string' },
    pickup_text: { type: 'string' },
    customer_name: { type: 'string' },
    customer_phone: { type: 'string' },
    confirmation: { type: 'string', enum: ['yes', 'no', 'unknown'] },
  },
  required: ['items_text', 'pickup_text', 'customer_name', 'customer_phone', 'confirmation'],
};

const FOOD_ITEM_SIGNAL_RE = /\b(\d+|uma|um|duas|dois|tres|três|dose|doses|meia|prato|pratos|menu|menus|sopa|arroz|batata|salada|carne|peixe|salmao|salmão|dourada|bacalhau|bife|frango|hamburguer|hambúrguer|bitoque|prego|francesinha|lasanha|massa|pizza|cozido|feijoada|picanha|posta|robalo|filete|polvo|lulas|panado|panados|costeleta|costeletas|febras|entremeada|alheira|omelete)\b/i;
const GENERIC_TAKEAWAY_INTENT_RE = /\b(queria|gostava|pretendo|posso|podia|pode|possivel|possível|fazer|encomendar|encomenda|pedido|takeaway|take away|levar|comida)\b/i;

function isGenericTakeawayIntent(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  const hasGenericIntent = GENERIC_TAKEAWAY_INTENT_RE.test(normalized);
  const hasItemSignal = FOOD_ITEM_SIGNAL_RE.test(normalized);
  return hasGenericIntent && !hasItemSignal;
}

function isOnlyGreetingOrAck(text) {
  const normalized = normalizeText(text);
  return /^(bom dia|boa tarde|boa noite|ola|olá|obrigado|obrigada|sim|s|nao|não|ok|okay|certo)$/i.test(normalized);
}

function isValidAiItemsText(value, stage = '') {
  const candidate = safeText(value, 2500).trim();
  if (!candidate) return false;
  if (isOnlyGreetingOrAck(candidate)) return false;
  if (isGenericTakeawayIntent(candidate)) return false;
  if (extractPhone(candidate)) return false;
  if (extractPickupText(candidate) && !FOOD_ITEM_SIGNAL_RE.test(normalizeText(candidate))) return false;
  if (FOOD_ITEM_SIGNAL_RE.test(normalizeText(candidate))) return true;

  const words = normalizeText(candidate).split(/\s+/).filter(Boolean);
  if (stage === 'ask_items' && words.length >= 2 && words.length <= 18 && !extractName(candidate)) return true;
  return false;
}

function parseAiJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

async function callOllamaExtractor(message, draft, stage) {
  if (process.env.TAKEAWAY_AI_ENABLED !== 'true') return null;
  const baseUrl = String(process.env.TAKEAWAY_OLLAMA_URL || process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const model = process.env.TAKEAWAY_OLLAMA_MODEL || process.env.OLLAMA_MODEL || 'qwen3:1.7b';
  const timeoutMs = Math.max(800, Number(process.env.TAKEAWAY_AI_TIMEOUT_MS || 2500));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const prompt = [
      'És um extrator de dados para chat de takeaway de restaurante em Portugal.',
      'Tarefa: ler UMA mensagem do cliente e devolver apenas JSON válido.',
      'Nunca inventes pratos, nomes, datas, horas ou telefones.',
      'Mensagens genéricas como "queria encomendar takeaway", "queria fazer uma encomenda" ou cumprimentos NÃO são pratos.',
      'Só coloca items_text quando existir comida/prato/dose/menu explícito.',
      'Só coloca pickup_text quando existir dia/hora/recolha explícita.',
      'Só coloca customer_phone quando existir telefone.',
      'Só coloca customer_name quando existir nome claro do cliente.',
      'confirmation deve ser yes, no ou unknown.',
      '',
      `Etapa atual: ${stage || 'unknown'}`,
      `Draft atual: ${JSON.stringify(draft || {})}`,
      `Mensagem do cliente: ${JSON.stringify(message)}`,
    ].join('\n');

    const response = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        format: AI_EXTRACTION_SCHEMA,
        think: false,
        options: {
          temperature: 0,
          num_predict: 180,
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    return parseAiJson(data?.response);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function mergeAiDraft(draft, ai, stage = '') {
  if (!ai || typeof ai !== 'object') return draft;
  const next = { ...draft };

  const aiItems = safeText(ai.items_text, 2500).trim();
  if (aiItems && !next.items_text && isValidAiItemsText(aiItems, stage)) {
    next.items_text = aiItems;
  }

  const aiPickup = safeText(ai.pickup_text, 500).trim();
  if (aiPickup && !next.pickup_text && (extractPickupText(aiPickup) || parsePickupAt(aiPickup))) {
    next.pickup_text = aiPickup;
    const pickupAt = parsePickupAt(aiPickup);
    if (pickupAt) next.pickup_at = pickupAt.toISOString();
  }

  const aiName = safeText(ai.customer_name, 120).trim();
  if (aiName && !next.customer_name) {
    const name = extractName(aiName);
    if (name) next.customer_name = name;
  }

  const aiPhone = normalizePhone(ai.customer_phone);
  if (aiPhone && !next.customer_phone && extractPhone(aiPhone)) {
    next.customer_phone = aiPhone;
  }

  return next;
}

export const takeawayChatService = {
  async handleCustomerMessage({ conversation_id = null, message = '' }) {
    const cleanMessage = safeText(message, 4000).trim();
    if (!cleanMessage) throw makeError('Mensagem vazia.', 400, 'empty_message');

    return withTransaction(async (client) => {
      await ensureSchema(client);

      let row = null;
      if (conversation_id) {
        const existing = await client.query(`select * from public.takeaway_chat_orders where id = $1`, [conversation_id]);
        row = existing.rows[0] || null;
      }

      if (!row || FINAL_STATUSES.includes(row.status)) {
        const inserted = await client.query(
          `insert into public.takeaway_chat_orders(status, conversation_json, ai_provider)
           values ('draft', '[]'::jsonb, $1)
           returning *`,
          [process.env.TAKEAWAY_AI_ENABLED === 'true' ? 'ollama_optional' : 'rules']
        );
        row = inserted.rows[0];
      }

      const conversation = Array.isArray(row.conversation_json) ? [...row.conversation_json] : [];
      const draft = {
        items_text: row.items_text || '',
        pickup_text: row.pickup_text || '',
        pickup_at: row.pickup_at ? new Date(row.pickup_at).toISOString() : '',
        customer_name: row.customer_name || '',
        customer_phone: row.customer_phone || '',
      };

      const currentStage = nextStageForDraft(draft);
      let nextDraft = mergeDraftFromMessage(draft, cleanMessage, currentStage);
      const aiExtraction = await callOllamaExtractor(cleanMessage, nextDraft, currentStage);
      nextDraft = mergeAiDraft(nextDraft, aiExtraction, currentStage);

      let nextStatus = row.status || 'draft';
      let nextStage = nextStageForDraft(nextDraft);
      let assistantMessage = buildAssistantMessage(nextStage, nextDraft);

      if (currentStage === 'confirm') {
        if (looksLikeYes(cleanMessage)) {
          nextStatus = 'pending_staff_confirmation';
          nextStage = 'submitted';
          assistantMessage = buildAssistantMessage('submitted', nextDraft);
        } else if (looksLikeNo(cleanMessage)) {
          nextStatus = 'cancelled_by_customer';
          nextStage = 'cancelled';
          assistantMessage = buildAssistantMessage('cancelled', nextDraft);
        } else {
          nextStage = 'confirm';
          assistantMessage = buildAssistantMessage('confirm', nextDraft);
        }
      } else if (looksLikeNo(cleanMessage) && conversation.length > 0) {
        nextStatus = 'cancelled_by_customer';
        nextStage = 'cancelled';
        assistantMessage = buildAssistantMessage('cancelled', nextDraft);
      }

      const nextConversation = [
        ...conversation,
        { role: 'customer', body: cleanMessage, created_at: new Date().toISOString() },
        { role: 'assistant', body: assistantMessage, created_at: new Date().toISOString(), stage: nextStage },
      ].slice(-80);

      const updated = await client.query(
        `update public.takeaway_chat_orders
            set status = $2,
                customer_name = nullif($3, ''),
                customer_phone = nullif($4, ''),
                items_text = nullif($5, ''),
                pickup_text = nullif($6, ''),
                pickup_at = $7::timestamptz,
                conversation_json = $8::jsonb,
                ai_provider = $9,
                updated_at = now()
          where id = $1
          returning *`,
        [
          row.id,
          nextStatus,
          safeText(nextDraft.customer_name, 120).trim(),
          normalizePhone(nextDraft.customer_phone),
          safeText(nextDraft.items_text, 2500).trim(),
          safeText(nextDraft.pickup_text, 500).trim(),
          nextDraft.pickup_at || null,
          JSON.stringify(nextConversation),
          aiExtraction ? 'ollama_optional' : (row.ai_provider || 'rules'),
        ]
      );

      return {
        conversation_id: updated.rows[0].id,
        status: updated.rows[0].status,
        stage: nextStage,
        assistant_message: assistantMessage,
        draft: {
          items_text: updated.rows[0].items_text || '',
          pickup_text: updated.rows[0].pickup_text || '',
          pickup_at: updated.rows[0].pickup_at || null,
          customer_name: updated.rows[0].customer_name || '',
          customer_phone: updated.rows[0].customer_phone || '',
        },
      };
    });
  },

  async listOrders({ status = 'active' } = {}) {
    return withClient(async (client) => {
      await ensureSchema(client);
      let whereSql = `where created_at >= now() - interval '30 days'`;
      const params = [];
      const normalizedStatus = String(status || 'active').trim();

      if (normalizedStatus === 'active') {
        whereSql = `where status = any($1::text[])`;
        params.push(ACTIVE_STATUSES);
      } else if (normalizedStatus !== 'all') {
        whereSql = `where status = $1`;
        params.push(normalizedStatus);
      }

      const result = await client.query(
        `select *, jsonb_array_length(coalesce(conversation_json, '[]'::jsonb)) as message_count
           from public.takeaway_chat_orders
          ${whereSql}
          order by
            case status when 'pending_staff_confirmation' then 0 when 'confirmed_by_staff' then 1 else 2 end,
            coalesce(pickup_at, updated_at) asc,
            updated_at desc`,
        params
      );
      return { orders: result.rows.map(mapOrder) };
    });
  },

  async updateOrderStatus({ order_id, status, operator_id = '', staff_notes = '' }) {
    const nextStatus = String(status || '').trim();
    if (!STAFF_ALLOWED_STATUSES.has(nextStatus)) throw makeError('Estado inválido.', 400, 'invalid_takeaway_status');

    return withTransaction(async (client) => {
      await ensureSchema(client);
      const result = await client.query(
        `update public.takeaway_chat_orders
            set status = $2,
                staff_notes = coalesce(nullif($3, ''), staff_notes),
                accepted_by_user_id = case when $2 = 'confirmed_by_staff' then nullif($4, '') else accepted_by_user_id end,
                accepted_at = case when $2 = 'confirmed_by_staff' then now() else accepted_at end,
                rejected_at = case when $2 = 'rejected_by_staff' then now() else rejected_at end,
                completed_at = case when $2 = 'completed' then now() else completed_at end,
                updated_at = now()
          where id = $1
          returning *`,
        [order_id, nextStatus, safeText(staff_notes, 1000).trim(), String(operator_id || '').trim()]
      );
      if (!result.rows[0]) throw makeError('Encomenda não encontrada.', 404, 'takeaway_order_not_found');
      return { order: mapOrder(result.rows[0]) };
    });
  },
};

export async function ensureTakeawayChatSchema() {
  return withClient((client) => ensureSchema(client));
}
