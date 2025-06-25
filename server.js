import dotenv from "dotenv";
import express from "express";
import fetch from "node-fetch";
import open from "open";
import path from "path";
import axios from "axios";

dotenv.config();
import qs from "qs"; // npm install qs
const app = express();

app.use(express.urlencoded({ extended: true }));
// Serve static files from the 'public' folder
app.use(express.static(path.join(process.cwd(), "public")));

let accessToken = null;
let refreshToken = null;

const {
  MOLONI_CLIENT_ID,
  MOLONI_CLIENT_SECRET,
  MOLONI_CALLBACK_URL,
  COMPANY_ID,
  DOCUMENT_SET_ID,
} = process.env;

// 1) Start OAuth login (opens Moloni login page)
app.get("/moloni/login", (req, res) => {
  const url = `https://moloni.pt/oauth/?grant_type=authorization_code&client_id=${MOLONI_CLIENT_ID}&redirect_uri=${encodeURIComponent(
    MOLONI_CALLBACK_URL
  )}`;
  open(url); // opens browser from server side (optional)
  res.send("A abrir a página de login Moloni...");
});

// 2) OAuth callback — get tokens
app.get("/moloni/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Falta o código de autorização.");

  try {
    const postData = qs.stringify({
      grant_type: "authorization_code",
      client_id: MOLONI_CLIENT_ID,
      client_secret: MOLONI_CLIENT_SECRET,
      code,
      redirect_uri: MOLONI_CALLBACK_URL,
    });

    const { data } = await axios.post(
      "https://api.moloni.pt/v1/grant/",
      postData,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    accessToken = data.access_token;
    refreshToken = data.refresh_token;
    console.log("Token recebido:", accessToken);
    res.send("Autenticação concluída! Pode fechar esta janela.");
  } catch (error) {
    console.error(
      "Erro ao obter token:",
      error.response?.data || error.message
    );
    res.status(500).send("Erro na autenticação.");
  }
});
app.post("/api/moloni-login", async (req, res) => {
  try {
    const params = new URLSearchParams(req.body).toString();

    const response = await fetch("https://api.moloni.pt/v1/grant/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });

    const data = await response.json();

    if (data.access_token) {
      accessToken = data.access_token;
      res.json(data);
    } else {
      console.error("Login falhou:", data);
      res.status(401).json({ error: "Login falhou", detail: data });
    }
  } catch (err) {
    console.error("Erro:", err);
    res.status(500).json({ error: "Erro interno", detail: err.message });
  }
});
// 3) Create invoice and get PDF
app.post("/api/emitir-fatura", async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: "Não autenticado." });

  const table = req.body;

  const products = [
    ...table.order.plates,
    ...table.order.extras,
    ...table.order.drinks,
    ...table.order.desserts,
    ...table.order.coffee,
  ].map((name) => ({
    name,
    qty: 1,
    price: 10, // adjust price as needed
    taxes: [{ tax_id: 999999990 }], // use valid tax_id from your Moloni account
  }));

  try {
    // Create invoice
    const createRes = await fetch(
      "https://api.moloni.pt/v1/documents/createInvoice/",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          company_id: Number(COMPANY_ID),
          document_set_id: Number(DOCUMENT_SET_ID),
          customer_id: 1234567,
          date: new Date().toISOString().split("T")[0],
          products,
        }),
      }
    );

    const invoice = await createRes.json();

    if (!invoice.document_id) {
      return res
        .status(500)
        .json({ error: "Falha ao criar fatura.", detail: invoice });
    }

    // Get PDF link
    const pdfRes = await fetch(
      "https://api.moloni.pt/v1/documents/getPDFLink/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          access_token: accessToken,
          company_id: Number(COMPANY_ID),
          document_id: invoice.document_id,
        }),
      }
    );

    const pdf = await pdfRes.json();

    res.json({ pdfUrl: pdf.url });
  } catch (error) {
    console.error("Erro ao emitir fatura:", error.message || error);
    res.status(500).json({ error: "Erro ao emitir fatura." });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "login.html"));
});
app.listen(3000, () => {
  console.log("🚀 Servidor a correr em http://127.0.0.1:3000");
});
