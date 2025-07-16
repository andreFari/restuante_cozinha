import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import qs from "querystring";

dotenv.config();

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

  if (!code) return res.send("No authorization code received.");
console.log("Exchanging code for token with data:", {
  client_id: CLIENT_ID,
  client_secret: CLIENT_SECRET,
  code,
  redirect_uri: REDIRECT_URI,
});
  try {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
    });

    console.log("Token request params:", params.toString());
console.error("Raw error:", error.toJSON?.() || error.message);
    const response = await axios.post(
      "https://auth.moloni.pt/oauth/token",
      params.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const { access_token } = response.data;
    console.log("Authorization code received:", code);
    // Redirect to login.html and pass the access token
    return res.redirect(`/login.html?error=${encodeURIComponent('Erro ao obter token')}`);

  } catch (error) {
    console.error(
      "Token exchange error:",
      error.response?.status,
      error.response?.data || error.message
    );

    res
      .status(500)
      .send(
        `Error fetching access token: ${
          JSON.stringify(error.response?.data || error.message)
        }`
      );
  }
});

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

    res.json(response.data);
  } catch (error) {
    console.error("Moloni login error:", error.response?.data || error.message);
    res.status(400).send(error.response?.data || "Erro desconhecido");
  }
});

// Emit invoice
app.post("/api/emitir-fatura", async (req, res) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }

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

    res.json({ pdfUrl: response.data.pdf_url || "https://moloni.pt/fake.pdf" });
  } catch (error) {
    console.error("Emit invoice error:", error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
