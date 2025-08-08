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

//Guias
// routes/moloni.js (ou onde tens as rotas Moloni)
router.post("/guias/:id/codigo-at", async (req, res) => {
  const { id: document_id } = req.params;
  const { transport_code } = req.body;

  const access_token = await getValidAccessToken();
  const company_id = MOLONI_COMPANY_ID;

  console.log("🚀 Enviando código AT", {
    document_id,
    transport_code,
    company_id,
    access_token,
  });

  try {
    const response = await fetch(
      `https://api.moloni.pt/v1/billsOfLading/setTransportCode/?access_token=${access_token}&json=true&human_errors=true`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_id,
          document_id: Number(document_id),
          transport_code,
        }),
      }
    );

    const rawText = await response.text();

    if (!response.ok) {
      console.error("❌ Erro da Moloni:", response.status, rawText);
      return res.status(response.status).send(rawText);
    }

    const data = JSON.parse(rawText);
    res.json(data);
  } catch (error) {
    console.error("❌ Exceção ao enviar código AT:", error.message);
    res.status(500).json({ detalhe: error.message });
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
      deliveryMethodId,
    } = req.body;

    // 1. Validação de campos obrigatórios
    if (
      !clienteId ||
      !Array.isArray(artigos) ||
      artigos.length === 0 ||
      !viaturaId ||
      !emissao ||
      !inicio ||
      !carga ||
      !descarga
    ) {
      return res.status(400).json({
        erro: "dados_invalidos",
        detalhe: "Campos obrigatórios em falta ou inválidos.",
      });
    }

    // 2. Validar formato das datas
    const dataRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dataRegex.test(emissao) || !dataRegex.test(inicio)) {
      return res.status(400).json({
        erro: "data_invalida",
        detalhe: "Datas devem estar no formato YYYY-MM-DD.",
      });
    }

    // 3. Buscar todos os artigos para validação
    const artigosResponse = await axios.post(
      "https://api.moloni.pt/v1/products/getAll/",
      {
        company_id: MOLONI_COMPANY_ID,
        qty: 1000,
        offset: 0,
      },
      { params: { access_token, json: true } }
    );

    const todosArtigos = artigosResponse.data;

    // 4. Verificar se todos os artigos existem
    const linhas = artigos.map((artigoId) => {
      const p = todosArtigos.find((a) => a.product_id == artigoId);
      if (!p) throw new Error(`Artigo com ID ${artigoId} não encontrado`);

      // Verifique se tem impostos válidos:
      const hasValidTaxes =
        Array.isArray(p.taxes) && p.taxes.some((t) => t.tax_id && t.tax_id > 0);

      const exemptionReason = !hasValidTaxes
        ? p.exemption_reason || "M01"
        : undefined;

      return {
        product_id: p.product_id,
        name: p.name,
        qty: 1,
        price: parseFloat(p.price) || 0,
        ...(exemptionReason && { exemption_reason: exemptionReason }),
        taxes: hasValidTaxes
          ? p.taxes.map((t) => ({ tax_id: t.tax_id, value: t.value || 0 }))
          : [],
      };
    });
    // 5. Verificar se cliente existe
    const clientesResponse = await axios.post(
      "https://api.moloni.pt/v1/customers/getAll/",
      { company_id: MOLONI_COMPANY_ID },
      { params: { access_token, json: true } }
    );
    const clienteExiste = clientesResponse.data.some(
      (c) => c.customer_id == clienteId
    );
    if (!clienteExiste) {
      return res.status(400).json({
        erro: "cliente_nao_existe",
        detalhe: `Cliente com ID ${clienteId} não encontrado.`,
      });
    }

    // 6. Verificar se viatura existe
    const viaturasResponse = await axios.post(
      "https://api.moloni.pt/v1/vehicles/getAll/",
      { company_id: MOLONI_COMPANY_ID },
      { params: { access_token, json: true } }
    );
    const viaturaExiste = viaturasResponse.data.some(
      (v) => v.vehicle_id == viaturaId
    );
    if (!viaturaExiste) {
      return res.status(400).json({
        erro: "viatura_nao_existe",
        detalhe: `Viatura com ID ${viaturaId} não encontrada.`,
      });
    }

    // 7. Criar a guia
    const response = await axios.post(
      `https://api.moloni.pt/v1/billsOfLading/insert/?access_token=${access_token}&json=true&human_errors=true`,
      {
        company_id: MOLONI_COMPANY_ID,
        document_set_id: 850313,
        customer_id: Number(clienteId),
        vehicle_id: Number(viaturaId),
        date: emissao,
        status: 1,
        shipping_date: inicio,
        observations: observacoes,
        products: linhas,
        delivery_departure_address: carga.morada,
        delivery_departure_city: carga.localidade,
        delivery_departure_zip_code: carga.cp,
        delivery_destination_address: descarga.morada,
        delivery_destination_city: descarga.localidade,
        delivery_destination_zip_code: descarga.cp,
        delivery_method_id: Number(deliveryMethodId) || 1,

        delivery_country: descarga.pais || "PT", // garante que tem país
        billing_country: "PT", // também ajuda a AT
        delivery_datetime: emissao,
      },
      {
        headers: { "Content-Type": "application/json" },
      }
    );

    // 8. Resposta final
    res.json({ sucesso: true, data: response.data });
    console.log("Guia criada com sucesso:", response.data);
  } catch (error) {
    console.error("Erro ao criar guia:", error.response?.data || error.message);
    res.status(500).json({
      erro: "falha_criacao_guia",
      detalhe: error.response?.data || String(error),
    });
  }
});
router.get("/api/guias/:id/refresh-at", async (req, res) => {
  try {
    const { id } = req.params;
    const access_token = await getValidAccessToken();

    const response = await axios.post(
      "https://api.moloni.pt/v1/billsOfLading/getOne/",
      {
        company_id: MOLONI_COMPANY_ID,
        document_id: id,
      },
      {
        params: { access_token, json: true },
        headers: { "Content-Type": "application/json" },
      }
    );

    const guia = response.data;
    return res.json({
      saft_hash: guia.saft_hash,
      at_code: guia.at_code || guia.saft_hash || "---",
      raw: guia,
    });
  } catch (err) {
    console.error("Erro ao buscar código AT:", err.message);
    return res.status(500).json({
      erro: "erro_codigo_at",
      detalhe: err.response?.data || String(err),
    });
  }
});
router.get("/importar/guias", async (req, res) => {
  try {
    const access_token = await getValidAccessToken();

    const listaGuiasResponse = await axios.post(
      "https://api.moloni.pt/v1/billsOfLading/getAll/",
      {
        company_id: MOLONI_COMPANY_ID,
        qty: 10, // ajusta conforme precisares
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

    const listaGuias = listaGuiasResponse.data;

    const detalhesCompletos = await Promise.all(
      listaGuias.map(async (g) => {
        try {
          const detalheResponse = await axios.post(
            "https://api.moloni.pt/v1/billsOfLading/getOne/",
            {
              company_id: MOLONI_COMPANY_ID,
              document_id: g.document_id,
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

          const guia = detalheResponse.data;
          console.log("Guia detalhada:", guia);
          return {
            id: guia.document_id,
            numero: guia.document_number || guia.number || "-",
            data: guia.date || "-",
            cliente: guia.customer_name || guia.customer?.name || "-",
            nif: guia.customer_vat || guia.customer?.vat || "-",
            total: guia.net_value || guia.total_value || "0.00",
            codigoAT: guia.saft_hash || "-",
          };
        } catch (detalheErro) {
          console.error("Erro ao obter guia detalhada:", detalheErro.message);
          return {
            id: g.document_id,
            numero: g.number || "-",
            data: g.date || "-",
            cliente: "-",
            nif: "-",
            total: "0.00",
            codigoAT: "-",
          };
        }
      })
    );

    res.json(detalhesCompletos);
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
