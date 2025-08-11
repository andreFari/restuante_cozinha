import express from "express";
const router = express.Router();

import { getValidAccessToken, getCompanyId } from "./moloniAuth.js";

// Função para criar URLs com access_token e json=true
function moloniUrl(endpoint, token) {
  return `https://api.moloni.pt/v1/${endpoint}/?access_token=${token}&json=true&human_errors=true`;
}

// GET produtos da categoria (ex: carne)
router.get("/artigos", async (req, res) => {
  try {
    const token = await getValidAccessToken();
    const company_id = getCompanyId();
    const { category_id } = req.query;

    const url = moloniUrl("products/getAll", token);

    const body = { company_id };
    if (category_id) body.category_id = category_id;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// rota para buscar unidades do Moloni
// rota para buscar unidades do Moloni
router.get("/unidades", async (req, res) => {
  try {
    const token = await getValidAccessToken();
    const company_id = getCompanyId();

    const url = moloniUrl("productUnits/getAll", token); // corrigido aqui

    const body = { company_id };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    // data é um array com unidades: { unit_id, name, ... }
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
router.post("/artigos", async (req, res) => {
  try {
    const token = await getValidAccessToken();
    const company_id = getCompanyId();
    const {
      name,
      reference,
      price,
      tax_id,
      unit_id,
      summary,
      ean,
      category_id,
    } = req.body;

    const url = moloniUrl("products/insert", token);

    // Montar o corpo conforme a API Moloni exige
    const body = {
      company_id,
      category_id: parseInt(category_id),
      type: 1, // Produto
      name,
      reference,
      price: parseFloat(price),
      unit_id: parseInt(unit_id),
      has_stock: 0, // você controla se o produto tem stock ou não
      stock: 0,
      summary,
      ean,
      taxes: [
        {
          tax_id: parseInt(tax_id),
          value: 0, // o valor será ignorado e substituído pela API Moloni
          order: 1,
          cumulative: 0,
        },
      ],
      pos_favorite: 1,
      visibility_id: 1,
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      // Retorna erro com detalhes da Moloni
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// DELETE - eliminar artigo
router.delete("/artigos/:id", async (req, res) => {
  try {
    const token = await getValidAccessToken();
    const company_id = getCompanyId();
    const product_id = parseInt(req.params.id, 10);

    const url = `https://api.moloni.pt/v1/products/delete/?access_token=${token}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company_id,
        product_id,
      }),
    });

    const data = await response.json();
    console.log("Resposta Moloni delete:", data);

    if (data && data.error) {
      return res.status(400).json({ error: data.error });
    }

    res.json({ success: true, data });
  } catch (error) {
    console.error("Erro ao apagar produto:", error);
    res.status(500).json({ error: error.message });
  }
});

async function fetchAllCategories(
  token,
  company_id,
  parent_id = 0,
  categorias = [],
  offset = 0,
  visited = new Set()
) {
  if (visited.has(parent_id)) {
    return categorias; // Já visitou essa categoria pai, evita loop
  }
  visited.add(parent_id);

  const url = moloniUrl("productCategories/getAll", token);

  const body = {
    company_id,
    parent_id,
    qty: 50,
    offset,
  };
  console.log("Buscando categorias parent_id=", parent_id, "offset=", offset);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!Array.isArray(data)) {
    return categorias;
  }

  categorias.push(...data);

  if (data.length === 50) {
    // Paginação, buscar próximo offset
    await fetchAllCategories(
      token,
      company_id,
      parent_id,
      categorias,
      offset + 50,
      visited
    );
  }

  for (const categoria of data) {
    await fetchAllCategories(
      token,
      company_id,
      categoria.productCategory_id,
      categorias,
      0,
      visited
    );
  }

  return categorias;
}
router.get("/categorias", async (req, res) => {
  try {
    const token = await getValidAccessToken();
    const company_id = getCompanyId();

    console.log("Iniciando fetchAllCategories");
    const categorias = await fetchAllCategories(token, company_id);
    console.log("Categorias buscadas:", categorias.length);
    res.json(categorias);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
