import axios from "axios";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import { URLSearchParams } from "url"; // necessário em ambientes Node
import morgan from "morgan";
import express from "express";
import qs from "qs"; // ✅ garante que tens esta linha no topo do ficheiro

/**
 * Servidor Express para integrar com a API Moloni
 * - OAuth: troca de code por tokens no /callback
 * - Refresh automático do access_token
 * - /api/emitir-fatura: cria fatura e devolve link do PDF
 * - /api/moloni-companies: lista empresas (para identificar company_id)
 *
 * Variáveis de ambiente necessárias (.env):
 *   PORT=3000
 *   CLIENT_ID=...
 *   CLIENT_SECRET=...
 *   REDIRECT_URI=http://SEU_HOST:3000/callback
 *   MOLONI_COMPANY_ID=123456
 *   MOLONI_DOCUMENT_SET_ID=11111
 *   MOLONI_CUSTOMER_ID=22222
 *   MOLONI_TAX_ID=33333
 */

dotenv.config();

// ----- ENV -----
const PORT = process.env.PORT || 10000;

const CLIENT_ID = process.env.MOLONI_CLIENT_ID;
const CLIENT_SECRET = process.env.MOLONI_CLIENT_SECRET;
const REDIRECT_URI = process.env.MOLONI_CALLBACK_URL;
const COMPANY_ID = process.env.COMPANY_ID;

const MOLONI_COMPANY_ID = Number(COMPANY_ID);
const MOLONI_DOCUMENT_SET_ID = Number(process.env.DOCUMENT_SET_ID || 0);
const MOLONI_CUSTOMER_ID = Number(process.env.MOLONI_CUSTOMER_ID || 0);
const MOLONI_TAX_ID = Number(process.env.MOLONI_TAX_ID || 0);
// ----- APP -----
const app = express();
app.use(express.urlencoded({ extended: true })); // Handles form-encoded bodies (e.g. from forms)
app.use(express.json()); // Handles JSON bodies

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(morgan("dev"));
// servir ficheiros estáticos (inclui login(1).html)
app.use(express.static(path.join(__dirname, "public")));

// Alias conveniente: /login.html → login(1).html
app.get("/login.html", (req, res) => {
  res.sendFile(path.join(__dirname, "login.html"));
});

// Redirect raiz para o login
app.get("/", (req, res) => res.redirect("/login.html"));

// ----- Gestão de Tokens (em memória) -----
let moloniTokens = {
  access_token: null,
  refresh_token: null,
  expires_at: null, // timestamp (ms)
};

/**
 * Devolve um access_token válido; renova automaticamente via refresh_token quando necessário.
 */
async function getValidAccessToken() {
  // token válido com 60s de margem
  if (
    moloniTokens.access_token &&
    moloniTokens.expires_at &&
    moloniTokens.expires_at > Date.now() + 60000
  ) {
    return moloniTokens.access_token;
  }

  if (!moloniTokens.refresh_token) {
    throw new Error(
      "Refresh token inexistente. É necessário autenticar novamente (OAuth)."
    );
  }

  try {
    const { data } = await axios.get("https://api.moloni.pt/v1/grant/", {
      params: {
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: moloniTokens.refresh_token,
      },
    });

    const { access_token, refresh_token, expires_in } = data;
    moloniTokens = {
      access_token,
      refresh_token,
      expires_at: Date.now() + Number(expires_in) * 1000,
    };
    console.log("[Moloni] Token renovado.");
    return moloniTokens.access_token;
  } catch (error) {
    console.error(
      "[Moloni] Falha ao renovar token:",
      error.response?.data || error.message
    );
    throw new Error("Não foi possível renovar o token.");
  }
}

// ----- OAuth -----
// (opcional) endpoint para iniciar o fluxo OAuth (utiliza o painel de autenticação da Moloni)
app.get("/auth", (req, res) => {
  // Dependendo da configuração da Moloni, o endpoint de autorização pode variar.
  const redirect = new URL("https://api.moloni.pt/v1/authorize/");
  redirect.searchParams.set("response_type", "code");
  redirect.searchParams.set("client_id", CLIENT_ID);
  redirect.searchParams.set("redirect_uri", REDIRECT_URI);
  res.redirect(redirect.toString());
});
// Add this to your backend to list all companies
app.get("/api/moloni-companies", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();
    const { data } = await axios.get(
      "https://api.moloni.pt/v1/companies/getAll/",
      {
        params: { access_token },
      }
    );
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "companies_failed", detail: e.message });
  }
}); // Recebe o authorization code e troca por tokens

app.get("/callback", (req, res) => {
  const { code } = req.query;
  console.log("Body recebido:", req.body);
  if (!code) {
    return res.status(400).send("Falta o parâmetro 'code'.");
  }

  res.redirect(`/login.html?code=${encodeURIComponent(code)}`);
});
/*
app.get("/callback", async (req, res) => {
  const { code } = req.query;
  console.log("[Callback] Código recebido:", code);

  if (!code) {
    return res.status(400).send("Falta o parâmetro 'code'.");
  }

  try {
    const response = await axios.get("https://api.moloni.pt/v1/grant/", {
      params: {
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: code,
        redirect_uri: REDIRECT_URI,
      },
    });

    console.log("[Moloni Response]", response.data);

    const { access_token, refresh_token, expires_in } = response.data;

    moloniTokens = {
      access_token,
      refresh_token,
      expires_at: Date.now() + Number(expires_in) * 1000,
    };
  } catch (error) {
    console.error("[Moloni] Erro a trocar code por token:", {
      status: error?.response?.status,
      data: error?.response?.data,
    });

    res.status(500).json({
      error: "oauth_exchange_failed",
      detail: error.response?.data || error.message,
    });
  }
});*/
/* AntigoEndpoint usado pelo front para trocar code por token
app.post("/api/moloni-exchange-code", async (req, res) => {
  const { code } = req.body;
  console.log("Headers received:", req.headers);
  console.log("Raw body (as received):", req.body);

  if (!code) {
    return res.status(400).json({ error: "Missing code" });
  }

  try {
    const response = await axios.get("https://api.moloni.pt/v1/grant/", {
      params: {
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
      },
    });

    console.log("Moloni GET response data:", response.data);

    const { access_token, refresh_token, expires_in } = response.data;

    moloniTokens = {
      access_token,
      refresh_token,
      expires_at: Date.now() + Number(expires_in) * 1000,
    };

    return res.json({ access_token, refresh_token });
  } catch (error) {
    console.error("[Moloni] Erro completo:", {
      status: error?.response?.status,
      data: error?.response?.data,
      headers: error?.response?.headers,
    });
    return res.status(500).json({ error: "Failed to exchange code" });
  }
});*/
app.post("/api/moloni-exchange-code", async (req, res) => {
  try {
    const { code } = req.body;
    console.log("Body recebido:", req.body);
    if (!code) {
      return res.status(400).json({ error: "Missing code" });
    }

    console.log("==> Código recebido:", code);
    console.log("==> Redirecionamento:", REDIRECT_URI);

    const response = await axios.get("https://api.moloni.pt/v1/grant/", {
      params: {
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: code,
        redirect_uri: REDIRECT_URI,
      },
    });

    console.log("✅ Resposta Moloni:", response.data);

    const { access_token, refresh_token, expires_in } = response.data;

    moloniTokens = {
      access_token,
      refresh_token,
      expires_at: Date.now() + Number(expires_in) * 1000,
    };
    return res.json(response.data);
    // return res.json({ access_token, refresh_token });
  } catch (error) {
    console.error("[Moloni] ❌ Erro:", error.response?.data || error.message);
    return res.status(500).json({
      error: "Failed to exchange code",
      detail: error.response?.data || error.message,
    });
  }
});
const moloniProductMap = {
  Bolo: {
    product_id: 210061572,
    price: 10,
    tax_id: 3630173,
  },
  // outros produtos
};
app.post("/api/emitir-fatura", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();

    // 🔹 Dados vindos do frontend
    const mesa = req.body || {};
    const { notes, tableName, order } = mesa;

    // 🔹 IDs ainda definidos no backend (podes passar para o frontend depois se quiseres)
    const company_id = MOLONI_COMPANY_ID;
    const document_set_id = MOLONI_DOCUMENT_SET_ID;
    const customer_id = MOLONI_CUSTOMER_ID;

    if (!company_id || !document_set_id || !customer_id) {
      return res.status(400).json({
        error: "ids_em_falta",
        detail: "company_id, document_set_id ou customer_id em falta",
      });
    }

    // 🔹 Extrair e juntar todos os itens do pedido
    const items = [
      ...(order.plates || []),
      ...(order.drinks || []),
      ...(order.desserts || []),
      ...(order.extras || []),
      ...(order.coffee || []),
    ];

    // 🔹 Converter cada item num produto da Moloni
    const products = items
      .filter((name) => typeof name === "string" && name.trim().length > 0)
      .map((name) => {
        const product = moloniProductMap[name]; // ← pode estar no backend ou vir do frontend
        if (!product) {
          return {
            product_id: 210061572, // fallback
            name,
            qty: 1,
            price: 10,
            taxes: [{ tax_id: 3630173 }],
          };
        }
        return {
          product_id: product.product_id,
          name,
          qty: 1,
          price: product.price,
          taxes: [{ tax_id: product.tax_id }],
        };
      });

    if (!products.length) {
      return res.status(400).json({ error: "sem_produtos_validos" });
    }

    // 🔹 Preparar o payload da fatura
    const today = new Date().toISOString().slice(0, 10);
    const payload = {
      company_id,
      customer_id,
      document_set_id,
      date: today,
      expiration_date: today,
      status: 1,
      products,
      notes: notes || "",
      internal_notes: `Mesa: ${tableName || ""}`,
    };

    // 🔹 Inserir a fatura na Moloni
    const insertResp = await axios.post(
      `https://api.moloni.pt/v1/invoices/insert/?access_token=${access_token}&json=true&human_errors=true`,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }
    );

    const insertData = insertResp.data;
    const document_id =
      insertData?.document_id ||
      insertData?.document?.document_id ||
      insertData?.documentId;

    if (!document_id) {
      return res
        .status(502)
        .json({ error: "insert_sem_document_id", detail: insertData });
    }

    // 🔹 Obter link do PDF
    const pdfResp = await axios.post(
      `https://api.moloni.pt/v1/documents/getPDFLink/?access_token=${access_token}&json=true`,
      {
        company_id,
        document_id,
      },
      {
        headers: { "Content-Type": "application/json" },
      }
    );

    const pdfUrl = pdfResp?.data?.url || pdfResp?.data;
    return res.status(200).json({ pdfUrl, document_id });
  } catch (e) {
    const status = e.response?.status || 500;
    return res.status(status).json({
      error: "emitir_fatura_failed",
      detail: e.response?.data || String(e),
    });
  }
});

// util: lista empresas (para encontrares o company_id)
app.get("/api/moloni-companies", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();
    const { data } = await axios.get(
      "https://api.moloni.pt/v1/companies/getAll/",
      {
        params: { access_token },
      }
    );
    return res.json(data);
  } catch (e) {
    const status = e.response?.status || 500;
    return res.status(status).json({
      error: "companies_failed",
      detail: e.response?.data || String(e),
    });
  }
});
app.get("/api/moloni-document-sets", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();
    const company_id = MOLONI_COMPANY_ID;

    if (!access_token || !company_id) {
      return res.status(500).json({
        error: "missing_credentials",
        detail: "Access token ou company_id em falta.",
      });
    }

    const response = await axios.post(
      "https://api.moloni.pt/v1/documentSets/getAll/",
      { company_id }, // ✅ Enviado no body como JSON
      {
        params: {
          access_token, // ✅ Enviado na query string
          json: true, // ✅ Para ativar modo JSON
        },
      }
    );

    const conjuntos = response.data;

    const dadosFiltrados = conjuntos.map((set) => ({
      id: set.document_set_id,
      nome: set.name,
      tipo: set.type,
    }));

    return res.status(200).json(dadosFiltrados);
  } catch (error) {
    console.error(
      "Erro ao obter document sets:",
      error.response?.data || error.message
    );
    return res.status(500).json({
      error: "failed_fetch_document_sets",
      detail: error.response?.data || error.message,
    });
  }
});
app.get("/api/moloni-taxes", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();
    const company_id = MOLONI_COMPANY_ID;

    if (!access_token || !company_id) {
      return res.status(500).json({
        error: "missing_credentials",
        detail: "Access token ou company_id em falta.",
      });
    }

    const response = await axios.post(
      "https://api.moloni.pt/v1/taxes/getAll/",
      { company_id },
      {
        params: { access_token, json: true },
      }
    );

    const taxas = response.data.map((tax) => ({
      id: tax.tax_id,
      nome: tax.name,
      valor: tax.value,
      ativo: tax.active,
      tipo: tax.type,
    }));

    return res.status(200).json(taxas);
  } catch (error) {
    console.error(
      "Erro ao obter taxas:",
      error.response?.data || error.message
    );
    return res.status(500).json({
      error: "failed_fetch_taxes",
      detail: error.response?.data || error.message,
    });
  }
});

app.get("/api/moloni-customers", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();
    const company_id = MOLONI_COMPANY_ID;

    if (!access_token || !company_id) {
      return res.status(500).json({
        error: "missing_credentials",
        detail: "Access token ou company_id em falta.",
      });
    }

    const response = await axios.post(
      "https://api.moloni.pt/v1/customers/getAll/",
      { company_id },
      {
        params: { access_token, json: true },
      }
    );

    const clientes = response.data.map((cliente) => ({
      id: cliente.customer_id,
      nome: cliente.name,
      contribuinte: cliente.vat,
      email: cliente.email,
    }));

    return res.status(200).json(clientes);
  } catch (error) {
    console.error(
      "Erro ao obter clientes:",
      error.response?.data || error.message
    );
    return res.status(500).json({
      error: "failed_fetch_customers",
      detail: error.response?.data || error.message,
    });
  }
});
app.get("/api/moloni/config-resumo", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();

    if (!MOLONI_COMPANY_ID) {
      return res.status(400).json({
        error: "missing_company_id",
        detail: "Variável de ambiente MOLONI_COMPANY_ID não definida.",
      });
    }

    // 🔍 1. Obter dados essenciais e produtos
    const [
      companiesResp,
      documentSetsResp,
      customersResp,
      taxesResp,
      productsResp,
    ] = await Promise.all([
      axios.get("https://api.moloni.pt/v1/companies/getAll/", {
        params: { access_token, json: true },
      }),
      axios.post(
        "https://api.moloni.pt/v1/documentSets/getAll/",
        { company_id: MOLONI_COMPANY_ID },
        { params: { access_token, json: true } }
      ),
      axios.post(
        "https://api.moloni.pt/v1/customers/getAll/",
        { company_id: MOLONI_COMPANY_ID },
        { params: { access_token, json: true } }
      ),
      axios.post(
        "https://api.moloni.pt/v1/taxes/getAll/",
        { company_id: MOLONI_COMPANY_ID },
        { params: { access_token, json: true } }
      ),
      axios.post(
        "https://api.moloni.pt/v1/products/getAll/",
        { company_id: MOLONI_COMPANY_ID, qty: 50, offset: 0 }, // Ajuste qty e offset conforme necessário
        { params: { access_token, json: true } }
      ),
    ]);

    // 🔍 2. Filtrar info útil
    const company = companiesResp.data.find(
      (c) => c.company_id == MOLONI_COMPANY_ID
    );

    const documentSet = documentSetsResp.data.find(
      (d) => d.document_set_id == MOLONI_DOCUMENT_SET_ID
    );

    const customer = customersResp.data.find(
      (c) => c.customer_id == MOLONI_CUSTOMER_ID
    );

    const tax = taxesResp.data.find((t) => t.tax_id == MOLONI_TAX_ID);

    // produtos
    const products = productsResp.data || [];

    return res.status(200).json({
      company: company
        ? { id: company.company_id, name: company.name }
        : { error: "Empresa não encontrada", id: MOLONI_COMPANY_ID },

      document_set: documentSet
        ? {
            id: documentSet.document_set_id,
            name: documentSet.name,
            type: documentSet.type,
          }
        : { error: "Document set não encontrado", id: MOLONI_DOCUMENT_SET_ID },

      customer: customer
        ? { id: customer.customer_id, name: customer.name, vat: customer.vat }
        : { error: "Cliente não encontrado", id: MOLONI_CUSTOMER_ID },

      tax: tax
        ? { id: tax.tax_id, name: tax.name, value: tax.value }
        : { error: "Taxa não encontrada", id: MOLONI_TAX_ID },

      products, // inclui a lista completa de produtos
    });
  } catch (e) {
    const status = e.response?.status || 500;
    return res.status(status).json({
      error: "config_resumo_failed",
      detail: e.response?.data || String(e),
    });
  }
});

app.get("/api/moloni-customers", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();

    const { data } = await axios.post(
      "https://api.moloni.pt/v1/customers/getAll/",
      { company_id: MOLONI_COMPANY_ID },
      { params: { access_token, json: true } }
    );

    const simplificados = data.map((c) => ({
      id: c.customer_id,
      nome: c.name,
      contribuinte: c.vat,
    }));

    return res.status(200).json(simplificados);
  } catch (e) {
    return res.status(500).json({
      error: "failed_fetch_customers",
      detail: e.response?.data || String(e),
    });
  }
});

app.get("/api/moloni-taxes", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();

    const { data } = await axios.post(
      "https://api.moloni.pt/v1/taxes/getAll/",
      { company_id: MOLONI_COMPANY_ID },
      { params: { access_token, json: true } }
    );

    const simplificados = data.map((t) => ({
      id: t.tax_id,
      nome: t.name,
      valor: t.value,
      ativo: t.active,
    }));

    return res.status(200).json(simplificados);
  } catch (e) {
    return res.status(500).json({
      error: "failed_fetch_taxes",
      detail: e.response?.data || String(e),
    });
  }
});
app.get("/api/faturas", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();
    const resp = await axios.post(
      "https://api.moloni.pt/v1/invoices/getAll/?access_token=" +
        access_token +
        "&json=true",
      {
        company_id: 355755,
        document_set_id: 850313,
        filter: {
          field: "date",
          comparison: "between",
          value: ["2025-01-01", "2025-12-31"], // ajusta datas conforme necessário
        },
      }
    );

    const invoices = resp.data || [];

    // opcional: obter link PDF para cada fatura
    const withPdf = await Promise.all(
      invoices.map(async (f) => {
        const pdfResp = await axios.post(
          "https://api.moloni.pt/v1/documents/getPDFLink/?access_token=" +
            access_token +
            "&json=true",
          {
            company_id: 355755,
            document_id: f.document_id,
          }
        );
        return {
          ...f,
          pdfUrl: pdfResp?.data?.url || "",
        };
      })
    );

    res.json(withPdf);
  } catch (e) {
    console.error("Erro ao buscar faturas:", e);
    res.status(500).json({ error: "erro_listar_faturas", detail: e.message });
  }
});

// start
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
