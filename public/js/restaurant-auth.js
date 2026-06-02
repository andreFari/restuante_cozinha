import { restaurantApi, clearOperatorId, setOperatorId } from "./restaurant-api.js";

const ADMIN_ONLY_PAGES = new Set(["/assistente.html", "/faturas.html", "/gest_mesas.html", "/menu.html", "/trabalhadores.html"]);
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

const ROLE_ALLOWED_PAGES = {
  admin: null,
  kitchen: new Set(["/cozinha.html", "/artigos.html"]),
  employee: new Set(["/rececaoBar.html", "/rececaoCozi.html", "/takeway.html", "/cozinha.html", "/artigos.html"]),
  bar: new Set(["/rececaoBar.html", "/rececaoCozi.html", "/takeway.html", "/cozinha.html", "/artigos.html"]),
  manager: new Set(["/rececaoBar.html", "/rececaoCozi.html", "/takeway.html", "/cozinha.html", "/artigos.html"]),
};

const PROTECTED_PAGES = new Set([
  "/rececaoBar.html",
  "/rececaoCozi.html",
  "/takeway.html",
  "/cozinha.html",
  "/faturas.html",
  "/artigos.html",
  "/assistente.html",
  "/menu.html",
  "/gest_mesas.html",
  "/trabalhadores.html",
]);

function roleLabel(session) {
  const role = String(session?.user?.role || "").toLowerCase();
  if (session?.is_admin || role === "admin") return "Admin";
  if (role === "kitchen") return "Cozinha";
  if (role === "bar") return "Bar";
  if (role === "manager") return "Gestor";
  return "Trabalhador";
}

function defaultPageFor(session) {
  if (session?.is_admin) return "/rececaoCozi.html";
  if (String(session?.user?.role || "").toLowerCase() === "kitchen") return "/cozinha.html";
  return "/rececaoCozi.html";
}

function canAccessPage(session, path) {
  if (!PROTECTED_PAGES.has(path)) return true;
  if (!session?.authenticated) return false;
  if (session?.is_admin) return true;
  const role = String(session?.user?.role || "").toLowerCase() || "employee";
  const allowed = ROLE_ALLOWED_PAGES[role] || ROLE_ALLOWED_PAGES.employee;
  return allowed ? allowed.has(path) : true;
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
    tokenDisplay.textContent = `${session.user.name} · ${roleLabel(session)}`;
  }
}

function isCurrentPath(href) {
  const path = window.location.pathname === "/" ? "/login.html" : window.location.pathname;
  return path.endsWith(href.replace(".", ""));
}

function navLink(href, label, { activeWhen = href, extraClass = "" } = {}) {
  const active = isCurrentPath(activeWhen);
  return `<a href="${href}" class="protected${active ? " active" : ""}${extraClass ? ` ${extraClass}` : ""}">${label}</a>`;
}

function renderGroupedNav(session) {
  const nav = document.getElementById("navLinks");
  if (!nav) return;
  const role = String(session?.user?.role || "").toLowerCase();
  const isKitchen = role === "kitchen" && !session.is_admin;
  const managementPaths = ["/assistente.html", "/menu.html", "/gest_mesas.html", "/faturas.html", "/trabalhadores.html"];
  const managementActive = managementPaths.some((path) => isCurrentPath(path));

  const actionLinks = [
    !isKitchen ? navLink("./takeway.html", "Takeaway") : "",
    !isKitchen ? navLink("./rececaoBar.html", "Receção Bar") : "",
    !isKitchen ? navLink("./rececaoCozi.html", "Receção Cozinha") : "",
    navLink("./cozinha.html", "Cozinha"),
    navLink("./artigos.html", "Pratos"),
  ].filter(Boolean).join("\n          ");

  const managementLinks = session.is_admin ? `
          <details class="nav-group admin-nav-group"${managementActive ? " open" : ""}>
            <summary class="${managementActive ? "active" : ""}">Gestão</summary>
            <div class="nav-group-menu">
              ${navLink("./assistente.html", "Assistente")}
              ${navLink("./menu.html", "Menus")}
              ${navLink("./gest_mesas.html", "Mesas")}
              ${navLink("./faturas.html", "Faturas")}
              ${navLink("./trabalhadores.html", "Utilizadores")}
            </div>
          </details>` : "";

  nav.classList.add("nav-compact");
  nav.innerHTML = `
          <span class="nav-section-label">Ação</span>
          ${actionLinks}
          ${managementLinks}`;
}

function patchNav(session) {
  document.querySelectorAll('a[href="./login.html"], a[href="login.html"], a[href="/login.html"]').forEach((link) => {
    link.setAttribute("href", defaultPageFor(session));
  });

  renderGroupedNav(session);

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

  if (session?.authenticated && !canAccessPage(session, path)) {
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
