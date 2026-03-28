import os from "os";

const AGENT_ID = os.hostname();
const agents = new Map();
const agentSockets = new Map();

function listRegisteredPrinters() {
  return Array.from(agents.entries()).flatMap(([agent_id, info]) =>
    (info.printers || []).map((printer) => ({
      ...printer,
      agent_id,
      lastSeen: info.lastSeen,
    }))
  );
}

function registerAgent({ agent_id, printers = [] }) {
  agents.set(agent_id, {
    lastSeen: new Date(),
    printers,
  });

  return {
    ok: true,
    agent_id,
    printers_count: printers.length,
  };
}

function touchAgent(agent_id) {
  const info = agents.get(agent_id);
  if (!info) return null;
  info.lastSeen = new Date();
  return info;
}

function bindAgentSocket(agent_id, socket) {
  agentSockets.set(agent_id, socket);
  touchAgent(agent_id);
}

function unbindSocket(socket) {
  for (const [agent_id, agentSocket] of agentSockets.entries()) {
    if (agentSocket === socket) {
      agentSockets.delete(agent_id);
    }
  }
}

function getAgentSocket(agent_id) {
  return agentSockets.get(agent_id) || null;
}

function cleanupInactiveAgents(maxIdleMs = 5 * 60 * 1000) {
  const cutoff = Date.now() - maxIdleMs;
  for (const [agent_id, info] of agents.entries()) {
    if (info.lastSeen?.getTime?.() < cutoff) {
      agents.delete(agent_id);
      agentSockets.delete(agent_id);
    }
  }
}

function initPrintingSockets(io, agentToken) {
  io.on("connection", (socket) => {
    console.log("🔌 Novo socket conectado");

    socket.on("register_agent", ({ agent_id, token }) => {
      if (token !== agentToken) {
        socket.disconnect();
        return;
      }
      bindAgentSocket(agent_id, socket);
      console.log(`✅ Agent ${agent_id} autenticado via socket`);
    });

    socket.on("disconnect", () => {
      unbindSocket(socket);
    });
  });
}

setInterval(() => cleanupInactiveAgents(), 60000);

export const printersService = {
  AGENT_ID,
  registerAgent,
  listRegisteredPrinters,
  getAgentSocket,
  initPrintingSockets,
  cleanupInactiveAgents,
};
