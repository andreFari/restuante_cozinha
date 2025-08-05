import axios from "axios";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import { URLSearchParams } from "url"; // necessário em ambientes Node

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
const PORT = process.env.PORT || 10000 || 3000 || 1000;
const CLIENT_ID = process.env.MOLONI_CLIENT_ID;
const CLIENT_SECRET = process.env.MOLONI_CLIENT_SECRET;
const REDIRECT_URI = process.env.MOLONI_CALLBACK_URL;

const MOLONI_COMPANY_ID = Number(CLIENT_ID);
const MOLONI_DOCUMENT_SET_ID = Number(process.env.DOCUMENT_SET_ID || 0);
const MOLONI_CUSTOMER_ID = Number(process.env.MOLONI_CUSTOMER_ID || 0);
const MOLONI_TAX_ID = Number(process.env.MOLONI_TAX_ID || 0);
// ----- APP -----
const app = express();
app.use(express.urlencoded({ extended: true })); // 🟢 Handles form data first
app.use(express.json()); // 🟢 Then JSON
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
});
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
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: "Missing code" });
  }
  console.log("Código recebido via URL:", code);
  try {
    const qs = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
    });

    const response = await axios.post(
      "https://api.moloni.pt/v1/grant/",
      qs.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    console.log("Moloni POST response data:", response.data);

    const { access_token, refresh_token, expires_in } = response.data;

    moloniTokens = {
      access_token,
      refresh_token,
      expires_at: Date.now() + Number(expires_in) * 1000,
    };

    return res.json({ access_token, refresh_token });
  } catch (error) {
    console.error("[Moloni] Erro:", error.response?.data || error.message);
    return res.status(500).json({ error: "Failed to exchange code" });
  }
});
// ----- API: emitir fatura -----
app.post("/api/emitir-fatura", async (req, res) => {
  try {
    // valida envs base
    if (
      !MOLONI_COMPANY_ID ||
      !MOLONI_DOCUMENT_SET_ID ||
      !MOLONI_CUSTOMER_ID ||
      !MOLONI_TAX_ID
    ) {
      return res.status(500).json({
        error: "config_invalida",
        detail:
          "Faltam IDs (company, document_set, customer, tax) nas variáveis de ambiente.",
      });
    }

    const access_token = await getValidAccessToken();
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const mesa = req.body || {};

    // 1) inserir fatura (JSON + json=true; access_token em query GET)
    const insertUrl = `https://api.moloni.pt/v1/invoices/insert/?access_token=${access_token}&json=true&human_errors=true`;

    const payload = {
      company_id: MOLONI_COMPANY_ID,
      date: today,
      expiration_date: today,
      document_set_id: MOLONI_DOCUMENT_SET_ID,
      customer_id: MOLONI_CUSTOMER_ID,
      status: 1, // 1 = fechado
      products: (mesa.order?.plates || []).map((name) => ({
        name, // idealmente, usa product_id de artigos já existentes
        qty: 1,
        price: 10, // substitui pelo teu preço real
        taxes: [{ tax_id: MOLONI_TAX_ID }],
      })),
    };

    const insertResp = await axios.post(insertUrl, payload, {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });

    // document_id devolvido pela inserção
    const document_id =
      insertResp?.data?.document_id ||
      insertResp?.data?.document?.document_id ||
      insertResp?.data?.documentId;
    if (!document_id) {
      return res
        .status(502)
        .json({ error: "insert_sem_document_id", detail: insertResp.data });
    }

    // 2) link do PDF
    const pdfResp = await axios.get(
      "https://api.moloni.pt/v1/documents/getPDFLink/",
      {
        params: {
          access_token,
          company_id: MOLONI_COMPANY_ID,
          document_id,
        },
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

// start
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
