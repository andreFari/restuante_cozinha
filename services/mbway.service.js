import crypto from 'crypto';
import https from 'https';
import soap from 'soap';

function providerMode() {
  return String(process.env.MBWAY_PROVIDER || 'mock').trim().toLowerCase();
}

function parseJsonEnv(name, fallback = {}) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function buildMockReference(prefix = 'mbw') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.startsWith('351')) return `351#${digits.slice(3)}`;
  if (digits.length === 9) return `351#${digits}`;
  return digits;
}

function normalizeCustomerPhone(value) {
  return String(value || '').replace(/\D+/g, '');
}

function fillUrlTemplate(template, values = {}) {
  let next = String(template || '');
  for (const [key, value] of Object.entries(values)) {
    next = next.replaceAll(`{${key}}`, encodeURIComponent(String(value ?? '')));
  }
  return next;
}

function roundAmount(amount) {
  const numeric = Number(amount || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.round(numeric * 100) / 100;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

async function httpJson(url, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const rawText = await response.text();
  let data = null;
  if (rawText) {
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { raw: rawText };
    }
  }

  if (!response.ok) {
    const error = new Error(
      data?.detail ||
      data?.message ||
      data?.error ||
      data?.errors?.[0]?.message ||
      data?.status?.message ||
      `HTTP ${response.status}`
    );
    error.statusCode = response.status;
    error.payload = data;
    throw error;
  }

  return data || {};
}

function getHttpConfig() {
  return {
    createUrl: process.env.MBWAY_CREATE_URL || '',
    statusUrl: process.env.MBWAY_STATUS_URL || '',
    cancelUrl: process.env.MBWAY_CANCEL_URL || '',
    headers: parseJsonEnv('MBWAY_HTTP_HEADERS', {}),
    createMethod: String(process.env.MBWAY_CREATE_METHOD || 'POST').toUpperCase(),
    statusMethod: String(process.env.MBWAY_STATUS_METHOD || 'GET').toUpperCase(),
    cancelMethod: String(process.env.MBWAY_CANCEL_METHOD || 'POST').toUpperCase(),
    channel: process.env.MBWAY_CHANNEL || 'web',
    terminalId: Number(process.env.MBWAY_TERMINAL_ID || 0) || undefined,
  };
}

function getEupagoConfig() {
  const apiKey = String(process.env.EUPAGO_API_KEY || '').trim();
  const isDemo = apiKey.toLowerCase().startsWith('demo-');

  return {
    apiKey,
    isDemo,
    wsdlUrl:
      String(process.env.EUPAGO_MBWAY_WSDL_URL || '').trim() ||
      (isDemo
        ? 'https://sandbox.eupago.pt/replica.eupagov20.wsdl'
        : 'https://clientes.eupago.pt/eupagov20.wsdl'),
    adminCallback: String(
      process.env.EUPAGO_ADMIN_CALLBACK || process.env.EUPAGO_WEBHOOK_URL || ''
    ).trim(),
    allowInsecureTls:
      String(process.env.EUPAGO_SOAP_DISABLE_SSL_VERIFY || '').trim().toLowerCase() === 'true',
  };
}
function deriveMockStatus(reference) {
  const force = String(process.env.MBWAY_MOCK_FORCE_STATUS || '').trim().toLowerCase();
  if (['confirmed', 'paid', 'failed', 'cancelled', 'expired', 'pending'].includes(force)) return force;
  const normalized = String(reference || '').toLowerCase();
  if (normalized.includes('paid') || normalized.includes('ok')) return 'confirmed';
  if (normalized.includes('cancel')) return 'cancelled';
  if (normalized.includes('fail')) return 'failed';
  if (normalized.includes('exp')) return 'expired';
  return 'pending';
}

function mapExternalStatus(raw) {
  const normalized = String(raw || '').trim().toLowerCase();
  if (!normalized) return 'pending';
  if (['paid', 'success', 'succeeded', 'confirmed', 'approved', 'authorised', 'authorized', 'completed', 'ok'].includes(normalized)) return 'confirmed';
  if (['pending', 'processing', 'waiting', 'awaiting_confirmation', 'awaiting_customer', 'created', 'initiated', 'requested'].includes(normalized)) return 'pending';
  if (['cancelled', 'canceled', 'voided', 'cancel'].includes(normalized)) return 'cancelled';
  if (['expired', 'timeout', 'timed_out'].includes(normalized)) return 'expired';
  if (['failed', 'rejected', 'denied', 'error'].includes(normalized)) return 'failed';
  if (['refunded', 'refund'].includes(normalized)) return 'failed';
  return 'pending';
}

function buildEupagoSoapClientOptions(config) {
  if (!config.allowInsecureTls) {
    return {};
  }

  const agent = new https.Agent({
    rejectUnauthorized: false,
    checkServerIdentity: () => undefined,
  });

  return {
    wsdl_options: {
      agent,
      httpsAgent: agent,
      rejectUnauthorized: false,
      strictSSL: false,
    },
  };
}

function normalizeSoapResult(result) {
  if (Array.isArray(result)) {
    return result[0] || {};
  }
  return result || {};
}

async function createEupagoPayment({ amount, phone, merchantTransactionId }) {
  const config = getEupagoConfig();

  if (!config.apiKey || !config.wsdlUrl) {
    throw new Error('euPago sem configuração. Define EUPAGO_API_KEY.');
  }

  const alias = normalizeCustomerPhone(phone);
  if (!alias || alias.length < 9) {
    const error = new Error('Contacto MB WAY inválido para euPago.');
    error.statusCode = 400;
    error.code = 'invalid_mbway_phone';
    throw error;
  }

  console.log('[eupago-soap] wsdlUrl:', config.wsdlUrl);
  console.log('[eupago-soap] apiKey loaded:', Boolean(config.apiKey));
  console.log('[eupago-soap] apiKey prefix:', config.apiKey ? `${config.apiKey.slice(0, 6)}...` : '(empty)');
  console.log('[eupago-soap] insecureTls:', config.allowInsecureTls);
  console.log('[eupago-soap] request:', {
    chave: config.apiKey ? `${config.apiKey.slice(0, 6)}...` : '',
    valor: roundAmount(amount),
    id: merchantTransactionId,
    alias,
  });

  try {
    const client = await soap.createClientAsync(
      config.wsdlUrl,
      buildEupagoSoapClientOptions(config)
    );

    const request = {
      chave: config.apiKey,
      valor: roundAmount(amount),
      id: merchantTransactionId,
      alias,
    };

    const raw = await client.pedidoMBWAsync(request);
    const result = normalizeSoapResult(raw);

    const rawStatus = firstDefined(
      result?.estado,
      result?.resposta,
      result?.status,
      result?.resultado,
      'PENDING'
    );

    const providerReference = firstDefined(
      result?.referencia,
      result?.pedido,
      result?.transacao,
      result?.id,
      merchantTransactionId
    );

    return {
      ok: true,
      provider: 'eupago',
      provider_reference: String(providerReference || merchantTransactionId),
      merchant_reference: merchantTransactionId,
      status: mapExternalStatus(rawStatus),
      raw_status: String(rawStatus || 'PENDING'),
      amount: roundAmount(amount),
      phone: alias,
      response_payload: {
        response: result,
      },
    };
  } catch (error) {
    const message = String(error?.message || 'Erro SOAP euPago');
    if (message.includes('altnames') || message.includes('certificate')) {
      error.statusCode = error.statusCode || 502;
      error.payload = {
        ...(error.payload || {}),
        message,
        hint: 'Ativa EUPAGO_SOAP_DISABLE_SSL_VERIFY=true para sandbox/demo. Não uses isto em produção.',
      };
    }
    throw error;
  }
}

async function getEupagoPaymentStatus({ provider_reference }) {
  return {
    ok: true,
    provider: 'eupago',
    provider_reference,
    status: 'pending',
    raw_status: 'WEBHOOK_PENDING',
    response_payload: {
      provider_reference,
      message: 'Confirmação dependente do webhook euPago.',
    },
  };
}

async function cancelEupagoPayment({ provider_reference }) {
  return {
    ok: true,
    provider: 'eupago',
    provider_reference,
    status: 'cancelled',
    raw_status: 'CANCELLED_LOCAL_ONLY',
    response_payload: {
      provider_reference,
      message: 'Cancelamento remoto não implementado neste primeiro passo.',
    },
  };
}

export const mbwayService = {
  isConfigured() {
    const mode = providerMode();
    if (mode === 'mock') return true;
    if (mode === 'eupago') {
      const config = getEupagoConfig();
      return Boolean(config.apiKey && config.wsdlUrl);
    }
    const config = getHttpConfig();
    return Boolean(config.createUrl && config.statusUrl);
  },

  async createPayment({ amount, phone, merchantTransactionId, metadata = {} }) {
    const mode = providerMode();

    if (mode === 'mock') {
      return {
        ok: true,
        provider: 'mock',
        provider_reference: buildMockReference('mbw_mock'),
        merchant_reference: merchantTransactionId,
        status: 'pending',
        raw_status: 'PENDING',
        amount: Number(amount || 0),
        phone: normalizePhone(phone),
        metadata,
      };
    }

    if (mode === 'eupago') {
      return createEupagoPayment({ amount, phone, merchantTransactionId, metadata });
    }

    const config = getHttpConfig();
    if (!config.createUrl || !config.statusUrl) {
      throw new Error('MB WAY HTTP provider sem URLs configuradas. Define MBWAY_CREATE_URL e MBWAY_STATUS_URL.');
    }

    const payload = {
      merchant: {
        terminalId: config.terminalId,
        channel: config.channel,
        merchantTransactionId,
      },
      customerPhone: normalizePhone(phone),
      amount: roundAmount(amount),
      metadata,
    };

    const data = await httpJson(config.createUrl, {
      method: config.createMethod,
      headers: config.headers,
      body: payload,
    });

    return {
      ok: true,
      provider: 'http',
      provider_reference: data?.transactionID || data?.transactionId || data?.id || merchantTransactionId,
      merchant_reference: merchantTransactionId,
      status: mapExternalStatus(data?.paymentStatus || data?.status || data?.transactionStatus),
      raw_status: data?.paymentStatus || data?.status || data?.transactionStatus || 'PENDING',
      amount: Number(amount || 0),
      phone: normalizePhone(phone),
      metadata,
      response_payload: data,
    };
  },

  async getPaymentStatus({ provider_reference }) {
    const mode = providerMode();

    if (mode === 'mock') {
      const status = deriveMockStatus(provider_reference);
      return {
        ok: true,
        provider: 'mock',
        provider_reference,
        status,
        raw_status: status.toUpperCase(),
        response_payload: { provider_reference, status },
      };
    }

    if (mode === 'eupago') {
      return getEupagoPaymentStatus({ provider_reference });
    }

    const config = getHttpConfig();
    if (!config.statusUrl) {
      throw new Error('MB WAY HTTP provider sem URL de estado configurada.');
    }

    const url = fillUrlTemplate(config.statusUrl, {
      provider_reference,
      transaction_id: provider_reference,
      id: provider_reference,
    });

    const data = await httpJson(url, {
      method: config.statusMethod,
      headers: config.headers,
    });

    return {
      ok: true,
      provider: 'http',
      provider_reference,
      status: mapExternalStatus(data?.paymentStatus || data?.status || data?.transactionStatus),
      raw_status: data?.paymentStatus || data?.status || data?.transactionStatus || 'PENDING',
      response_payload: data,
    };
  },

  async cancelPayment({ provider_reference }) {
    const mode = providerMode();

    if (mode === 'mock') {
      return {
        ok: true,
        provider: 'mock',
        provider_reference,
        status: 'cancelled',
        raw_status: 'CANCELLED',
      };
    }

    if (mode === 'eupago') {
      return cancelEupagoPayment({ provider_reference });
    }

    const config = getHttpConfig();
    if (!config.cancelUrl) {
      return {
        ok: true,
        provider: 'http',
        provider_reference,
        status: 'cancelled',
        raw_status: 'CANCELLED_LOCAL_ONLY',
      };
    }

    const url = fillUrlTemplate(config.cancelUrl, {
      provider_reference,
      transaction_id: provider_reference,
      id: provider_reference,
    });

    const data = await httpJson(url, {
      method: config.cancelMethod,
      headers: config.headers,
      body: { provider_reference },
    });

    return {
      ok: true,
      provider: 'http',
      provider_reference,
      status: mapExternalStatus(data?.paymentStatus || data?.status || data?.transactionStatus || 'cancelled'),
      raw_status: data?.paymentStatus || data?.status || data?.transactionStatus || 'CANCELLED',
      response_payload: data,
    };
  },
};
