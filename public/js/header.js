async function loadHeader() {
  const placeholder = document.getElementById("header-placeholder");
  if (!placeholder) return;

  try {
    const response = await fetch("./header.html");
    const headerHTML = await response.text();
    placeholder.innerHTML = headerHTML;

    initHeader(); // inicializa comportamento após carregar
  } catch (err) {
    console.error("Erro ao carregar o header:", err);
  }
}

function initHeader() {
  const tokenDisplay = document.getElementById("tokenDisplay");

  // Esconder links protegidos por default
  document.querySelectorAll(".protected").forEach((el) => {
    el.style.display = "none";
  });

  // Mostrar se token válido
  const token = localStorage.getItem("moloni_token");
  if (token) {
    document.querySelectorAll(".protected").forEach((el) => {
      el.style.display = "inline-block";
    });
    if (tokenDisplay) tokenDisplay.textContent = "✔️ Sistema pronto a usar";
  } else {
    if (tokenDisplay) tokenDisplay.textContent = "⚠️ Sistema não autenticado";
  }
}

document.addEventListener("DOMContentLoaded", loadHeader);
