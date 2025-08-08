import express from "express";
const router = express.Router();

// Funções de token e company_id
import { getAccessToken, getCompanyId } from "./moloniAuth.js";

// GET produtos da categoria (ex: carne)
router.get("/artigos", async (req, res) => {
  const token = getAccessToken();
  const company_id = getCompanyId();
  const { category_id } = req.query;

  const response = await fetch("https://api.moloni.pt/v1/products/getAll/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: token, company_id, category_id }),
  });

  const data = await response.json();
  res.json(data);
});

// POST - criar artigo
router.post("/artigos", async (req, res) => {
  const token = getAccessToken();
  const company_id = getCompanyId();
  const { name, reference, price, tax_id, unit_id, summary, ean, category_id } =
    req.body;

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
});

// DELETE - eliminar artigo
router.delete("/artigos/:id", async (req, res) => {
  const token = getAccessToken();
  const company_id = getCompanyId();
  const product_id = req.params.id;

  const response = await fetch("https://api.moloni.pt/v1/products/delete/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: token, company_id, product_id }),
  });

  const data = await response.json();
  res.json(data);
});

// GET categorias
router.get("/categorias", async (req, res) => {
  const token = getAccessToken();
  const company_id = getCompanyId();

  const response = await fetch(
    "https://api.moloni.pt/v1/productCategories/getAll/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: token, company_id }),
    }
  );

  const data = await response.json();
  res.json(data);
});

export default router;
