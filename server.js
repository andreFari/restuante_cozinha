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
app.use(express.static(path.join(__dirname, "public")));

app.get("/login.html", (req, res) => {
  res.sendFile(path.join(__dirname, "login.html"));
});

app.get("/", (req, res) => res.redirect("login.html"));
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
app.post("/api/emitir-fatura", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();
    const { notes, tableName, products } = req.body || {};

    // 🔹 IDs da empresa
    const company_id = MOLONI_COMPANY_ID;
    const document_set_id = MOLONI_DOCUMENT_SET_ID;
    const customer_id = MOLONI_CUSTOMER_ID;

    if (!company_id || !document_set_id || !customer_id) {
      return res.status(400).json({
        error: "ids_em_falta",
        detail: "company_id, document_set_id ou customer_id em falta",
      });
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
      const tax_id = p.taxes?.[0]?.tax_id || allTaxes[0]?.id;
      const taxInfo = allTaxes.find((t) => t.id === tax_id);
      const taxes = [
        {
          tax_id: Number(tax_id),
          value: parseFloat(taxInfo?.valor ?? 23),
        },
      ];

      let exemption_reason;
      if (!taxes.length || taxes.every((t) => t.value === 0)) {
        exemption_reason = "M00"; // exemplo de código de isenção
      }
      const moloniProduct = allProducts.find(
        (mp) => mp.product_id === Number(p.product_id)
      );

      return {
        product_id: Number(p.product_id),
        name: moloniProduct?.name || String(p.name || "Produto"),
        qty: parseFloat(p.qty) > 0 ? parseFloat(p.qty) : 1,
        summary: moloniProduct?.summary || String(p.name || "Produto"),
        price: parseFloat(p.price) || 0,
        unit_id: moloniProduct?.unit_id,
        unit_name: moloniProduct?.unit_name || p.unit_name || "Unidade",
        unit_short_name:
          moloniProduct?.unit_short_name || p.unit_short_name || "Un",
        taxes,
        ...(exemption_reason ? { exemption_reason } : {}),
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
      document_type: "FT",
      value: totalValue,
      serie_id: 1,
      status: 0,
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

    const pdfUrl = pdfResp?.data?.url || pdfResp?.data;
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

// start
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
