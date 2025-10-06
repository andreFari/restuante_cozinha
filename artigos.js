import express from "express";
const router = express.Router();

import { getValidAccessToken, getCompanyId } from "./moloniAuth.js";
// Simulando "base de dados local" de artigos
const artigosLocais = [
  {
    name: "Sopa",
    reference: "REF001",
    price: 10.0,
    tax_id: 3630173,
    unit_id: 3323458, //unidade
    summary: "Entrada",
    ean: "1234567890123",
    category_id: 9664037,
  },
  {
    name: "Bife da Vazia",
    reference: "REF002",
    price: 15.5,
    tax_id: 3630173,
    unit_id: 3323458,
    summary: "Prato principal",
    ean: "1234567890456",
    category_id: 9664037,
  },
  // ... mais artigos
];
const fakeArtigos = [
  {
    product_id: 1,
    name: "Bife da Casa",
    price: 12.5,
    tax_id: 3630173,
    category_id: "Principais",
    summary: "Pratos",
    image_url: "imagens/placeholder.jpg",
  },
  {
    product_id: 11,
    name: "Bife da Casa",
    price: 12.5,
    tax_id: 3630173,
    category_id: "Principais",
    summary: "Pratos",
    image_url: "imagens/placeholder.jpg",
  },
  {
    product_id: 12,
    name: "Bucho",
    reference: "BCH001",
    price: 5,
    tax_id: 3630173,
    category_id: "Principais",
    summary: "prato principal",
    image_url: "imagens/bucho.jpg",
    ean: "1234567890123",
  },
  {
    product_id: 13,
    name: "Maranho",
    price: 10,
    tax_id: 3630173,
    summary: "prato principal",
    image_url: "imagens/placeholder.jpg",
  },
  {
    product_id: 14,
    name: "Bife da Casa",
    price: 12.5,
    tax_id: 3630173,
    summary: "prato principal",
    image_url: "imagens/placeholder.jpg",
  },
  {
    product_id: 2,
    name: "Arroz de Tomate",
    price: 3.5,
    tax_id: 3630173,
    category_id: "Acompanhamento",
    summary: "acompanhamento",
    image_url: "imagens/placeholder.jpg",
  },
  {
    product_id: 3,
    name: "Coca-Cola",
    price: 2,
    tax_id: 3630173,
    category_id: "Bebida",
    summary: "Bebida",
    image_url: "imagens/placeholder.jpg",
  },
  {
    product_id: 4,
    name: "Mousse de Chocolate",
    price: 3,
    category_id: "Sobremesa",
    tax_id: 3630173,
    summary: "Sobremesas",
    image_url: "imagens/placeholder.jpg",
  },
  {
    product_id: 5,
    name: "Café",
    price: 1,
    category_id: "Bebida",
    tax_id: 3630173,
    summary: "Extra",
    image_url: "imagens/placeholder.jpg",
  },
  {
    product_id: 6,
    name: "Feijoada",
    price: 15,
    tax_id: 3630173,
    category_id: "Principais",
    summary: "Prato Principal",
    image_url: "imagens/placeholder.jpg",
  },
  {
    product_id: 7,
    name: "Salada de Alface",
    price: 2.5,
    tax_id: 3630173,
    category_id: "Acompanhamento",
    summary: "Acompanhamento",
    image_url: "imagens/placeholder.jpg",
  },
  {
    product_id: 8,
    name: "Sumo de Laranja",
    price: 2.5,
    tax_id: 3630173,
    category_id: "Bebida",
    summary: "Bebida",
    image_url: "imagens/placeholder.jpg",
  },
  {
    product_id: 9,
    name: "Pudim",
    price: 3,
    category_id: "Sobremesa",
    tax_id: 3630173,
    summary: "Sobremesa",
    image_url: "imagens/placeholder.jpg",
  },
  {
    product_id: 10,
    name: "Chá Gelado",
    price: 1.5,
    tax_id: 3630173,
    summary: "Extra",
    image_url: "imagens/placeholder.jpg",
  },
];

// Endpoint para obter artigos locais
router.get("/artigos-locais", (req, res) => {
  res.json(artigosLocais);
});

// Função que sincroniza artigos locais com Moloni (insert ou update)
async function sincronizarArtigos(token, company_id) {
  // 1. Buscar artigos na Moloni
  const urlMoloni = moloniUrl("products/getAll", token);
  const resMoloni = await fetch(urlMoloni, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ company_id }),
  });
  const artigosMoloni = await resMoloni.json();

  if (!Array.isArray(artigosMoloni)) {
    console.error("Resposta inesperada dos artigos Moloni");
    return;
  }

  // Map rápido de referência → product_id
  const referenciasMoloni = new Map();
  artigosMoloni.forEach((a) =>
    referenciasMoloni.set(a.reference, a.product_id)
  );

  // 2. Percorrer os artigos locais
  for (const artigo of artigosLocais) {
    const product_id = referenciasMoloni.get(artigo.reference);

    if (product_id) {
      // Artigo existe, fazer UPDATE
      console.log(
        `Artigo ${artigo.reference} já existe na Moloni. Atualizando...`
      );
      const urlUpdate = moloniUrl("products/update", token);
      const bodyUpdate = {
        company_id,
        product_id,
        category_id: parseInt(artigo.category_id),
        type: 1,
        name: artigo.name,
        reference: artigo.reference,
        price: parseFloat(artigo.price),
        unit_id: parseInt(artigo.unit_id),
        has_stock: 0,
        stock: 0,
        summary: artigo.summary,
        ean: artigo.ean,
        pos_favorite: 1,
        taxes: [
          {
            tax_id: parseInt(artigo.tax_id),
            value: 0,
            order: 1,
            cumulative: 0,
          },
        ],
      };

      const resUpdate = await fetch(urlUpdate, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyUpdate),
      });
      const dataUpdate = await resUpdate.json();
      console.log("Resposta update:", dataUpdate);
      if (!resUpdate.ok) {
        console.error(
          `Erro ao atualizar artigo ${artigo.reference}:`,
          dataUpdate
        );
      }
    } else {
      // Artigo não existe, criar
      console.log(`Artigo ${artigo.reference} não existe. Criando...`);
      const urlInsert = moloniUrl("products/insert", token);
      const bodyInsert = {
        company_id,
        category_id: parseInt(artigo.category_id),
        type: 1,
        name: artigo.name,
        reference: artigo.reference,
        price: parseFloat(artigo.price),
        unit_id: parseInt(artigo.unit_id),
        has_stock: 0,
        stock: 0,
        summary: artigo.summary,
        ean: artigo.ean,
        pos_favorite: 1,
        visibility_id: 1,
        taxes: [
          {
            tax_id: parseInt(artigo.tax_id),
            value: 0,
            order: 1,
            cumulative: 0,
          },
        ],
      };

      const resInsert = await fetch(urlInsert, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyInsert),
      });
      const dataInsert = await resInsert.json();
      console.log("Resposta insert:", dataInsert);
      if (!resInsert.ok) {
        console.error(
          `Erro ao inserir artigo ${artigo.reference}:`,
          dataInsert
        );
      }
    }
  }
}
/*necessário quando for a sério
// Endpoint para disparar sincronização
router.post("/sincronizar", async (req, res) => {
  try {
    const token = await getValidAccessToken();
    const company_id = getCompanyId();

    await sincronizarArtigos(token, company_id);

    res.json({ message: "Sincronização concluída" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});*/
// Função para criar URLs com access_token e json=true
function moloniUrl(endpoint, token) {
  return `https://api.moloni.pt/v1/${endpoint}/?access_token=${token}&json=true&human_errors=true`;
}
// 👉 Use fake data if Moloni is not set up
router.get("/artigos", async (req, res) => {
  try {
    // just return fake data for now
    res.json(fakeArtigos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
/*
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
    // console.log(data);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
*/
// rota para buscar unidades do Moloni
router.get("/unidades", async (req, res) => {
  try {
    const token = await getValidAccessToken();
    const company_id = getCompanyId();

    const url = moloniUrl("/unit_id/getAll", token);

    const body = { company_id };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    // console.log(data);
    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    // Procurar unidade padrão
    const defaultUnit = data.find(
      (unit) => unit.name.toLowerCase() === "unidade"
    );

    res.json({
      units: data,
      defaultUnit: defaultUnit || null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
router.put("/artigos/:id", async (req, res) => {
  console.log("📡 PUT /artigos/:id hit");
  console.log("🆔 Product ID:", req.params.id);
  console.log("📥 Headers:", req.headers);
  console.log("📥 Body:", req.body);
  try {
    const token = await getValidAccessToken();
    const company_id = getCompanyId();
    const product_id = parseInt(req.params.id, 10);

    const {
      name,
      reference,
      price,
      tax_id,
      unit_id,
      summary,
      ean,

      category_id,
      has_stock = 0,
      stock = 0,
      pos_favorite = 1,
      exemption_reason = "",
    } = req.body;

    // Montar corpo conforme API Moloni update exige

    const url = moloniUrl("/products/update", token);
    const body = {
      company_id,
      product_id,
      category_id: parseInt(category_id),
      type: 1, // Produto
      name,
      reference,
      price: parseFloat(price),
      unit_id: parseInt(unit_id),
      has_stock: parseInt(has_stock),
      stock: parseFloat(stock),
      summary,
      ean,
      pos_favorite: parseInt(pos_favorite),
      exemption_reason, // se necessário

      // array de impostos
      taxes: [
        {
          tax_id: parseInt(tax_id),
          value: 0, // valor será ajustado pela Moloni
          order: 1,
          cumulative: 0,
        },
      ],
    };
    console.log("🔍 Moloni URL:", url);
    console.log("📦 Moloni body:", body);
    const response = await fetch(url, {
      method: "POST", // Moloni usa POST mesmo para update
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

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
    // console.log(data);
    if (!response.ok) {
      // Retorna erro com detalhes da Moloni
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
router.delete("/artigos/:id", async (req, res) => {
  try {
    const token = await getValidAccessToken();
    const company_id = getCompanyId();
    const product_id = parseInt(req.params.id, 10);

    console.log("Deleting product_id:", product_id);

    // Adicione json=true para envio de JSON
    const url = `https://api.moloni.pt/v1/products/delete/?access_token=${token}&json=true`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company_id,
        product_id,
      }),
    });

    const data = await response.json();
    // console.log("Resposta Moloni delete:", data);

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
// Criar categoria
router.post("/categorias", async (req, res) => {
  try {
    const token = await getValidAccessToken();
    const company_id = getCompanyId();
    const { name, parent_id = 0, description = "" } = req.body;

    const url = moloniUrl("productCategories/insert", token);
    const body = {
      company_id,
      parent_id: parseInt(parent_id),
      name,
      description,
      pos_enabled: 1,
    };

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

// Editar categoria
router.put("/categorias/:id", async (req, res) => {
  try {
    const token = await getValidAccessToken();
    const company_id = getCompanyId();
    const { name, parent_id = 0, description = "" } = req.body;

    const url = moloniUrl("productCategories/update", token);
    const body = {
      company_id,
      category_id: parseInt(req.params.id),
      parent_id: parseInt(parent_id),
      name,
      description,
      pos_enabled: 1,
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("❌ Backend error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Apagar categoria
router.delete("/categorias/:id", async (req, res) => {
  try {
    const token = await getValidAccessToken();
    const company_id = getCompanyId();

    const url = moloniUrl("productCategories/delete", token);
    const body = {
      company_id,
      category_id: parseInt(req.params.id),
    };

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
export default router;
