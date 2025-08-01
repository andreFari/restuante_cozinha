import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import qs from "querystring";

dotenv.config();
let moloniTokens = {
  access_token: null,
  refresh_token: null,
  expires_at: null, // timestamp em milissegundos
};
const app = express();
const port = process.env.PORT || 3000;

const CLIENT_ID = process.env.MOLONI_CLIENT_ID;
const CLIENT_SECRET = process.env.MOLONI_CLIENT_SECRET;
const REDIRECT_URI = process.env.MOLONI_CALLBACK_URL;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middleware
app.use(express.static(path.join(__dirname, "public")));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Routes
app.get("/", (req, res) => {
  res.redirect("/login.html");
});

app.get("/callback", async (req, res) => {
  const { code } = req.query;

  console.log("Exchanging code for token with data:", {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: REDIRECT_URI,
  });

  try {
    const response = await axios.get("https://api.moloni.pt/v1/grant/", {
      params: {
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
      },
    });

    const { access_token, refresh_token, expires_in } = response.data;
    // Guardar os tokens e o tempo de expiração (agora + expires_in)
    moloniTokens = {
      access_token,
      refresh_token,
      expires_at: Date.now() + expires_in * 1000, // expires_in vem em segundos
    };
    console.log("Tokens armazenados:", moloniTokens);
    console.log("Authorization code received:", code);
    console.log("Access token received:", access_token);

    return res.redirect(`/login.html?access_token=${access_token}`);
  } catch (error) {
    console.error(
      "Token exchange error:",
      error.response?.status,
      error.response?.data || error.message
    );

    res
      .status(500)
      .send(
        `Error fetching access token: ${JSON.stringify(
          error.response?.data || error.message
        )}`
      );
  }
});
async function getValidAccessToken() {
  // Verifica se o token existe e ainda não expirou (dá margem de 1 min)
  if (
    moloniTokens.access_token &&
    moloniTokens.expires_at &&
    moloniTokens.expires_at > Date.now() + 60000
  ) {
    return moloniTokens.access_token;
  }

  // Caso precise de renovar
  if (!moloniTokens.refresh_token) {
    throw new Error(
      "Refresh token inexistente. O utilizador precisa de se autenticar novamente."
    );
  }

  try {
    const response = await axios.get("https://api.moloni.pt/v1/grant/", {
      params: {
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: moloniTokens.refresh_token,
      },
    });

    const { access_token, refresh_token, expires_in } = response.data;

    moloniTokens = {
      access_token,
      refresh_token,
      expires_at: Date.now() + expires_in * 1000,
    };

    console.log("Token renovado automaticamente.");
    return moloniTokens.access_token;
  } catch (error) {
    console.error(
      "Erro ao renovar o token:",
      error.response?.data || error.message
    );
    throw new Error("Não foi possível renovar o token.");
  }
}

// Login via username/password (not recommended for production)
app.post("/api/moloni-login", async (req, res) => {
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

    res.status(200).json({ access_token, refresh_token, expires_in });
  } catch (e) {
    res.status(400).json({ error: "moloni_login_failed", detail: String(e) });
  }
});

// Emit invoice
app.post("/api/emitir-fatura", async (req, res) => {
  const token = await getValidAccessToken(); // <-- Aqui vai buscar sempre o token válido

  const table = req.body;

  try {
    const response = await axios.post(
      `https://api.moloni.pt/v1/invoices/insert/?access_token=${token}`,
      {
        customer_id: 999999990, // ⚠️ Use a valid customer ID
        document_set_id: 843174, // ⚠️ Use a valid document set ID
        products: table.order.plates.map((name) => ({
          name,
          qty: 1,
          price: 10,
        })),
      }
    );

    res.status(200).json({ pdfUrl });
  } catch (e) {
    res.status(400).json({ error: "emitir_fatura_failed", detail: String(e) });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
