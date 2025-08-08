import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const CLIENT_ID = process.env.MOLONI_CLIENT_ID;
const CLIENT_SECRET = process.env.MOLONI_CLIENT_SECRET;

export const moloniTokens = {
  access_token: null,
  refresh_token: null,
  expires_at: null,
};
export function getCompanyId() {
  return Number(process.env.COMPANY_ID);
}
export async function getValidAccessToken() {
  if (
    moloniTokens.access_token &&
    moloniTokens.expires_at &&
    moloniTokens.expires_at > Date.now() + 60000
  ) {
    return moloniTokens.access_token;
  }

  if (!moloniTokens.refresh_token) {
    throw new Error(
      "Refresh token inexistente. É necessário autenticar novamente (OAuth)."
    );
  }

  try {
    const { data } = await axios.get("https://api.moloni.pt/v1/grant/", {
      params: {
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: moloniTokens.refresh_token,
      },
    });

    const { access_token, refresh_token, expires_in } = data;
    moloniTokens.access_token = access_token;
    moloniTokens.refresh_token = refresh_token;
    moloniTokens.expires_at = Date.now() + Number(expires_in) * 1000;

    console.log("[Moloni] Token renovado.");
    return moloniTokens.access_token;
  } catch (error) {
    console.error(
      "[Moloni] Falha ao renovar token:",
      error.response?.data || error.message
    );
    throw new Error("Não foi possível renovar o token.");
  }
}
