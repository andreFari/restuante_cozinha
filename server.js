import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";

import PDFMerger from "pdf-merger-js";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import { URLSearchParams } from "url";
import morgan from "morgan";
import express from "express";
import qs from "qs";
import multer from "multer";
import moloniRoutes from "./getmoloni.js";
import artigosRoutes from "./artigos.js";

import { moloniTokens, getValidAccessToken } from "./moloniAuth.js";

dotenv.config();

const PORT = process.env.PORT || 10000;
const upload = multer({ dest: "uploads/" }); // pasta temporária para uploads

const CLIENT_ID = process.env.MOLONI_CLIENT_ID;
const CLIENT_SECRET = process.env.MOLONI_CLIENT_SECRET;
const REDIRECT_URI = process.env.MOLONI_CALLBACK_URL;
const COMPANY_ID = process.env.COMPANY_ID;

const MOLONI_COMPANY_ID = Number(COMPANY_ID);
const MOLONI_DOCUMENT_SET_ID = Number(process.env.DOCUMENT_SET_ID || 0);
const MOLONI_CUSTOMER_ID = Number(process.env.MOLONI_CUSTOMER_ID || 0);
const MOLONI_TAX_ID = Number(process.env.MOLONI_TAX_ID || 0);

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/molo", moloniRoutes);
app.use("/artigo", artigosRoutes);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(morgan("dev"));

app.get("/", (req, res) => res.redirect("/login.html"));
app.get("/login.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});
app.use(express.static(path.join(__dirname, "public")));
// ----- Gestão de Tokens (em memória) -----

// Exemplo em Express
app.get("/api/moloni-token-status", (req, res) => {
  if (
    moloniTokens.access_token &&
    moloniTokens.expires_at &&
    moloniTokens.expires_at > Date.now() + 60000
  ) {
    return res.json({ valid: true });
  }

  return res.json({ valid: false });
});
/**
 * Devolve um access_token válido; renova automaticamente via refresh_token quando necessário.
 */

/*
export async function getValidAccessToken() {
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
}*/

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
});*/ app.post("/api/moloni-login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res
      .status(400)
      .json({ error: "Faltam parâmetros username e password" });
  }

  const client_id = process.env.MOLONI_CLIENT_ID;
  const client_secret = process.env.MOLONI_CLIENT_SECRET;

  const params = new URLSearchParams({
    grant_type: "password",
    client_id,
    client_secret,
    username,
    password,
  });

  try {
    const response = await fetch("https://api.moloni.pt/v1/grant/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const data = await response.json();

    if (data.error) {
      console.error("Erro ao autenticar com a Moloni:", data);
      return res.status(401).json(data);
    }

    res.json(data);
  } catch (error) {
    console.error("Erro no login Moloni:", error);
    res.status(500).json({ error: "Erro ao comunicar com a Moloni." });
  }
});

app.listen(3000, () => console.log("Server running on http://localhost:3000"));

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

    // Atualiza propriedades do objeto moloniTokens
    moloniTokens.access_token = access_token;
    moloniTokens.refresh_token = refresh_token;
    moloniTokens.expires_at = Date.now() + Number(expires_in) * 1000;
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
async function enviarFaturaEmail(document_id, email) {
  try {
    const access_token = await getValidAccessToken();
    const response = await axios.post(
      `https://api.moloni.pt/v1/faturas/sendEmail`,
      { document_id, email },
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (err) {
    console.error(
      "[Moloni] Erro ao enviar fatura:",
      err.response?.data || err.message
    );
    throw new Error("Erro ao enviar fatura via Moloni");
  }
} // Uso no Express
app.post("/api/enviar-fatura", async (req, res) => {
  const { document_id, email } = req.body;
  if (!document_id || !email)
    return res.status(400).send("document_id e email são obrigatórios");

  try {
    const result = await enviarFaturaEmail(document_id, email);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).send(err.message);
  }
});
// ───────────────────────────────────────────────────────────────
// Função para procurar ou criar cliente por NIF
// ───────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────
// Função para procurar ou criar cliente por NIF
// ───────────────────────────────────────────────────────────────
async function getOrCreateCustomerByNif(nif, name, company_id, access_token) {
  console.log("➡ Recebido NIF:", nif);

  if (!nif || !/^\d{9}$/.test(String(nif))) {
    console.error("❌ NIF inválido ou ausente");
    throw new Error("NIF inválido ou ausente");
  }

  const cleanNif = String(nif).replace(/\D/g, "");
  console.log("➡ NIF limpo:", cleanNif);

  // 1️⃣ Procurar cliente existente
  let searchResp;
  try {
    searchResp = await axios.post(
      `https://api.moloni.pt/v1/customers/getAll/?access_token=${access_token}&json=true`,
      { company_id, vat: cleanNif }
    );
    console.log("🔎 Resultado da busca de clientes:", searchResp.data);
  } catch (err) {
    console.error(
      "❌ Erro ao buscar clientes:",
      err.response?.data || err.message
    );
    throw err;
  }

  const found = (searchResp.data || []).find(
    (c) => (c.vat || "").replace(/\D/g, "") === cleanNif
  );

  if (found) {
    console.log(
      "✅ Cliente existente encontrado:",
      found.customer_id,
      found.name,
      found.vat
    );
    return found.customer_id;
  }

  console.log("ℹ Cliente não encontrado. Tentando criar novo cliente...");

  // 2️⃣ Criar cliente novo com dados padrão
  const defaultCustomerData = {
    address: "Endereço não fornecido",
    zip_code: "1000-001",
    city: "Lisboa",
    number: "1",
    maturity_date_id: 1,
    document_type_id: 1,
    copies: 1,
    payment_method_id: 1,
    delivery_method_id: 1,
    language_id: 1,
    country_id: 1, // Portugal
  };

  let insertResp;
  try {
    insertResp = await axios.post(
      `https://api.moloni.pt/v1/customers/insert/?access_token=${access_token}&json=true`,
      {
        company_id,
        name: name || `Cliente ${cleanNif}`,
        vat: cleanNif,
        ...defaultCustomerData,
      }
    );
    console.log("📥 Resposta bruta do insert:", insertResp.data);

    const data = insertResp.data;

    // Caso 1: Moloni devolve só o ID (número)
    if (typeof data === "number") {
      console.log("✅ Cliente criado com ID:", data);
      return data;
    }

    // Caso 2: Moloni devolve objeto com customer_id
    if (data?.customer_id) {
      console.log("✅ Cliente criado com objeto:", data);
      return data.customer_id;
    }

    // Caso 3: Moloni devolve array estranho (ex.: ['2 salesman_id ...'])
    if (Array.isArray(data)) {
      console.warn("⚠️ Resposta inesperada (array). A tentar fallback...");
      // depois de inserir, vamos confirmar com uma nova pesquisa pelo NIF
      const confirmResp = await axios.post(
        `https://api.moloni.pt/v1/customers/getAll/?access_token=${access_token}&json=true`,
        { company_id, vat: cleanNif }
      );
      const again = (confirmResp.data || []).find(
        (c) => (c.vat || "").replace(/\D/g, "") === cleanNif
      );
      if (again) {
        console.log("✅ Cliente confirmado após fallback:", again.customer_id);
        return again.customer_id;
      }
    }

    throw new Error("Resposta inesperada da API Moloni ao criar cliente");
  } catch (err) {
    console.error(
      "❌ Erro ao criar cliente:",
      err.response?.data || err.message
    );
    throw err;
  }
}

app.post("/api/emitir-fatura", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();
    const { notes, tableName, products, document_type, nif } = req.body || {};

    // 🔹 IDs da empresa
    const company_id = MOLONI_COMPANY_ID;
    const document_set_id = MOLONI_DOCUMENT_SET_ID;
    // 🔹 Definir o cliente
    let customer_id = MOLONI_CUSTOMER_ID; // cliente genérico
    if (!company_id || !document_set_id || !customer_id) {
      return res.status(400).json({
        error: "ids_em_falta",
        detail: "company_id, document_set_id ou customer_id em falta",
      });
    }

    const cleanNif = String(nif).replace(/\D/g, ""); // remove tudo que não seja número
    if (/^\d{9}$/.test(cleanNif)) {
      try {
        const maybeCustomerId = await getOrCreateCustomerByNif(
          cleanNif,
          `Cliente ${cleanNif}`,
          company_id,
          access_token
        );
        customer_id =
          maybeCustomerId && maybeCustomerId > 0
            ? maybeCustomerId
            : MOLONI_CUSTOMER_ID;
      } catch (err) {
        console.warn("Erro ao criar/procurar cliente, a usar genérico:", err);
        customer_id = MOLONI_CUSTOMER_ID;
      }
    }
    if (!products || !products.length) {
      return res.status(400).json({ error: "sem_produtos_validos" });
    }

    // 🔹 Obter todas as taxas disponíveis
    const taxesResp = await axios.get(`http://localhost:3000/api/moloni-taxes`);
    const allTaxes = taxesResp.data;
    const productsResp = await axios.post(
      `https://api.moloni.pt/v1/products/getAll/?access_token=${access_token}&json=true`,
      { company_id }
    );
    const allProducts = productsResp.data;
    const productsWithUnitsAndTaxes = products.map((p) => {
      const moloniProduct = allProducts.find(
        (mp) => mp.product_id === Number(p.product_id)
      );

      if (!moloniProduct) {
        console.warn("Produto não encontrado no Moloni:", p.product_id);
      }
      const tax_id = p.taxes?.[0]?.tax_id || allTaxes[0]?.id;
      const taxInfo = allTaxes.find((t) => t.id === tax_id);
      const taxes = [
        {
          tax_id: Number(tax_id),
          value: parseFloat(
            taxInfo?.valor ?? moloniProduct?.taxes?.[0]?.value ?? 23
          ),
        },
      ];
      let exemption_reason = "M00";
      if (!taxes.length || taxes.every((t) => t.value === 0)) {
        exemption_reason = "M00"; // exemplo de código de isenção
      }

      console.log(
        "Moloni unit:",
        moloniProduct.unit_id,
        moloniProduct.unit_name,
        moloniProduct.unit_short_name
      );

      console.log("Moloni product encontrado:", moloniProduct);
      return {
        product_id: Number(p.product_id),
        name: moloniProduct?.name || String(p.name || "Produto"),
        qty: parseFloat(p.qty) > 0 ? parseFloat(p.qty) : 1,
        summary: moloniProduct?.summary || String(p.name || "Produto"),
        price: parseFloat(p.price) || 0,
        unit_id: moloniProduct?.measurement_unit?.unit_id || 1,
        unit_name: moloniProduct?.measurement_unit?.name || "Unidade",
        unit_short_name: moloniProduct?.measurement_unit?.short_name || "Un",
        taxes, // usa o taxes formatado
      };
    });

    console.log(
      "Payload final para Moloni:",
      JSON.stringify(productsWithUnitsAndTaxes, null, 2)
    );

    const totalValue = productsWithUnitsAndTaxes.reduce(
      (sum, p) => sum + p.qty * p.price,
      0
    );
    // 🔹 Preparar payload da fatura
    const today = new Date().toISOString().slice(0, 10);
    const payload = {
      company_id,
      customer_id,
      document_set_id,
      date: today,
      expiration_date: today,
      document_type: document_type || "FR",
      value: totalValue,
      serie_id: 1,
      status: 1,
      products: productsWithUnitsAndTaxes,
      notes: notes || "",
      internal_notes: `Mesa: ${tableName || ""}`,
    };
    console.log(
      "Payload final enviado à Moloni este está na api:",
      JSON.stringify(payload, null, 2)
    );

    const insertResp = await axios.post(
      `https://api.moloni.pt/v1/invoices/insert/?access_token=${access_token}&json=true&human_errors=true`,
      {
        ...payload,
        products: productsWithUnitsAndTaxes, // ✅ usar o array correto
      },
      {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }
    );
    const insertData = insertResp.data;
    const document_id =
      insertData?.document_id || insertData?.document?.document_id;

    if (!document_id) {
      return res
        .status(502)
        .json({ error: "insert_sem_document_id", detail: insertData });
    }

    // 🔹 Obter link do PDF
    const pdfResp = await axios.post(
      `https://api.moloni.pt/v1/documents/getPDFLink/?access_token=${access_token}&json=true`,
      { company_id, document_id },
      { headers: { "Content-Type": "application/json" } }
    );
    console.log("pdf data ", pdfResp.data);

    const pdfUrl =
      typeof pdfResp?.data?.url === "string" ? pdfResp.data.url : null;
    if (!pdfUrl) console.warn("PDF retornado vazio:", pdfResp.data);
    return res.status(200).json({ pdfUrl, document_id });
  } catch (e) {
    console.error("Erro ao emitir fatura:", e.response?.data || e.message || e);

    const status = e.response?.status || 500;
    return res.status(status).json({
      error: "emitir_fatura_failed",
      detail: e.response?.data || String(e),
    });
  }
});

app.get("/api/moloni-units", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();
    const company_id = MOLONI_COMPANY_ID;
    console.log("Id da empresa no moloni-units api", company_id);

    if (!company_id) {
      return res.status(400).json({ error: "company_id em falta" });
    }

    // Chamada à API Moloni
    const response = await axios.post(
      `https://api.moloni.pt/v1/measurementUnits/getAll/?access_token=${access_token}&json=true`,
      { company_id },
      { headers: { "Content-Type": "application/json" } }
    );

    const units = response.data; // Lista de unidades
    return res.status(200).json(units);
  } catch (e) {
    console.error("Erro ao obter unidades:", e.response?.data || e.message);
    return res.status(500).json({
      error: "erro_obter_unidades",
      detail: e.response?.data || e.message,
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
    console.log("Guias", response.data);
    const conjuntos = response.data;

    console.log("Todas as séries:", response.data);
    return res.status(200).json(response.data);
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
          value: ["2025-01-01", "2025-12-31"],
        },
      }
    );

    const invoices = resp.data || [];

    // Obter link PDF para cada fatura
    const withPdf = await Promise.all(
      invoices.map(async (f) => {
        try {
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
        } catch (pdfErr) {
          console.warn(
            "Erro ao obter PDF para fatura",
            f.document_id,
            pdfErr.message
          );
          return {
            ...f,
            pdfUrl: "",
          };
        }
      })
    );

    res.json(withPdf);
  } catch (e) {
    console.error("Erro ao buscar faturas:", e);
    res.status(500).json({ error: "erro_listar_faturas", detail: e.message });
  }
});

app.post(
  "/api/fatura-com-auto",
  upload.fields([
    { name: "faturaPdf", maxCount: 1 },
    { name: "autoPdf", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const faturaPdfPath = req.files["faturaPdf"][0].path;
      const autoPdfPath = req.files["autoPdf"][0].path;

      const merger = new PDFMerger();
      await merger.add(faturaPdfPath);
      await merger.add(autoPdfPath);

      const combinedPdfBuffer = await merger.saveAsBuffer();

      // Apaga arquivos temporários
      fs.unlinkSync(faturaPdfPath);
      fs.unlinkSync(autoPdfPath);

      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="fatura_com_auto_${req.params.documentId}.pdf"`,
        "Content-Length": combinedPdfBuffer.length,
      });
      res.send(combinedPdfBuffer);
    } catch (error) {
      console.error(error);
      res.status(500).send("Erro ao combinar PDFs");
    }
  }
);
app.get("/api/moloni/config-resumo", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();

    if (!MOLONI_COMPANY_ID) {
      return res.status(400).json({
        error: "missing_company_id",
        detail: "Variável de ambiente MOLONI_COMPANY_ID não definida.",
      });
    }

    // 🔹 1. Obter dados essenciais + produtos + campos de cliente
    const [
      companiesResp,
      documentSetsResp,
      customersResp,
      taxesResp,
      productsResp,
      maturityDatesResp,
      paymentMethodsResp,
      deliveryMethodsResp,
      documentTypesResp,
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
        { company_id: MOLONI_COMPANY_ID, qty: 50, offset: 0 },
        { params: { access_token, json: true } }
      ),
      axios.post(
        "https://api.moloni.pt/v1/maturityDates/getAll/",
        { company_id: MOLONI_COMPANY_ID },
        { params: { access_token, json: true } }
      ),
      axios.post(
        "https://api.moloni.pt/v1/paymentMethods/getAll/",
        { company_id: MOLONI_COMPANY_ID },
        { params: { access_token, json: true } }
      ),
      axios.post(
        "https://api.moloni.pt/v1/deliveryMethods/getAll/",
        { company_id: MOLONI_COMPANY_ID },
        { params: { access_token, json: true } }
      ),
      axios.post(
        "https://api.moloni.pt/v1/documentTypes/getAll/",
        { company_id: MOLONI_COMPANY_ID },
        { params: { access_token, json: true } }
      ),
    ]);

    // 🔹 2. Filtrar info útil
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

    return res.status(200).json({
      company: company ? { id: company.company_id, name: company.name } : null,
      document_set: documentSet || null,
      customer: customer || null,
      tax: tax || null,
      products: productsResp.data || [],
      maturity_dates: maturityDatesResp.data || [],
      payment_methods: paymentMethodsResp.data || [],
      delivery_methods: deliveryMethodsResp.data || [],
      document_types: documentTypesResp.data || [],
    });
  } catch (e) {
    const status = e.response?.status || 500;
    return res.status(status).json({
      error: "config_resumo_failed",
      detail: e.response?.data || String(e),
    });
  }
});
// start
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
