import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import qs from "querystring"; // se usares CommonJS
dotenv.config();
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const port = 3000;

const CLIENT_ID = process.env.MOLONI_CLIENT_ID;
const CLIENT_SECRET = process.env.MOLONI_CLIENT_SECRET;
const REDIRECT_URI = process.env.MOLONI_CALLBACK_URL;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.redirect("/login.html");
});
app.get("/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.send("No authorization code received.");
  }

  try {
    const response = await axios.post(
      "https://auth.moloni.pt/oauth/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
      }).toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const data = response.data;
    res.redirect(`/login.html?access_token=${data.access_token}`);
  } catch (error) {
    console.error("Error exchanging token:", error.toJSON?.() || error.message);

    console.error(
      "Error exchanging token:",
      error?.response?.data || error.message
    );
    res.send(
      `Error fetching access token: ${
        error?.response?.data?.error_description || error.message
      }`
    );
  }
});

app.post(
  "/api/moloni-login",
  express.urlencoded({ extended: true }),
  async (req, res) => {
    const { client_id, client_secret, username, password } = req.body;

    if (!client_id || !client_secret || !username || !password) {
      return res.status(400).json({ error: "Faltam parâmetros" });
    }

    try {
      const response = await axios.post(
        "https://api.moloni.pt/v1/grant/",
        qs.stringify({
          grant_type: "password",
          client_id,
          client_secret,
          username,
          password,
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      res.json(response.data);
    } catch (error) {
      console.error(
        "Erro ao autenticar com Moloni:",
        error?.response?.data || error.message
      );
      res.status(400).send(error?.response?.data || "Erro desconhecido");
    }
  }
);
app.post("/api/emitir-fatura", async (req, res) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }

  const table = req.body;

  try {
    // Simulando chamada de criação de fatura
    const response = await axios.post(
      "https://api.moloni.pt/v1/invoices/insert/?access_token=" + token,
      {
        customer_id: 999999990, // Substituir por um cliente válido
        document_set_id: 843174, // Substituir por um documento válido
        products: table.order.plates.map((name, i) => ({
          name,
          qty: 1,
          price: 10, // Preço fictício
        })),
      }
    );

    // Retornar o link para o PDF (substituir conforme resposta real da API)
    res.json({ pdfUrl: response.data.pdf_url || "https://moloni.pt/fake.pdf" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.listen(port, () => {
  console.log(`App listening at http://localhost:${port}`);
});
