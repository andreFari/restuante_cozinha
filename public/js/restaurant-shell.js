import { restaurantApi, getOperatorId, setOperatorId } from "./restaurant-api.js";

const OPERATOR_BROADCAST = "restaurant-active-operator";

function getOperatorBroadcast() {
  try {
    if (!window.__restaurantOperatorChannel) {
      window.__restaurantOperatorChannel = new BroadcastChannel(OPERATOR_BROADCAST);
    }
    return window.__restaurantOperatorChannel;
  } catch {
    return null;
  }
}

function announceOperatorChange(operator) {
  const channel = getOperatorBroadcast();
  if (channel) {
    try { channel.postMessage(operator); } catch {}
  }
}

function resolveActiveOperator(operators = [], terminalContext = null) {
  const localOperatorId = getOperatorId();
  const fromLocal = operators.find((op) => op.id === localOperatorId) || null;
  if (fromLocal) return fromLocal;
  const fromTerminal = terminalContext?.operator?.id
    ? operators.find((op) => op.id === terminalContext.operator.id) || terminalContext.operator
    : null;
  return fromTerminal || null;
}

function updateOperatorUi(root, operator) {
  const nameNode = root.querySelector("#operatorCurrentName");
  const switcherBtn = root.querySelector("#operatorSwitcherBtn");
  if (nameNode) nameNode.textContent = operator?.name || "Selecionar pessoa";
  if (switcherBtn) switcherBtn.classList.toggle("is-active", Boolean(operator?.id));
  root.querySelectorAll(".operator-card").forEach((node) => {
    node.classList.toggle("selected", node.dataset.operatorId === operator?.id);
  });
}

export async function mountOperatorShell({
  rootSelector = "#operatorShell",
  title = "POS",
  eyebrow = "Restaurant OS",
}) {
  const root = document.querySelector(rootSelector);
  if (!root) return;

  const auth = await restaurantApi.getAuthSession().catch(() => ({ authenticated: false }));
  if (!auth?.authenticated) {
    window.location.replace("/login.html");
    return;
  }

  if (auth.is_admin) {
    setOperatorId(auth.user.id);
    root.innerHTML = `
      <div class="shell-topbar">
        <div>
          <div class="shell-eyebrow">${eyebrow}</div>
          <h1 class="shell-title">${title}</h1>
        </div>
        <div class="operator-pill-wrap">
          <label class="operator-pill-label">Sessão atual</label>
          <div class="operator-pill is-active">
            <span class="operator-pill-dot"></span>
            <span>${auth.user.name} · Admin</span>
          </div>
        </div>
      </div>
      <div class="callout" style="margin-bottom:16px;">
        <strong>Modo administrador</strong>
        <div class="helper-text">Sem seletor de trabalhador. As ações ficam ligadas à tua conta de admin.</div>
      </div>
    `;
    return;
  }

  const [operators, context] = await Promise.all([
    restaurantApi.listOperators(),
    restaurantApi.getOperatorContext(),
  ]);

  const visibleOperators = auth.user?.role === "kitchen"
    ? operators.filter((operator) => String(operator.role || "").toLowerCase() === "kitchen")
    : operators;

  const activeOperator = resolveActiveOperator(visibleOperators, context);
  if (activeOperator?.id) setOperatorId(activeOperator.id);

  root.innerHTML = `
    <div class="shell-topbar">
      <div>
        <div class="shell-eyebrow">${eyebrow}</div>
        <h1 class="shell-title">${title}</h1>
      </div>
      <div class="operator-pill-wrap">
        <label class="operator-pill-label">Pessoa ativa</label>
        <button id="operatorSwitcherBtn" class="operator-pill ${activeOperator?.id ? "is-active" : ""}">
          <span class="operator-pill-dot"></span>
          <span id="operatorCurrentName">${activeOperator?.name || "Selecionar pessoa"}</span>
        </button>
      </div>
    </div>
    <div id="operatorPanel" class="operator-panel hidden">
      <div class="operator-panel-head">
        <strong>Quem está a usar o sistema?</strong>
        <button id="operatorPanelClose" class="ghost-icon-btn">×</button>
      </div>
      <div class="operator-grid">
        ${visibleOperators
          .map(
            (op) => `
          <button class="operator-card ${activeOperator?.id === op.id ? "selected" : ""}" data-operator-id="${op.id}" data-operator-name="${op.name}">
            <span class="operator-card-name">${op.name}</span>
            <span class="operator-card-role">${op.role}</span>
          </button>`
          )
          .join("")}
      </div>
      <div class="operator-pin-row">
        <input id="operatorPinInput" type="password" maxlength="4" placeholder="PIN (opcional)" />
        <button id="operatorConfirmBtn" class="primary-btn">Confirmar</button>
      </div>
    </div>
  `;

  const switcherBtn = root.querySelector("#operatorSwitcherBtn");
  const panel = root.querySelector("#operatorPanel");
  const closeBtn = root.querySelector("#operatorPanelClose");
  const confirmBtn = root.querySelector("#operatorConfirmBtn");
  const pinInput = root.querySelector("#operatorPinInput");
  let selectedOperatorId = activeOperator?.id || "";

  switcherBtn?.addEventListener("click", () => panel.classList.toggle("hidden"));
  closeBtn?.addEventListener("click", () => panel.classList.add("hidden"));

  root.querySelectorAll(".operator-card").forEach((btn) => {
    btn.addEventListener("click", () => {
      root.querySelectorAll(".operator-card").forEach((node) => node.classList.remove("selected"));
      btn.classList.add("selected");
      selectedOperatorId = btn.dataset.operatorId || "";
    });
  });

  confirmBtn?.addEventListener("click", async () => {
    if (!selectedOperatorId) {
      toast("Seleciona uma pessoa primeiro.", true);
      return;
    }
    try {
      const result = await restaurantApi.selectOperator(selectedOperatorId, pinInput.value.trim());
      setOperatorId(result.operator.id);
      updateOperatorUi(root, result.operator);
      panel?.classList.add("hidden");
      if (pinInput) pinInput.value = "";
      announceOperatorChange(result.operator);
      toast(`Pessoa ativa: ${result.operator.name}`);
      document.dispatchEvent(new CustomEvent("restaurant:operator-changed", { detail: result.operator }));
    } catch (error) {
      toast(error.message || "Não foi possível trocar de pessoa.", true);
    }
  });

  const channel = getOperatorBroadcast();
  if (channel) {
    channel.onmessage = (event) => {
      const incoming = event.data;
      if (!incoming?.id) return;
      setOperatorId(incoming.id);
      updateOperatorUi(root, incoming);
    };
  }

  window.addEventListener("storage", (event) => {
    if (event.key !== "restaurant_operator_id") return;
    const incomingId = event.newValue || "";
    const incoming = operators.find((op) => op.id === incomingId) || null;
    updateOperatorUi(root, incoming);
  });
}

export function ensureOperatorSelected() {
  const operatorId = getOperatorId();
  if (!operatorId) {
    toast("Seleciona primeiro a pessoa ativa no sistema.", true);
    return false;
  }
  return true;
}

export function euro(value) {
  return new Intl.NumberFormat("pt-PT", {
    style: "currency",
    currency: "EUR",
  }).format(Number(value || 0));
}

export function toast(message, isError = false) {
  const node = document.createElement("div");
  node.className = `toast ${isError ? "error" : "success"}`;
  node.textContent = message;
  document.body.appendChild(node);
  requestAnimationFrame(() => node.classList.add("show"));
  setTimeout(() => {
    node.classList.remove("show");
    setTimeout(() => node.remove(), 180);
  }, 2500);
}

export function relativeMinutes(isoString) {
  if (!isoString) return "—";
  const diff = Math.max(0, Math.floor((Date.now() - new Date(isoString).getTime()) / 60000));
  return `${diff} min`;
}
