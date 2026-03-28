import express from "express";
import axios from "axios";
import { URLSearchParams } from "url";
import { moloniTokens } from "../moloniAuth.js";

const router = express.Router();

const CLIENT_ID = process.env.MOLONI_CLIENT_ID;
const CLIENT_SECRET = process.env.MOLONI_CLIENT_SECRET;
const REDIRECT_URI = process.env.MOLONI_CALLBACK_URL;

router.post("/login-moloni", async (req, res) => {
  const { username, password } = req.body || {};

  try {
    const url = `https://api.moloni.pt/v1/grant/?grant_type=password&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&username=${encodeURIComponent(
      username
    )}&password=${encodeURIComponent(password)}`;

    const { data } = await axios.post(url);

    if (data.error) {
      return res.status(401).json({ error: "invalid_credentials", detail: data });
    }

    moloniTokens.access_token = data.access_token;
    moloniTokens.refresh_token = data.refresh_token;
    moloniTokens.expires_at = Date.now() + Number(data.expires_in) * 1000;

    return res.json({ message: "Login bem-sucedido" });
  } catch (error) {
    return res.status(500).json({ error: "login_failed", detail: error.message });
  }
});

router.get("/moloni-token-status", (req, res) => {
  const valid = moloniTokens.access_token && moloniTokens.expires_at > Date.now() + 60000;
  return res.json({ valid });
});

router.post("/moloni-login", async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Faltam parâmetros username e password" });
  }

  const params = new URLSearchParams({
    grant_type: "password",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    username,
    password,
  });

  try {
    const response = await fetch("https://api.moloni.pt/v1/grant/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const data = await response.json();

    if (data.error) {
      return res.status(401).json(data);
    }

    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: "Erro ao comunicar com a Moloni." });
  }
});

router.post("/moloni-exchange-code", async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) {
      return res.status(400).json({ error: "Missing code" });
    }

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
    moloniTokens.access_token = access_token;
    moloniTokens.refresh_token = refresh_token;
    moloniTokens.expires_at = Date.now() + Number(expires_in) * 1000;

    return res.json(response.data);
  } catch (error) {
    return res.status(500).json({
      error: "Failed to exchange code",
      detail: error.response?.data || error.message,
    });
  }
});

export function mountMoloniBrowserAuth(app) {
  app.get("/auth", (req, res) => {
    const redirect = new URL("https://api.moloni.pt/v1/authorize/");
    redirect.searchParams.set("response_type", "code");
    redirect.searchParams.set("client_id", CLIENT_ID);
    redirect.searchParams.set("redirect_uri", REDIRECT_URI);
    res.redirect(redirect.toString());
  });

  app.get("/callback", (req, res) => {
    const { code } = req.query;
    if (!code) {
      return res.status(400).send("Falta o parâmetro 'code'.");
    }
    return res.redirect(`/login.html?code=${encodeURIComponent(code)}`);
  });
}

export default router;
