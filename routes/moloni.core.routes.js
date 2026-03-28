import express from "express";
import axios from "axios";
import fs from "fs";
import multer from "multer";
import PDFMerger from "pdf-merger-js";
import path from "path";
import { fileURLToPath } from "url";
import { getValidAccessToken, moloniTokens } from "../moloniAuth.js";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const upload = multer({ dest: path.resolve(__dirname, "../uploads") });

const MOLONI_COMPANY_ID = Number(process.env.COMPANY_ID || 0);
const MOLONI_DOCUMENT_SET_ID = Number(process.env.DOCUMENT_SET_ID || 0);
const MOLONI_CUSTOMER_ID = Number(process.env.MOLONI_CUSTOMER_ID || 0);
const MOLONI_TAX_ID = Number(process.env.MOLONI_TAX_ID || 0);

async function enviarFaturaEmail(document_id, email) {
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
}

async function getOrCreateCustomerByNif(nif, access_token) {
  const cleanNif = String(nif || "").replace(/\D/g, "");

  const customersResp = await axios.post(
    "https://api.moloni.pt/v1/customers/getAll/",
    {
      company_id: MOLONI_COMPANY_ID,
      filters: { vat: cleanNif },
    },
    { params: { access_token, json: true } }
  );

  const customers = customersResp.data || [];
  const existing = customers.find((c) => c.vat === cleanNif);
  if (existing) return existing.customer_id;

  const [maturityDatesResp, paymentMethodsResp, deliveryMethodsResp, documentSetsResp] = await Promise.all([
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
      "https://api.moloni.pt/v1/documentSets/getAll/",
      { company_id: MOLONI_COMPANY_ID },
      { params: { access_token, json: true } }
    ),
  ]);

  const maturityDate = maturityDatesResp.data?.[0];
  const paymentMethod = paymentMethodsResp.data?.[0];
  const deliveryMethod = deliveryMethodsResp.data?.[0];
  const documentSet = documentSetsResp.data?.[0];

  if (!maturityDate || !paymentMethod || !deliveryMethod || !documentSet) {
    throw new Error("Configuração Moloni incompleta para criar cliente.");
  }

  const payload = {
    company_id: MOLONI_COMPANY_ID,
    name: `Cliente ${cleanNif}`,
    vat: cleanNif,
    number: `C-${cleanNif}`,
    salesman_id: 0,
    payment_day: 0,
    discount: 0,
    credit_limit: 0,
    address: "Desconhecido",
    city: "Desconhecido",
    zip_code: "0000-000",
    country_id: 1,
    maturity_date_id: maturityDate.maturity_date_id,
    payment_method_id: paymentMethod.payment_method_id,
    delivery_method_id: deliveryMethod.delivery_method_id,
    document_set_id: documentSet.document_set_id,
    language_id: 1,
  };

  const insertResp = await axios.post(
    "https://api.moloni.pt/v1/customers/insert/",
    payload,
    { params: { access_token, json: true } }
  );

  if (!insertResp.data?.customer_id) {
    throw new Error("Resposta inesperada da API Moloni ao criar cliente");
  }

  return insertResp.data.customer_id;
}

router.post("/gerar-saft", async (req, res) => {
  try {
    if (!moloniTokens.access_token) {
      return res.status(401).json({ error: "Token Moloni não disponível. Faça login." });
    }

    const { period_start, period_end } = req.body || {};
    const body = {
      company_id: MOLONI_COMPANY_ID,
      period_start: period_start || `${new Date().getFullYear()}-01-01`,
      period_end: period_end || `${new Date().getFullYear()}-12-31`,
      version: "1.04_01",
    };

    const response = await fetch(
      `https://api.moloni.pt/v1/saft/create?access_token=${moloniTokens.access_token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      return res.status(response.status).json(errorData);
    }

    const data = await response.json();
    if (!data.saft_xml) {
      return res.status(500).json({ error: "SAF-T não foi gerado." });
    }

    res.setHeader(
      "Content-Disposition",
      `attachment; filename=SAFT_${new Date().toISOString().slice(0, 10)}.xml`
    );
    res.setHeader("Content-Type", "application/xml");
    return res.send(data.saft_xml);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post("/enviar-fatura", async (req, res) => {
  const { document_id, email } = req.body || {};
  if (!document_id || !email) {
    return res.status(400).send("document_id e email são obrigatórios");
  }

  try {
    const result = await enviarFaturaEmail(document_id, email);
    return res.json({ success: true, result });
  } catch (error) {
    return res.status(500).send(error.message);
  }
});

router.post("/emitir-fatura", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();
    const { notes, tableName, products, document_type, nif } = req.body || {};

    let customer_id = MOLONI_CUSTOMER_ID;
    const cleanNif = String(nif || "").replace(/\D/g, "");
    if (/^\d{9}$/.test(cleanNif)) {
      try {
        const maybeCustomerId = await getOrCreateCustomerByNif(cleanNif, access_token);
        customer_id = maybeCustomerId && maybeCustomerId > 0 ? maybeCustomerId : MOLONI_CUSTOMER_ID;
      } catch {
        customer_id = MOLONI_CUSTOMER_ID;
      }
    }

    if (!products || !products.length) {
      return res.status(400).json({ error: "sem_produtos_validos" });
    }

    const taxesResp = await axios.post(
      "https://api.moloni.pt/v1/taxes/getAll/",
      { company_id: MOLONI_COMPANY_ID },
      { params: { access_token, json: true } }
    );
    const allTaxes = (taxesResp.data || []).map((tax) => ({
      id: tax.tax_id,
      nome: tax.name,
      valor: tax.value,
      ativo: tax.active,
      tipo: tax.type,
    }));

    const productsResp = await axios.post(
      `https://api.moloni.pt/v1/products/getAll/?access_token=${access_token}&json=true`,
      { company_id: MOLONI_COMPANY_ID }
    );
    const allProducts = productsResp.data || [];

    const productsWithUnitsAndTaxes = products.map((p) => {
      const moloniProduct = allProducts.find((mp) => mp.product_id === Number(p.product_id));
      const tax_id = p.taxes?.[0]?.tax_id || allTaxes[0]?.id;
      const taxInfo = allTaxes.find((t) => t.id === tax_id);

      return {
        product_id: Number(p.product_id),
        name: moloniProduct?.name || String(p.name || "Produto"),
        qty: parseFloat(p.qty) > 0 ? parseFloat(p.qty) : 1,
        summary: moloniProduct?.summary || String(p.name || "Produto"),
        price: parseFloat(p.price) || 0,
        unit_id: moloniProduct?.measurement_unit?.unit_id || 1,
        unit_name: moloniProduct?.measurement_unit?.name || "Unidade",
        unit_short_name: moloniProduct?.measurement_unit?.short_name || "Un",
        taxes: [
          {
            tax_id: Number(tax_id),
            value: parseFloat(taxInfo?.valor ?? moloniProduct?.taxes?.[0]?.value ?? 23),
          },
        ],
      };
    });

    const totalValue = productsWithUnitsAndTaxes.reduce(
      (sum, p) => sum + Number(p.qty) * Number(p.price),
      0
    );
    const today = new Date().toISOString().slice(0, 10);

    const insertResp = await axios.post(
      `https://api.moloni.pt/v1/invoices/insert/?access_token=${access_token}&json=true&human_errors=true`,
      {
        company_id: MOLONI_COMPANY_ID,
        customer_id,
        document_set_id: MOLONI_DOCUMENT_SET_ID,
        date: today,
        expiration_date: today,
        document_type: document_type || "FR",
        value: totalValue,
        serie_id: 1,
        status: 1,
        products: productsWithUnitsAndTaxes,
        notes: notes || "",
        internal_notes: `Mesa: ${tableName || ""}`,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }
    );

    const insertData = insertResp.data;
    const document_id = insertData?.document_id || insertData?.document?.document_id;
    if (!document_id) {
      return res.status(502).json({ error: "insert_sem_document_id", detail: insertData });
    }

    const pdfResp = await axios.post(
      `https://api.moloni.pt/v1/documents/getPDFLink/?access_token=${access_token}&json=true`,
      { company_id: MOLONI_COMPANY_ID, document_id },
      { headers: { "Content-Type": "application/json" } }
    );

    const pdfUrl = typeof pdfResp?.data?.url === "string" ? pdfResp.data.url : null;
    return res.status(200).json({ pdfUrl, document_id });
  } catch (error) {
    return res.status(error.response?.status || 500).json({
      error: "emitir_fatura_failed",
      detail: error.response?.data || String(error),
    });
  }
});

router.get("/moloni-units", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();
    const response = await axios.post(
      `https://api.moloni.pt/v1/measurementUnits/getAll/?access_token=${access_token}&json=true`,
      { company_id: MOLONI_COMPANY_ID },
      { headers: { "Content-Type": "application/json" } }
    );
    return res.status(200).json(response.data);
  } catch (error) {
    return res.status(500).json({
      error: "erro_obter_unidades",
      detail: error.response?.data || error.message,
    });
  }
});

router.get("/moloni-document-sets", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();
    const response = await axios.post(
      "https://api.moloni.pt/v1/documentSets/getAll/",
      { company_id: MOLONI_COMPANY_ID },
      { params: { access_token, json: true } }
    );
    return res.status(200).json(response.data);
  } catch (error) {
    return res.status(500).json({
      error: "failed_fetch_document_sets",
      detail: error.response?.data || error.message,
    });
  }
});

router.get("/moloni-taxes", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();
    const response = await axios.post(
      "https://api.moloni.pt/v1/taxes/getAll/",
      { company_id: MOLONI_COMPANY_ID },
      { params: { access_token, json: true } }
    );

    const taxas = (response.data || []).map((tax) => ({
      id: tax.tax_id,
      nome: tax.name,
      valor: tax.value,
      ativo: tax.active,
      tipo: tax.type,
    }));

    return res.status(200).json(taxas);
  } catch (error) {
    return res.status(500).json({
      error: "failed_fetch_taxes",
      detail: error.response?.data || error.message,
    });
  }
});

router.get("/faturas", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();

    const resp = await axios.post(
      `https://api.moloni.pt/v1/invoices/getAll/?access_token=${access_token}&json=true`,
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
    const withPdf = await Promise.all(
      invoices.map(async (invoice) => {
        try {
          const pdfResp = await axios.post(
            `https://api.moloni.pt/v1/documents/getPDFLink/?access_token=${access_token}&json=true`,
            {
              company_id: 355755,
              document_id: invoice.document_id,
            }
          );
          return { ...invoice, pdfUrl: pdfResp?.data?.url || "" };
        } catch {
          return { ...invoice, pdfUrl: "" };
        }
      })
    );

    return res.json(withPdf);
  } catch (error) {
    return res.status(500).json({ error: "erro_listar_faturas", detail: error.message });
  }
});

router.post(
  "/fatura-com-auto",
  upload.fields([
    { name: "faturaPdf", maxCount: 1 },
    { name: "autoPdf", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const faturaPdfPath = req.files?.faturaPdf?.[0]?.path;
      const autoPdfPath = req.files?.autoPdf?.[0]?.path;
      if (!faturaPdfPath || !autoPdfPath) {
        return res.status(400).send("Faltam PDFs para combinar");
      }

      const merger = new PDFMerger();
      await merger.add(faturaPdfPath);
      await merger.add(autoPdfPath);
      const combinedPdfBuffer = await merger.saveAsBuffer();

      fs.unlinkSync(faturaPdfPath);
      fs.unlinkSync(autoPdfPath);

      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="fatura_com_auto.pdf"',
        "Content-Length": combinedPdfBuffer.length,
      });
      return res.send(combinedPdfBuffer);
    } catch (error) {
      return res.status(500).send("Erro ao combinar PDFs");
    }
  }
);

router.get("/moloni/config-resumo", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();

    const [documentSetsResp, taxesResp, maturityDatesResp, paymentMethodsResp, deliveryMethodsResp, documentTypesResp] = await Promise.all([
      axios.post(
        "https://api.moloni.pt/v1/documentSets/getAll/",
        { company_id: MOLONI_COMPANY_ID },
        { params: { access_token, json: true } }
      ),
      axios.post(
        "https://api.moloni.pt/v1/taxes/getAll/",
        { company_id: MOLONI_COMPANY_ID },
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

    const documentSet = (documentSetsResp.data || []).find((d) => d.document_set_id == MOLONI_DOCUMENT_SET_ID);
    const tax = (taxesResp.data || []).find((t) => t.tax_id == MOLONI_TAX_ID);

    return res.status(200).json({
      document_set: documentSet || null,
      tax: tax || null,
      maturity_dates: maturityDatesResp.data || [],
      payment_methods: paymentMethodsResp.data || [],
      delivery_methods: deliveryMethodsResp.data || [],
      document_types: documentTypesResp.data || [],
    });
  } catch (error) {
    return res.status(error.response?.status || 500).json({
      error: "config_resumo_failed",
      detail: error.response?.data || String(error),
    });
  }
});

export default router;
