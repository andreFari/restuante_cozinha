import { restaurantApi, clearOperatorId, setOperatorId } from "./restaurant-api.js";

const ADMIN_ONLY_PAGES = new Set(["/menu.html", "/gest_mesas.html", "/trabalhadores.html"]);
const AUTH_CACHE_KEY = "restaurant_auth_session_cache";
const AUTH_CACHE_TTL_MS = 15000;

function getCachedAuth() {
  try {
    const raw = sessionStorage.getItem(AUTH_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (Number(parsed.expires_at || 0) < Date.now()) return null;
    return parsed.value || null;
  } catch {
    return null;
  }
}

function setCachedAuth(value) {
  try {
    sessionStorage.setItem(AUTH_CACHE_KEY, JSON.stringify({ value, expires_at: Date.now() + AUTH_CACHE_TTL_MS }));
  } catch {}
}

function clearCachedAuth() {
  try { sessionStorage.removeItem(AUTH_CACHE_KEY); } catch {}
}

const PROTECTED_PAGES = new Set([
  "/rececaoBar.html",
  "/rececaoCozi.html",
  "/takeway.html",
  "/cozinha.html",
  "/faturas.html",
  "/artigos.html",
  "/menu.html",
  "/gest_mesas.html",
  "/trabalhadores.html",
]);

function defaultPageFor(session) {
  if (session?.is_admin) return "/rececaoCozi.html";
  return "/rececaoCozi.html";
}

function ensureLogoutButton(session) {
  const header = document.querySelector("header");
  if (!header || document.getElementById("restaurantLogoutBtn")) return;
  const container = header.querySelector(".links-container") || header;
  const btn = document.createElement("button");
  btn.id = "restaurantLogoutBtn";
  btn.className = "ghost-btn";
  btn.type = "button";
  btn.textContent = "Terminar sessão";
  btn.style.marginLeft = "12px";
  btn.addEventListener("click", async () => {
    try {
      await restaurantApi.logout();
      clearCachedAuth();
    } catch {
      // ignore
    }
    clearOperatorId();
    window.location.replace("/login.html");
  });
  container.appendChild(btn);

  const tokenDisplay = document.getElementById("tokenDisplay");
  if (tokenDisplay) {
    tokenDisplay.textContent = `${session.user.name} · ${session.is_admin ? "Admin" : "Trabalhador"}`;
  }
}

function patchNav(session) {
  document.querySelectorAll('a[href="./login.html"], a[href="login.html"], a[href="/login.html"]').forEach((link) => {
    link.setAttribute("href", "./rececaoBar.html");
  });

  const nav = document.getElementById("navLinks");
  if (nav && !nav.querySelector('a[href="./trabalhadores.html"]') && session.is_admin) {
    const link = document.createElement("a");
    link.href = "./trabalhadores.html";
    link.className = "protected";
    link.textContent = "Trabalhadores";
    if (window.location.pathname.endsWith("/trabalhadores.html")) link.classList.add("active");
    nav.appendChild(link);
  }

  const adminSelectors = ['a[href="./menu.html"]', 'a[href="./gest_mesas.html"]', 'a[href="./trabalhadores.html"]'];
  adminSelectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((link) => {
      link.style.display = session.is_admin ? "inline-block" : "none";
    });
  });

  ['seedDemoBtn', 'resetDemoBtn'].forEach((id) => {
    const node = document.getElementById(id);
    if (node) node.style.display = session.is_admin ? '' : 'none';
  });
}

async function applyAuth() {
  const path = window.location.pathname === "/" ? "/login.html" : window.location.pathname;
  const isLogin = path.endsWith("/login.html") || path === "/login.html";
  const cached = getCachedAuth();
  let session = cached;
  if (!session) {
    session = await restaurantApi.getAuthSession().catch(() => ({ authenticated: false }));
    setCachedAuth(session);
  }

  if (isLogin) {
    if (session?.authenticated) {
      setOperatorId(session.user.id);
      setCachedAuth(session);
      window.location.replace(defaultPageFor(session));
    }
    return;
  }

  if (PROTECTED_PAGES.has(path) && !session?.authenticated) {
    clearCachedAuth();
    window.location.replace("/login.html");
    return;
  }

  if (ADMIN_ONLY_PAGES.has(path) && !session?.is_admin) {
    window.location.replace(defaultPageFor(session));
    return;
  }

  if (session?.authenticated) {
    setCachedAuth(session);
    if (session.is_admin) setOperatorId(session.user.id);
    window.__restaurantAuth = session;
    patchNav(session);
    ensureLogoutButton(session);
  }
}

window.addEventListener("DOMContentLoaded", applyAuth);
