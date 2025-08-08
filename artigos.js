import express from "express";
const router = express.Router();

import { getValidAccessToken, getCompanyId } from "./moloniAuth.js";

// GET produtos da categoria (ex: carne)
router.get("/artigos", async (req, res) => {
  try {
    const token = await getValidAccessToken();
    const company_id = getCompanyId();
    const { category_id } = req.query;

    const url = `https://api.moloni.pt/v1/products/getAll/?access_token=${token}&json=true`;

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

    const response = await fetch("https://api.moloni.pt/v1/products/insert/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: token,
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

    const response = await fetch("https://api.moloni.pt/v1/products/delete/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: token, company_id, product_id }),
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Recursivamente obter todas as categorias e subcategorias
async function fetchAllCategories(
  token,
  company_id,
  parent_id = 0,
  categorias = []
) {
  const res = await fetch(
    "https://api.moloni.pt/v1/productCategories/getAll/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: token, company_id, parent_id }),
    }
  );

  const data = await res.json();

  for (const categoria of data) {
    categorias.push(categoria);
    // Chamar recursivamente para buscar subcategorias desta
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
