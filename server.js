import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = 3000;

const CLIENT_ID = process.env.MOLONI_CLIENT_ID;
const CLIENT_SECRET = process.env.MOLONI_CLIENT_SECRET;
const REDIRECT_URI = process.env.MOLONI_CALLBACK_URL;

app.get("/", (req, res) => {
  res.send(`
    <h1>Login with Moloni</h1>
    <a href="https://auth.moloni.pt/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(
    REDIRECT_URI
  )}&scope=DOCUMENTS_READ DOCUMENTS_WRITE">
      Login with Moloni
    </a>
  `);
});

app.get("/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.send("No authorization code received.");
  }

  try {
    const response = await axios.post(
      "https://auth.moloni.pt/oauth/token",
      null,
      {
        params: {
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code,
          redirect_uri: REDIRECT_URI,
        },
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const data = response.data;

    res.send(`
      <h1>Access Token Received</h1>
      <p><strong>Access Token:</strong> ${data.access_token}</p>
      <p><strong>Refresh Token:</strong> ${data.refresh_token}</p>
      <p>You can now use this token to call Moloni API endpoints.</p>
    `);
  } catch (error) {
    res.send(
      `Error fetching access token: ${
        error.response?.data?.error_description || error.message
      }`
    );
  }
});

app.listen(port, () => {
  console.log(`App listening at http://localhost:${port}`);
});
