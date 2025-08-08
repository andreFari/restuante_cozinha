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

// POST - criar artigo
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

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company_id,
        name,
        reference,
        price,
        tax_id,
        unit_id,
        category_id,
        summary,
        ean,
        has_stock: 0,
        pos_favorite: 1,
        visibility_id: 1,
      }),
    });

    const data = await response.json();
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
    const product_id = req.params.id;

    const url = moloniUrl("products/delete", token);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company_id, product_id }),
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
async function fetchAllCategories(
  token,
  company_id,
  parent_id = 0,
  categorias = [],
  offset = 0
) {
  const url = moloniUrl("productCategories/getAll", token);

  // Monta o body incluindo offset e qty para paginação
  const body = {
    company_id,
    parent_id,
    qty: 50,
    offset,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!Array.isArray(data)) {
    // Se houver erro ou resposta inesperada
    return categorias;
  }

  categorias.push(...data);

  // Se chegou no limite 50, pode haver mais categorias -> chama recursivamente aumentando offset
  if (data.length === 50) {
    return fetchAllCategories(
      token,
      company_id,
      parent_id,
      categorias,
      offset + 50
    );
  }

  // Agora chama recursivamente para cada categoria buscar subcategorias
  for (const categoria of data) {
    await fetchAllCategories(
      token,
      company_id,
      categoria.productCategory_id,
      categorias
    );
  }

  return categorias;
}
router.get("/categorias", async (req, res) => {
  try {
    const token = await getValidAccessToken();
    const company_id = getCompanyId();

    const categorias = await fetchAllCategories(token, company_id);

    res.json(categorias);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
