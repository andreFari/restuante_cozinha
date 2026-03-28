import { restaurantApi, getOperatorId, setOperatorId } from "./restaurant-api.js";

export async function mountOperatorShell({
  rootSelector = "#operatorShell",
  title = "POS",
  eyebrow = "Restaurant OS",
}) {
  const root = document.querySelector(rootSelector);
  if (!root) return;

  const [operators, context] = await Promise.all([
    restaurantApi.listOperators(),
    restaurantApi.getOperatorContext(),
  ]);

  if (context?.operator?.id) {
    setOperatorId(context.operator.id);
  }

  root.innerHTML = `
    <div class="shell-topbar">
      <div>
        <div class="shell-eyebrow">${eyebrow}</div>
        <h1 class="shell-title">${title}</h1>
      </div>
      <div class="operator-pill-wrap">
        <label class="operator-pill-label">Pessoa ativa</label>
        <button id="operatorSwitcherBtn" class="operator-pill ${getOperatorId() ? "is-active" : ""}">
          <span class="operator-pill-dot"></span>
          <span id="operatorCurrentName">${context?.operator?.name || "Selecionar pessoa"}</span>
        </button>
      </div>
    </div>
    <div id="operatorPanel" class="operator-panel hidden">
      <div class="operator-panel-head">
        <strong>Quem está a usar este posto?</strong>
        <button id="operatorPanelClose" class="ghost-icon-btn">×</button>
      </div>
      <div class="operator-grid">
        ${operators
          .map(
            (op) => `
          <button class="operator-card ${context?.operator?.id === op.id ? "selected" : ""}" data-operator-id="${op.id}" data-operator-name="${op.name}">
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
  let selectedOperatorId = context?.operator?.id || getOperatorId();

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
      const nameNode = root.querySelector("#operatorCurrentName");
      if (nameNode) nameNode.textContent = result.operator.name;
      switcherBtn?.classList.add("is-active");
      panel?.classList.add("hidden");
      if (pinInput) pinInput.value = "";
      toast(`Operador ativo: ${result.operator.name}`);
      document.dispatchEvent(new CustomEvent("restaurant:operator-changed", { detail: result.operator }));
    } catch (error) {
      toast(error.message || "Não foi possível trocar de pessoa.", true);
    }
  });
}

export function ensureOperatorSelected() {
  const operatorId = getOperatorId();
  if (!operatorId) {
    toast("Seleciona primeiro a pessoa ativa neste posto.", true);
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
