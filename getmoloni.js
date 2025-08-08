import express from "express";

import axios from "axios";

import { getValidAccessToken } from "./moloniAuth.js";

const app = express();
const router = express.Router();
const formatDate = (d) => new Date(d).toISOString().slice(0, 10);
const formatDateTime = (d) => new Date(d).toISOString();
const MOLONI_COMPANY_ID = Number(process.env.COMPANY_ID);

// Artigosv
router.get("/api/artigos", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();

    const response = await axios.post(
      "https://api.moloni.pt/v1/products/getAll/",
      {
        company_id: MOLONI_COMPANY_ID,
        qty: 100,
        offset: 0,
      },
      {
        params: { access_token, json: true },
      }
    );

    // Map to simpler object with keys your frontend expects
    const simplificados = response.data.map((item) => ({
      id: item.product_id,
      nome: item.name,
      preco: item.price,
      unidade: item.unit_id,
    }));

    res.json(simplificados);
  } catch (error) {
    console.error("Erro ao buscar artigos:", error);
    res.status(500).json({ error: "erro_artigos", detail: error.message });
  }
});
// Clientes
router.get("/api/moloni-customers", async (req, res) => {
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

// Taxes
router.get("/api/moloni-taxes", async (req, res) => {
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

// Empresas
router.get("/api/moloni-companies", async (req, res) => {
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
router.get("/api/viaturas", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();

    const response = await axios.post(
      "https://api.moloni.pt/v1/vehicles/getAll/",
      { company_id: MOLONI_COMPANY_ID },
      {
        params: {
          access_token,
          json: true,
        },
      }
    );

    const data = response.data;

    console.log("Moloni vehicles response:", data);

    // Moloni's API might return data as { vehicles: [...] } or directly an array
    // Adjust this line based on actual API response structure
    const vehicles = Array.isArray(data) ? data : data.vehicles || [];
    console.log("DEBUG :: raw response.data =", response.data);

    const simplificadas = vehicles.map((v) => ({
      id: v.vehicle_id,
      matricula: v.number_plate || v.description || "Sem matrícula",
    }));

    res.json(simplificadas);
  } catch (error) {
    console.error(
      "Erro ao buscar viaturas:",
      error.response?.data || error.message
    );
    res.status(500).json({
      erro: "falha_viaturas",
      detalhe: error.response?.data || String(error),
    });
  }
});
router.post("/api/guias", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();
    const {
      clienteId,
      artigos,
      viaturaId,
      emissao,
      inicio,
      carga,
      descarga,
      observacoes,
    } = req.body;

    const linhas = artigos.map((artigoId) => ({
      product_id: Number(artigoId),
      qty: 1, // ou ajustar conforme pretendas
    }));

    const response = await axios.post(
      `https://api.moloni.pt/v1/billsOfLading/insert/?access_token=${access_token}&json=true&human_errors=true`,
      {
        company_id: MOLONI_COMPANY_ID,
        document_set_id: 850313,
        customer_id: Number(clienteId),
        vehicle_id: Number(viaturaId),
        date: formatDate(emissao), // só data (YYYY-MM-DD)
        shipping_date: formatDate(inicio), // só data
        observations: observacoes,
        products: linhas,
        delivery_departure_address: carga.morada,
        delivery_departure_city: carga.localidade,
        delivery_departure_zip_code: carga.cp,
        delivery_destination_address: descarga.morada,
        delivery_destination_city: descarga.localidade,
        delivery_destination_zip_code: descarga.cp,
        delivery_method_id: Number(req.body.deliveryMethodId) || 1,
        delivery_country: descarga.pais,
        delivery_datetime: formatDateTime(inicio), // ISO com hora
      },
      {
        headers: { "Content-Type": "application/json" }, // importante
      }
    );

    res.json({ sucesso: true, data: response.data });

    console.log("Guia criada:", response.data);
  } catch (error) {
    console.error("Erro ao criar guia:", error.response?.data || error.message);
    res.status(500).json({
      erro: "falha_criacao_guia",
      detalhe: error.response?.data || String(error),
    });
  }
});
router.get("/importar/guias", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();

    if (!access_token || !MOLONI_COMPANY_ID) {
      return res.status(500).json({
        erro: "missing_credentials",
        detalhe: "Access token ou company_id em falta.",
      });
    }

    const response = await axios.post(
      "https://api.moloni.pt/v1/billsOfLading/getAll/",
      {
        company_id: MOLONI_COMPANY_ID,
        qty: 50, // podes ajustar se quiseres paginação
        offset: 0,
      },
      {
        params: {
          access_token,
          json: true,
        },
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const guias = response.data.reverse().map((g) => ({
      id: g.document_id,
      numero: g.number,
      data: g.date,
      cliente: g.customer?.name || "-",
      nif: g.customer?.vat || "-",
      total: g.total_value || "0.00",
      codigoAT: g.at_code || "-",
    }));

    res.json(guias);
    console.log(guias);
  } catch (error) {
    console.error(
      "Erro ao obter guias:",
      error.response?.data || error.message
    );
    res.status(500).json({
      erro: "falha_obter_guias",
      detalhe: error.response?.data || String(error),
    });
  }
});

router.get("/api/delivery-methods", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();

    if (!access_token || !MOLONI_COMPANY_ID) {
      return res.status(500).json({
        erro: "missing_credentials",
        detalhe: "Access token ou company_id em falta.",
      });
    }

    const response = await axios.post(
      "https://api.moloni.pt/v1/deliveryMethods/getAll/",
      {
        company_id: MOLONI_COMPANY_ID,
        qty: 50,
        offset: 0,
      },
      {
        params: {
          access_token,
          json: true,
        },
      }
    );

    // Transformar os dados para um formato simples no frontend
    const methods = response.data.map((m) => ({
      id: m.delivery_method_id,
      name: m.name,
    }));

    res.json(methods);
  } catch (error) {
    console.error(
      "Erro ao obter métodos de entrega:",
      error.response?.data || error.message
    );
    res.status(500).json({
      erro: "falha_obter_delivery_methods",
      detalhe: error.response?.data || String(error),
    });
  }
});
export default router;
