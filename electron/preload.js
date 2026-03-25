const { contextBridge } = require("electron");

async function fetchJson(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:5500${path}`, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

contextBridge.exposeInMainWorld("qvmApp", {
  isElectron: true,
  getBatchStatus: () => fetchJson("/api/orchestrator/status"),
  startBatch: (config = {}) => fetchJson("/api/orchestrator/start", {
    method: "POST",
    body: JSON.stringify(config)
  }),
  stopBatch: () => fetchJson("/api/orchestrator/stop", {
    method: "POST",
    body: JSON.stringify({})
  })
});
