import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getAddress, recoverMessageAddress } from "viem";
import { claimDemoFaucet, demoFaucetAllowedOrigins, demoFaucetStatus } from "./demo-faucet.mjs";
import { createTelegramLink, pollTelegramLinkUpdates, telegramLinkStatus, unlinkTelegram } from "./telegram-links.mjs";

const port = Number(process.env.KEEPER_HEALTH_PORT ?? 8787);
const healthPath = process.env.KEEPER_HEALTH_PATH ?? "keeper/health.json";
const ruleSettingsPath = process.env.KEEPER_RULE_SETTINGS_PATH ?? "keeper/rule-settings.json";
const registeredExecutorsPath = process.env.KEEPER_REGISTERED_EXECUTORS_PATH ?? "keeper/registered-executors.json";
const allowedOrigins = new Set(["http://127.0.0.1:5173", "http://localhost:5173"]);
for (const origin of demoFaucetAllowedOrigins()) allowedOrigins.add(origin);

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 10_000) throw new Error("Request body is too large.");
  }
  return JSON.parse(body);
}

async function saveRuleSettings(settings) {
  await mkdir(dirname(ruleSettingsPath), { recursive: true });
  const temporaryPath = `${ruleSettingsPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(temporaryPath, ruleSettingsPath);
}

async function loadRegisteredExecutors() {
  try {
    const stored = JSON.parse(await readFile(registeredExecutorsPath, "utf8"));
    return Array.isArray(stored.executors) ? stored : { executors: [] };
  } catch (error) {
    if (error.code === "ENOENT") return { executors: [] };
    throw error;
  }
}

async function saveRegisteredExecutors(registry) {
  await mkdir(dirname(registeredExecutorsPath), { recursive: true });
  const temporaryPath = `${registeredExecutorsPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  await rename(temporaryPath, registeredExecutorsPath);
}

const server = createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (origin && allowedOrigins.has(origin)) response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "OPTIONS") {
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.writeHead(204).end();
    return;
  }
  if (request.method === "POST" && request.url === "/keeper/register") {
    try {
      if (!origin || !allowedOrigins.has(origin)) throw new Error("An approved app origin is required.");
      const { message, signature } = await readJsonBody(request);
      const jsonStart = message.indexOf("\n{");
      const command = JSON.parse(jsonStart === -1 ? message : message.slice(jsonStart + 1));
      if (command.action !== "take-profit-keeper-register" || command.chainId !== 10143 || command.version !== "v3") throw new Error("Unexpected keeper registration command.");
      if (!Number.isInteger(command.issuedAt) || Math.abs(Date.now() - command.issuedAt) > 5 * 60_000) throw new Error("Keeper registration signature expired. Please try again.");
      const owner = getAddress(command.owner);
      const executor = getAddress(command.executor);
      const signer = await recoverMessageAddress({ message, signature });
      if (signer.toLowerCase() !== owner.toLowerCase()) throw new Error("Signature must belong to the executor owner.");
      const registry = await loadRegisteredExecutors();
      const key = `${executor.toLowerCase()}:${owner.toLowerCase()}`;
      registry.executors = registry.executors.filter((item) => `${item.executor.toLowerCase()}:${item.owner.toLowerCase()}` !== key);
      registry.executors.push({ version: "v3", executor, owner, registeredAt: new Date().toISOString() });
      await saveRegisteredExecutors(registry);
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.writeHead(200).end(JSON.stringify({ ok: true, version: "v3", executor, owner }));
    } catch (error) {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : "Could not register the keeper." }));
    }
    return;
  }
  if (request.method === "POST" && request.url === "/rule-settings") {
    try {
      if (!origin || !allowedOrigins.has(origin)) throw new Error("Local app origin is required.");
      const payload = await readJsonBody(request);
      const { message, signature } = payload;
      const jsonStart = message.indexOf("\n{");
      const command = JSON.parse(jsonStart === -1 ? message : message.slice(jsonStart + 1));
      if (command.action !== "take-profit-rule-settings" || command.chainId !== 10143) throw new Error("Unexpected rule-settings command.");
      if (!/^\d+$/.test(command.policyId) || !Number.isInteger(command.maxGas) || command.maxGas < 21_000 || command.maxGas > 500_000) throw new Error("Invalid rule settings.");
      if (!Number.isInteger(command.issuedAt) || Math.abs(Date.now() - command.issuedAt) > 5 * 60_000) throw new Error("Rule-settings signature expired. Please try again.");
      const owner = getAddress(command.owner);
      const executor = getAddress(command.executor);
      const signer = await recoverMessageAddress({ message, signature });
      if (signer.toLowerCase() !== owner.toLowerCase()) throw new Error("Signature must belong to the rule owner.");
      let settings = { rules: {} };
      try { settings = JSON.parse(await readFile(ruleSettingsPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const key = `${executor.toLowerCase()}:${owner.toLowerCase()}:${command.policyId}`;
      settings.rules[key] = { executor, owner, policyId: command.policyId, maxGas: command.maxGas, updatedAt: new Date().toISOString() };
      await saveRuleSettings(settings);
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.writeHead(200).end(JSON.stringify({ ok: true, maxGas: command.maxGas }));
    } catch (error) {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : "Could not save rule settings." }));
    }
    return;
  }
  if (request.method === "GET" && request.url?.startsWith("/telegram/status")) {
    try {
      const address = new URL(request.url, "http://localhost").searchParams.get("address");
      if (!address) throw new Error("Wallet address is required.");
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.writeHead(200).end(JSON.stringify(await telegramLinkStatus(address)));
    } catch (error) {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : "Could not read Telegram status." }));
    }
    return;
  }
  if (request.method === "POST" && request.url === "/telegram/link") {
    try {
      if (!origin || !allowedOrigins.has(origin)) throw new Error("An approved app origin is required.");
      const payload = await createTelegramLink(await readJsonBody(request));
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.writeHead(200).end(JSON.stringify(payload));
    } catch (error) {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : "Could not create Telegram link." }));
    }
    return;
  }
  if (request.method === "POST" && request.url === "/telegram/unlink") {
    try {
      if (!origin || !allowedOrigins.has(origin)) throw new Error("An approved app origin is required.");
      const payload = await unlinkTelegram(await readJsonBody(request));
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.writeHead(200).end(JSON.stringify(payload));
    } catch (error) {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : "Could not disconnect Telegram." }));
    }
    return;
  }
  if (request.method === "GET" && request.url?.startsWith("/faucet/status")) {
    try {
      const address = new URL(request.url, "http://localhost").searchParams.get("address");
      const payload = await demoFaucetStatus(address);
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.writeHead(200).end(JSON.stringify(payload));
    } catch (error) {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : "Could not read faucet status." }));
    }
    return;
  }
  if (request.method === "POST" && request.url === "/faucet/claim") {
    try {
      if (!origin || !allowedOrigins.has(origin)) throw new Error("An approved app origin is required.");
      const payload = await claimDemoFaucet(await readJsonBody(request));
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.writeHead(200).end(JSON.stringify(payload));
    } catch (error) {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : "Demo Faucet claim failed." }));
    }
    return;
  }
  if (request.method !== "GET" || request.url !== "/health") {
    response.writeHead(404).end();
    return;
  }
  try {
    const payload = await readFile(healthPath, "utf8");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.writeHead(200).end(payload);
  } catch {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.writeHead(503).end(JSON.stringify({ error: "Keeper has not completed a check yet." }));
  }
});

server.listen(port, "0.0.0.0", () => console.log(`Keeper health API listening on port ${port}.`));

if (process.env.TELEGRAM_BOT_TOKEN) {
  pollTelegramLinkUpdates().catch((error) => console.warn(`Initial Telegram link poll failed: ${error instanceof Error ? error.message : String(error)}`));
  setInterval(() => pollTelegramLinkUpdates().catch((error) => console.warn(`Telegram link poll failed: ${error instanceof Error ? error.message : String(error)}`)), 5_000).unref();
}
