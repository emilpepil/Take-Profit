import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, formatUnits, getAddress, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { telegramChatIdForWallet } from "./telegram-links.mjs";

const MONAD_TESTNET_CHAIN_ID = 10143;
const EXPECTED_KEEPER = "0xD88394629BbE7Be91B1eFE6E984e7aCb118edd8B";
const statePath = "keeper/state.json";
const notificationLockPath = "keeper/notification.lock";
const executionStatePath = "keeper/auto-execution-state.json";
const executionLockPath = "keeper/auto-execution.lock";
const healthPath = process.env.KEEPER_HEALTH_PATH ?? "keeper/health.json";
const registeredExecutorsPath = process.env.KEEPER_REGISTERED_EXECUTORS_PATH ?? "keeper/registered-executors.json";
const AUTO_EXECUTE_CONFIRMATION = "MONAD_TESTNET_JAMES_ONCE";
// Monad charges by the configured gas limit, so this is a hard safety ceiling.
// Individual executions must still supply their own lower cap in configuration.
const MAX_AUTOMATION_GAS_LIMIT = 4_000_000;
// On Monad the submitted limit is charged, so choose the first tier that safely
// covers the estimate instead of submitting an unnecessarily expensive 4M limit.
const AUTOMATIC_GAS_TIERS = [500_000n, 1_000_000n, 2_000_000n, 3_000_000n, 4_000_000n];
const MAX_PRE_BROADCAST_RPC_RETRIES = 2;
const vaults = [
  { symbol: "JAMES", asset: "0x8f32e211244706c9b0902a9bd823e1c768a032c2", vault: "0x88760064022811c60771fd5fb574895361189a2d" },
  { symbol: "EMO", asset: "0x3d07c291cc9a7eaa11fa2f2bd2894643c0923e6c", vault: "0x59f70bfabce71c8463ee97295e5af60ae4d05492" },
  { symbol: "CHOG", asset: "0x6bf60cc379ad2c76ebf4c1d4f0ef528427483313", vault: "0xe7f348cf2cfb94428784e6480f046df86fe826f1" },
].map((vault) => ({ ...vault, asset: getAddress(vault.asset), vault: getAddress(vault.vault) }));
const usdm = getAddress("0x0f1471d41e25e7880a3c3021dfcb5efb29079f71");

const vaultAbi = [
  { type: "function", name: "keeper", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "spotPriceE18", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "takeProfitPriceE18", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "rebalancePriceE18", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "tradeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "executePolicy", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint8" }, { type: "uint256" }] },
];
const erc20Abi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];
const eoaExecutorAbi = [
  { type: "function", name: "spotPriceE18", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "policies", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint16" }, { type: "bool" }] },
  { type: "function", name: "executePolicy", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];
const eoaExecutorV2Abi = [
  { type: "function", name: "asset", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "spotPriceE18", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "policyCount", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "policies", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint16" }, { type: "bool" }] },
  { type: "function", name: "executePolicy", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
];
const eoaExecutorV2ExecutionEvent = [{ type: "event", name: "PolicyExecuted", anonymous: false, inputs: [{ indexed: true, name: "owner", type: "address" }, { indexed: true, name: "policyId", type: "uint256" }, { indexed: false, name: "spotPriceE18", type: "uint256" }, { indexed: false, name: "amountIn", type: "uint256" }, { indexed: false, name: "amountOut", type: "uint256" }] }];
const V2_READ_SPACING_MS = 125;

function readEnv(source) {
  return Object.fromEntries(source.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1).trim()];
  }));
}

function actionFor({ price, takeProfit, rebalance, assetBalance, stableBalance, tradeBps }) {
  if (price >= takeProfit && assetBalance > 0n) return `take-profit: sell ${formatUnits(assetBalance * BigInt(tradeBps) / 10_000n, 18)} asset`;
  if (price <= rebalance && stableBalance > 0n) return `rebalance: buy asset with ${formatUnits(stableBalance * BigInt(tradeBps) / 10_000n, 6)} USDm`;
  return "no action";
}

function telegramEnabled(env) {
  return env.KEEPER_TELEGRAM_ENABLED === "true";
}

function autoExecuteEnabled(env) {
  return env.AUTO_EXECUTE === "true";
}

function autoExecuteConfiguration(env) {
  if (!autoExecuteEnabled(env)) return null;
  if (env.AUTO_EXECUTE_CONFIRMATION !== AUTO_EXECUTE_CONFIRMATION) {
    throw new Error(`Set AUTO_EXECUTE_CONFIRMATION=${AUTO_EXECUTE_CONFIRMATION} before enabling automatic execution.`);
  }
  if (env.AUTO_EXECUTE_SYMBOL !== "JAMES") {
    throw new Error("Automatic execution is restricted to AUTO_EXECUTE_SYMBOL=JAMES for this first test.");
  }
  const maxGas = Number(env.AUTO_EXECUTE_MAX_GAS ?? 300_000);
  if (!Number.isInteger(maxGas) || maxGas < 21_000 || maxGas > MAX_AUTOMATION_GAS_LIMIT) {
    throw new Error(`AUTO_EXECUTE_MAX_GAS must be an integer between 21000 and ${MAX_AUTOMATION_GAS_LIMIT}.`);
  }
  return { symbol: env.AUTO_EXECUTE_SYMBOL, maxGas: BigInt(maxGas) };
}

function eoaRuleConfiguration(env) {
  if (env.EOA_JAMES_EXECUTOR_V3 && env.EOA_RULE_OWNER) return { version: "v3", executor: getAddress(env.EOA_JAMES_EXECUTOR_V3), owner: getAddress(env.EOA_RULE_OWNER) };
  if (env.EOA_JAMES_EXECUTOR_V2 && env.EOA_RULE_OWNER) return { version: "v2", executor: getAddress(env.EOA_JAMES_EXECUTOR_V2), owner: getAddress(env.EOA_RULE_OWNER) };
  if (!env.EOA_JAMES_EXECUTOR || !env.EOA_RULE_OWNER) return null;
  return { version: "v1", executor: getAddress(env.EOA_JAMES_EXECUTOR), owner: getAddress(env.EOA_RULE_OWNER) };
}

async function eoaRuleConfigurations(env) {
  const configurations = [];
  const configured = eoaRuleConfiguration(env);
  if (configured) configurations.push(configured);
  try {
    const registry = JSON.parse(await readFile(registeredExecutorsPath, "utf8"));
    for (const item of registry.executors ?? []) {
      if (item?.version !== "v3") continue;
      configurations.push({ version: "v3", executor: getAddress(item.executor), owner: getAddress(item.owner) });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const seen = new Set();
  return configurations.filter((item) => {
    const key = `${item.version}:${item.executor.toLowerCase()}:${item.owner.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function eoaV2AutoExecutionConfiguration(env, rule) {
  if (env.EOA_V2_AUTO_EXECUTE_ALL === "true") return null;
  if (env.EOA_V2_AUTO_EXECUTE !== "true") return null;
  if (!rule || rule.version !== "v2") throw new Error("EOA_V2_AUTO_EXECUTE requires an EOA_JAMES_EXECUTOR_V2 and EOA_RULE_OWNER.");
  if (env.EOA_V2_AUTO_EXECUTE_CONFIRMATION !== "MONAD_TESTNET_JAMES_V2_ONCE") {
    throw new Error("Set EOA_V2_AUTO_EXECUTE_CONFIRMATION=MONAD_TESTNET_JAMES_V2_ONCE before enabling V2 automatic execution.");
  }
  if (!env.EOA_V2_AUTO_EXECUTE_POLICY_ID || !/^\d+$/.test(env.EOA_V2_AUTO_EXECUTE_POLICY_ID) || BigInt(env.EOA_V2_AUTO_EXECUTE_POLICY_ID) < 1n) {
    throw new Error("EOA_V2_AUTO_EXECUTE_POLICY_ID must be one explicit positive policy ID.");
  }
  if (!env.EOA_V2_AUTO_EXECUTE_MAX_AMOUNT) throw new Error("EOA_V2_AUTO_EXECUTE_MAX_AMOUNT is required, for example 0.01.");
  const maxAmount = parseUnits(env.EOA_V2_AUTO_EXECUTE_MAX_AMOUNT, 18);
  if (maxAmount <= 0n) throw new Error("EOA_V2_AUTO_EXECUTE_MAX_AMOUNT must be positive.");
  const maxGas = Number(env.EOA_V2_AUTO_EXECUTE_MAX_GAS ?? 300_000);
  if (!Number.isInteger(maxGas) || maxGas < 21_000 || maxGas > MAX_AUTOMATION_GAS_LIMIT) {
    throw new Error(`EOA_V2_AUTO_EXECUTE_MAX_GAS must be an integer between 21000 and ${MAX_AUTOMATION_GAS_LIMIT}.`);
  }
  return { policyId: BigInt(env.EOA_V2_AUTO_EXECUTE_POLICY_ID), maxAmount, maxGas: BigInt(maxGas) };
}

function eoaV2AllAutoExecutionConfiguration(env, rule) {
  const version = rule?.version === "v3" ? "V3" : "V2";
  const prefix = `EOA_${version}`;
  if (env[`${prefix}_AUTO_EXECUTE_ALL`] !== "true") return null;
  if (!rule || (rule.version !== "v2" && rule.version !== "v3")) throw new Error(`${prefix}_AUTO_EXECUTE_ALL requires its executor and EOA_RULE_OWNER.`);
  if (env[`${prefix}_AUTO_EXECUTE`] === "true") throw new Error(`Choose either one-policy or all-ready ${version} execution, not both.`);
  if (env[`${prefix}_AUTO_EXECUTE_CONFIRMATION`] !== `MONAD_TESTNET_JAMES_${version}_ALL`) {
    throw new Error(`Set ${prefix}_AUTO_EXECUTE_CONFIRMATION=MONAD_TESTNET_JAMES_${version}_ALL before enabling all-ready ${version} execution.`);
  }
  const maxGas = Number(env[`${prefix}_AUTO_EXECUTE_MAX_GAS`] ?? MAX_AUTOMATION_GAS_LIMIT);
  if (!Number.isInteger(maxGas) || maxGas < 21_000 || maxGas > MAX_AUTOMATION_GAS_LIMIT) {
    throw new Error(`EOA_V2_AUTO_EXECUTE_MAX_GAS must be an integer between 21000 and ${MAX_AUTOMATION_GAS_LIMIT}.`);
  }
  if (!env[`${prefix}_AUTO_EXECUTE_ALL_MAX_TOTAL_AMOUNT`]) throw new Error(`${prefix}_AUTO_EXECUTE_ALL_MAX_TOTAL_AMOUNT is required.`);
  const maxTotalAmount = parseUnits(env[`${prefix}_AUTO_EXECUTE_ALL_MAX_TOTAL_AMOUNT`], 18);
  if (maxTotalAmount <= 0n) throw new Error(`${prefix}_AUTO_EXECUTE_ALL_MAX_TOTAL_AMOUNT must be positive.`);
  return { maxGas: BigInt(maxGas), maxTotalAmount };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function loadNotificationState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error("Could not read keeper notification state.");
  }
}

async function saveNotificationState(state) {
  await mkdir("keeper", { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function loadExecutionState() {
  try {
    return JSON.parse(await readFile(executionStatePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { successfulExecutions: 0, completedV2Policies: [], executionHistory: [], executionNotifications: {} };
    throw new Error("Could not read keeper auto-execution state.");
  }
}

async function v2ExecutionRecord(configuration, receipt, gas, hash) {
  const decoded = receipt.logs.map((log) => {
    try { return decodeEventLog({ abi: eoaExecutorV2ExecutionEvent, eventName: "PolicyExecuted", data: log.data, topics: log.topics }); } catch { return undefined; }
  }).find((event) => event?.args.owner?.toLowerCase() === configuration.owner.toLowerCase());
  if (!decoded) throw new Error("Execution succeeded but PolicyExecuted event was not found.");
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  return { symbol: configuration.symbol ?? "Asset", executor: configuration.executor, owner: configuration.owner, policyId: decoded.args.policyId.toString(), amountIn: formatUnits(decoded.args.amountIn, 18), amountOut: formatUnits(decoded.args.amountOut, 6), priceUsd: formatUnits(decoded.args.spotPriceE18, 18), gasLimit: gas.toString(), hash, executedAt: new Date(Number(block.timestamp) * 1000).toISOString() };
}

function v2ExecutionKey(configuration, policyId) {
  return `${configuration.executor.toLowerCase()}:${configuration.owner.toLowerCase()}:${policyId}`;
}

function automaticGasTier(estimatedGasWithBuffer, maximumGas) {
  return AUTOMATIC_GAS_TIERS.find((tier) => tier >= estimatedGasWithBuffer && tier <= maximumGas);
}

function formatUtcTime(value) {
  const date = new Date(value);
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getUTCFullYear()}.${pad(date.getUTCMonth() + 1)}.${pad(date.getUTCDate())} - ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`;
}

async function saveExecutionState(state) {
  await mkdir("keeper", { recursive: true });
  await writeFile(executionStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function saveHealth(payload) {
  await mkdir(dirname(healthPath), { recursive: true });
  const temporaryPath = `${healthPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(temporaryPath, healthPath);
}

async function loadHealth() {
  try {
    return JSON.parse(await readFile(healthPath, "utf8"));
  } catch {
    return undefined;
  }
}

function isTemporaryRpcFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /requests limited|rate limit|too many requests|\b429\b|timeout|network|fetch failed|socket/i.test(message);
}

async function saveTemporaryRpcHealth(error, intervalSeconds) {
  const previous = await loadHealth();
  const checkedAt = new Date().toISOString();
  const retryAt = new Date(Date.now() + intervalSeconds * 1_000).toISOString();
  const temporary = isTemporaryRpcFailure(error);
  await saveHealth({
    ...previous,
    checkedAt,
    mode: previous?.mode ?? "dry-run",
    pollIntervalSeconds: intervalSeconds,
    providerStatus: temporary ? "temporarily-limited" : "unavailable",
    providerMessage: temporary ? "RPC temporarily limited. Keeper will retry automatically." : "RPC check failed. Keeper will retry automatically.",
    lastSuccessfulCheckAt: previous?.lastSuccessfulCheckAt ?? previous?.checkedAt ?? null,
    retryAt,
    eoaRule: previous?.eoaRule ?? null,
    eoaRules: previous?.eoaRules ?? (previous?.eoaRule ? [previous.eoaRule] : []),
  });
}

async function withNotificationLock(action) {
  try {
    await mkdir(notificationLockPath);
  } catch (error) {
    if (error.code === "EEXIST") {
      console.warn("Another keeper check is processing notifications; skipping this notification cycle.");
      return;
    }
    throw error;
  }

  try {
    await action();
  } finally {
    await rm(notificationLockPath, { recursive: true, force: true });
  }
}

async function withExecutionLock(action) {
  try {
    await mkdir(executionLockPath);
  } catch (error) {
    if (error.code === "EEXIST") {
      console.warn("Another keeper check is processing an execution; skipping this execution cycle.");
      return;
    }
    throw error;
  }

  try {
    await action();
  } finally {
    await rm(executionLockPath, { recursive: true, force: true });
  }
}

async function sendTelegramNotification(env, { symbol, priceUsd, action, automaticExecutionEnabled = false }) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: [
        "Take Profit keeper alert",
        "Network: Monad Testnet (10143)",
        `Vault: ${symbol}`,
        `Current price: ${Number(priceUsd).toFixed(4)} USDm`,
        `Action ready: ${action}`,
        automaticExecutionEnabled
          ? "Automatic JAMES test is enabled. The keeper will simulate it and send only if its gas limit is within the configured cap."
          : "No transaction has been created, signed, or sent.",
      ].join("\n"),
    }),
  });

  if (!response.ok) throw new Error(`Telegram notification failed (HTTP ${response.status}).`);
}

async function sendTelegramTest(env) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: "Take Profit Telegram test successful. No wallet or vault action was requested.",
    }),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const reason = typeof payload.description === "string" ? `: ${payload.description}` : "";
    throw new Error(`Telegram test notification failed (HTTP ${response.status})${reason}`);
  }
}

async function sendTelegramV2ExecutionOutcome(env, { policyId, owner, status, gas, hash, detail, execution, notificationKey }) {
  if (!telegramEnabled(env) || !env.TELEGRAM_BOT_TOKEN) return;
  const linkedChatId = owner ? await telegramChatIdForWallet(owner) : undefined;
  const chatId = linkedChatId ?? env.TELEGRAM_CHAT_ID;
  if (!chatId) return;
  const failureFingerprint = !execution && notificationKey
    ? JSON.stringify({ status, gas: gas?.toString(), hash, detail })
    : undefined;
  if (failureFingerprint) {
    const state = await loadExecutionState();
    if (state.executionNotifications?.[notificationKey]?.fingerprint === failureFingerprint) {
      console.log(`Telegram failure notification for rule #${policyId} was already sent; suppressing duplicate.`);
      return;
    }
  }
  const lines = [
    `Take Profit rule #${policyId}: ${status}`,
    "Network: Monad Testnet (10143)",
  ];
  if (execution) {
    const averagePrice = Number(execution.amountOut) / Number(execution.amountIn);
    lines.push(`Time: ${formatUtcTime(execution.executedAt)}`);
    lines.push(`Sold: ${execution.amountIn} ${execution.symbol ?? "Asset"}`);
    lines.push(`Avg. price: ${averagePrice.toFixed(6)} USDm`);
    lines.push(`Received: ${execution.amountOut} USDm`);
  } else if (gas !== undefined) {
    lines.push(`Gas limit: ${gas}`);
  }
  if (detail) lines.push(detail);
  if (hash) lines.push(`Transaction: https://testnet.monadvision.com/tx/${hash}`);
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: lines.join("\n") }),
    });
    if (!response.ok) {
      console.warn(`Telegram execution notification failed (HTTP ${response.status}).`);
      return;
    }
    if (failureFingerprint) {
      const state = await loadExecutionState();
      await saveExecutionState({
        ...state,
        executionNotifications: {
          ...(state.executionNotifications ?? {}),
          [notificationKey]: { fingerprint: failureFingerprint, sentAt: new Date().toISOString() },
        },
      });
    } else if (execution && notificationKey) {
      const state = await loadExecutionState();
      if (state.executionNotifications?.[notificationKey]) {
        const executionNotifications = { ...state.executionNotifications };
        delete executionNotifications[notificationKey];
        await saveExecutionState({ ...state, executionNotifications });
      }
    }
  } catch (error) {
    console.warn(`Telegram execution notification failed: ${error.message}`);
  }
}

function conciseExecutionFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/requests limited|rate limit/i.test(message)) {
    return "RPC временно ограничил запросы. Транзакция не отправлена; keeper повторит безопасную проверку.";
  }
  if (/configured limit|gas limit/i.test(message)) {
    return "Оценка газа выше лимита этого правила. Транзакция не отправлена; увеличьте лимит вручную.";
  }
  if (/revert/i.test(message)) {
    return "Контракт отклонил транзакцию. Повторная отправка отключена до новой проверки правила.";
  }
  return "Проверка правила не удалась. Транзакция не отправлена; keeper повторит проверку.";
}

async function retryPreBroadcastRpc(action, label) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_PRE_BROADCAST_RPC_RETRIES; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (!/requests limited|rate limit|timeout|network/i.test(error instanceof Error ? error.message : String(error)) || attempt === MAX_PRE_BROADCAST_RPC_RETRIES) break;
      const waitMs = 750 * (attempt + 1);
      console.warn(`${label} unavailable; retrying pre-broadcast in ${waitMs}ms (${attempt + 1}/${MAX_PRE_BROADCAST_RPC_RETRIES}).`);
      await delay(waitMs);
    }
  }
  throw lastError;
}

// Keep the secret-bearing .env file as the baseline, while allowing a service
// or a one-off dry-run to override non-secret operational flags safely.
const env = { ...readEnv(await readFile(".env", "utf8")), ...process.env };
const testTelegram = process.argv.includes("--test-telegram");
if (testTelegram) {
  if (!telegramEnabled(env)) throw new Error("Set KEEPER_TELEGRAM_ENABLED=true in .env before testing Telegram.");
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) throw new Error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env before testing Telegram.");
  await sendTelegramTest(env);
  console.log("Telegram test alert sent. No wallet, RPC, vault, or transaction was used.");
  process.exit(0);
}

if (!env.MONAD_TESTNET_RPC_URL || !env.KEEPER_PRIVATE_KEY) throw new Error("Set MONAD_TESTNET_RPC_URL and KEEPER_PRIVATE_KEY in .env.");

const account = privateKeyToAccount(env.KEEPER_PRIVATE_KEY);
if (account.address.toLowerCase() !== EXPECTED_KEEPER.toLowerCase()) throw new Error("KEEPER_PRIVATE_KEY does not match the assigned test keeper.");

const chain = defineChain({ id: MONAD_TESTNET_CHAIN_ID, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [env.MONAD_TESTNET_RPC_URL] } } });
const client = createPublicClient({ chain, transport: http(env.MONAD_TESTNET_RPC_URL) });
const walletClient = createWalletClient({ account, chain, transport: http(env.MONAD_TESTNET_RPC_URL) });
if (await client.getChainId() !== MONAD_TESTNET_CHAIN_ID) throw new Error("Refusing to run outside Monad Testnet (chain ID 10143).");

async function inspect() {
  const autoExecution = autoExecuteConfiguration(env);
  const eoaConfigurations = await eoaRuleConfigurations(env);
  const eoaAutomation = eoaConfigurations.map((configuration) => ({
    configuration,
    one: eoaV2AutoExecutionConfiguration(env, configuration),
    all: eoaV2AllAutoExecutionConfiguration(env, configuration),
  }));
  const eoaV2AutoExecution = eoaAutomation.some((item) => item.one);
  const eoaV2AllAutoExecution = eoaAutomation.some((item) => item.all);
  const report = [];
  // The public Monad Testnet RPC is rate-limited. During a bounded V2 execution
  // we only inspect the exact selected policy instead of spending the request
  // budget on the unrelated legacy vault monitors.
  const monitorVaults = !eoaV2AutoExecution && !eoaV2AllAutoExecution;
  if (!monitorVaults) console.log(eoaV2AllAutoExecution ? "All ready V2 policies are armed; skipping unrelated vault polling." : `V2 policy #${eoaV2AutoExecution.policyId} is armed; skipping unrelated vault polling.`);
  for (const [index, vault] of (monitorVaults ? vaults.entries() : [])) {
    const [keeper, price, takeProfit, rebalance, tradeBps, assetBalance, stableBalance] = await Promise.all([
      client.readContract({ address: vault.vault, abi: vaultAbi, functionName: "keeper" }),
      client.readContract({ address: vault.vault, abi: vaultAbi, functionName: "spotPriceE18" }),
      client.readContract({ address: vault.vault, abi: vaultAbi, functionName: "takeProfitPriceE18" }),
      client.readContract({ address: vault.vault, abi: vaultAbi, functionName: "rebalancePriceE18" }),
      client.readContract({ address: vault.vault, abi: vaultAbi, functionName: "tradeBps" }),
      client.readContract({ address: vault.asset, abi: erc20Abi, functionName: "balanceOf", args: [vault.vault] }),
      client.readContract({ address: usdm, abi: erc20Abi, functionName: "balanceOf", args: [vault.vault] }),
    ]);
    const action = actionFor({ price, takeProfit, rebalance, assetBalance, stableBalance, tradeBps });
    report.push({
      symbol: vault.symbol,
      vault: vault.vault,
      keeperMatches: keeper.toLowerCase() === account.address.toLowerCase(),
      priceUsd: formatUnits(price, 18),
      action,
      ready: action !== "no action",
      mode: autoExecution ? "auto-execute armed" : "dry-run",
    });
    // The public testnet endpoint limits requests to 15/sec. Each vault needs seven reads.
    // Keep a full one-second gap between vault batches to leave room for retries.
    if (index < vaults.length - 1) await delay(1_000);
  }
  console.table(report);
  await notifyReadyActions(report, Boolean(autoExecution));
  if (autoExecution) {
    await executeOneReadyJames(report, autoExecution);
  } else if (!eoaV2AutoExecution && !eoaV2AllAutoExecution) {
    console.log("Dry-run complete: no transaction was created or signed.");
  }
  const eoaRules = [];
  for (const item of eoaAutomation) {
    eoaRules.push(await inspectEoaRule(autoExecution, item.one, item.all, item.configuration));
    await delay(V2_READ_SPACING_MS);
  }
  const eoaRule = eoaRules[0] ?? null;
  const checkedAt = new Date().toISOString();
  await saveHealth({
    checkedAt,
    mode: autoExecution || eoaV2AutoExecution || eoaV2AllAutoExecution ? "auto-execute armed" : "dry-run",
    pollIntervalSeconds: Number(env.KEEPER_POLL_INTERVAL_SECONDS ?? 10),
    providerStatus: "ok",
    lastSuccessfulCheckAt: checkedAt,
    eoaRule,
    eoaRules,
  });
}

async function inspectEoaRule(autoExecution, eoaV2AutoExecution, eoaV2AllAutoExecution, configuration = eoaRuleConfiguration(env)) {
  if (!configuration) return null;
  if (configuration.version === "v2" || configuration.version === "v3") {
    const [count, price, assetAddress] = await Promise.all([
      client.readContract({ address: configuration.executor, abi: eoaExecutorV2Abi, functionName: "policyCount", args: [configuration.owner] }),
      client.readContract({ address: configuration.executor, abi: eoaExecutorV2Abi, functionName: "spotPriceE18" }),
      client.readContract({ address: configuration.executor, abi: eoaExecutorV2Abi, functionName: "asset" }),
    ]);
    const symbol = vaults.find((item) => item.asset.toLowerCase() === getAddress(assetAddress).toLowerCase())?.symbol ?? configuration.symbol ?? "Asset";
    const resolvedConfiguration = { ...configuration, symbol };
    const executionState = await loadExecutionState();
    const completedV2Policies = new Set(executionState.completedV2Policies ?? []);
    // The public testnet RPC permits only 15 requests per second. Do not fan out
    // every policy call with Promise.all: a larger rule set would prevent the
    // keeper from ever reaching the execution phase.
    const policySnapshots = [];
    for (let index = 0; index < Number(count); index += 1) {
      const policyId = BigInt(index + 1);
      const [amount, targetPrice, , active] = await retryPreBroadcastRpc(
        () => client.readContract({ address: configuration.executor, abi: eoaExecutorV2Abi, functionName: "policies", args: [configuration.owner, policyId] }),
        `V2 policy #${policyId} read`,
      );
      policySnapshots.push({ policyId, amount, targetPrice, active });
      if (index < Number(count) - 1) await delay(V2_READ_SPACING_MS);
    }
    const policies = policySnapshots.map(({ policyId, amount, targetPrice, active }) => ({
      symbol, policyId: policyId.toString(), amount: formatUnits(amount, 18), targetUsd: formatUnits(targetPrice, 18), active, completed: completedV2Policies.has(v2ExecutionKey(resolvedConfiguration, policyId)), ready: active && price >= targetPrice,
    }));
    const history = (executionState.executionHistory ?? []).filter((entry) => entry.executor?.toLowerCase() === configuration.executor.toLowerCase() && entry.owner?.toLowerCase() === configuration.owner.toLowerCase());
    const result = { symbol, version: configuration.version, owner: configuration.owner, executor: configuration.executor, priceUsd: formatUnits(price, 18), policies, history };
    console.table(policies);
    if (eoaV2AllAutoExecution) await executeAllReadyEoaV2(resolvedConfiguration, eoaV2AllAutoExecution, { price, policies: policySnapshots });
    else if (eoaV2AutoExecution) await executeOneReadyEoaV2(resolvedConfiguration, eoaV2AutoExecution);
    else if (autoExecution) console.warn("Legacy AUTO_EXECUTE does not apply to multi-level V2 rules; V2 remains in dry-run.");
    return result;
  }
  const [policy, price, balance] = await Promise.all([
    client.readContract({ address: configuration.executor, abi: eoaExecutorAbi, functionName: "policies", args: [configuration.owner] }),
    client.readContract({ address: configuration.executor, abi: eoaExecutorAbi, functionName: "spotPriceE18" }),
    client.readContract({ address: vaults[0].asset, abi: erc20Abi, functionName: "balanceOf", args: [configuration.owner] }),
  ]);
  const [amount, targetPrice, , active] = policy;
  const ready = active && price >= targetPrice && balance >= amount;
  const result = { symbol: "JAMES", version: "v1", owner: configuration.owner, executor: configuration.executor, priceUsd: formatUnits(price, 18), targetUsd: formatUnits(targetPrice, 18), amount: formatUnits(amount, 18), active, ready };
  console.table([result]);
  if (!autoExecution || !ready) return result;
  await withExecutionLock(async () => {
    const request = { address: configuration.executor, abi: eoaExecutorAbi, functionName: "executePolicy", args: [configuration.owner], account };
    await client.simulateContract(request);
    const estimate = await client.estimateContractGas(request);
    const gas = estimate + estimate / 10n;
    if (gas > autoExecution.maxGas) throw new Error(`Refusing EOA execution: gas limit ${gas} exceeds AUTO_EXECUTE_MAX_GAS ${autoExecution.maxGas}.`);
    const hash = await walletClient.writeContract({ ...request, gas });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`EOA execution reverted: ${hash}`);
    console.log(`EOA JAMES policy executed: ${hash}`);
  });
  return result;
}

async function executeOneReadyEoaV2(configuration, settings, snapshot) {
  const policy = snapshot ?? await retryPreBroadcastRpc(
    () => client.readContract({ address: configuration.executor, abi: eoaExecutorV2Abi, functionName: "policies", args: [configuration.owner, settings.policyId] }),
    `V2 policy #${settings.policyId} read`,
  );
  const { amount, targetPrice, active } = Array.isArray(policy)
    ? { amount: policy[0], targetPrice: policy[1], active: policy[3] }
    : policy;
  const price = snapshot?.price ?? await retryPreBroadcastRpc(
    () => client.readContract({ address: configuration.executor, abi: eoaExecutorV2Abi, functionName: "spotPriceE18" }),
    `V2 policy #${settings.policyId} price read`,
  );
  if (!active) {
    console.log(`V2 policy #${settings.policyId} is inactive; no transaction will be sent.`);
    return;
  }
  if (settings.maxAmount !== undefined && amount > settings.maxAmount) {
    throw new Error(`Refusing V2 policy #${settings.policyId}: amount ${formatUnits(amount, 18)} exceeds EOA_V2_AUTO_EXECUTE_MAX_AMOUNT ${formatUnits(settings.maxAmount, 18)}.`);
  }
  if (price < targetPrice) {
    console.log(`V2 policy #${settings.policyId} is not ready; no transaction will be sent.`);
    return;
  }
  await withExecutionLock(async () => {
    let gas;
    let hash;
    try {
      const request = { address: configuration.executor, abi: eoaExecutorV2Abi, functionName: "executePolicy", args: [configuration.owner, settings.policyId], account };
      await retryPreBroadcastRpc(() => client.simulateContract(request), `V2 policy #${settings.policyId} simulation`);
      const estimate = await retryPreBroadcastRpc(() => client.estimateContractGas(request), `V2 policy #${settings.policyId} gas estimate`);
      const estimatedGasWithBuffer = estimate + estimate / 10n;
      gas = automaticGasTier(estimatedGasWithBuffer, settings.maxGas);
      if (!gas) throw new Error(`Gas estimate ${estimatedGasWithBuffer} exceeds the automatic safety ceiling ${settings.maxGas}. No transaction was sent.`);
      if (gas > AUTOMATIC_GAS_TIERS[0]) {
        const previousTier = AUTOMATIC_GAS_TIERS[AUTOMATIC_GAS_TIERS.indexOf(gas) - 1];
        await sendTelegramV2ExecutionOutcome(env, {
          policyId: settings.policyId,
          owner: configuration.owner,
          status: "gas limit raised",
          gas,
          detail: `Gas limit ${previousTier} was not enough for the pre-flight estimate. Keeper raised it to ${gas} and will submit one transaction.`,
          notificationKey: `${v2ExecutionKey(configuration, settings.policyId)}:gas-tier`,
        });
      }
      console.log(`V2 policy #${settings.policyId} passed simulation. Gas limit: ${gas} (estimate ${estimate}, 10% buffer ${estimatedGasWithBuffer}).`);
      hash = await walletClient.writeContract({ ...request, gas });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
      console.log(`V2 policy #${settings.policyId} executed: https://testnet.monadvision.com/tx/${hash}`);
      const state = await loadExecutionState();
      const key = v2ExecutionKey(configuration, settings.policyId);
      const completedV2Policies = Array.from(new Set([...(state.completedV2Policies ?? []), key]));
      const historyRecord = await v2ExecutionRecord(configuration, receipt, gas, hash);
      const executionHistory = [...(state.executionHistory ?? []).filter((entry) => !(entry.executor?.toLowerCase() === configuration.executor.toLowerCase() && entry.owner?.toLowerCase() === configuration.owner.toLowerCase() && entry.policyId === settings.policyId.toString())), historyRecord].slice(-50);
      await saveExecutionState({ ...state, completedV2Policies, executionHistory, lastV2Execution: { policyId: settings.policyId.toString(), hash, completedAt: historyRecord.executedAt } });
      await sendTelegramV2ExecutionOutcome(env, { policyId: settings.policyId, owner: configuration.owner, status: "transaction confirmed", gas, hash, execution: historyRecord, notificationKey: key });
    } catch (error) {
      const detail = conciseExecutionFailure(error);
      console.error(`V2 policy #${settings.policyId} execution failed: ${error instanceof Error ? error.message : String(error)}`);
      await sendTelegramV2ExecutionOutcome(env, { policyId: settings.policyId, owner: configuration.owner, status: "not executed", gas, hash, detail, notificationKey: v2ExecutionKey(configuration, settings.policyId) });
    }
  });
}

async function executeAllReadyEoaV2(configuration, settings, snapshot) {
  const candidates = snapshot.policies.filter((policy) => policy.active && snapshot.price >= policy.targetPrice);
  const total = candidates.reduce((sum, candidate) => sum + candidate.amount, 0n);
  if (total > settings.maxTotalAmount) throw new Error(`Refusing all-ready execution: ${formatUnits(total, 18)} JAMES exceeds EOA_V2_AUTO_EXECUTE_ALL_MAX_TOTAL_AMOUNT ${formatUnits(settings.maxTotalAmount, 18)}.`);
  for (const candidate of candidates) {
    await executeOneReadyEoaV2(configuration, { policyId: candidate.policyId, maxAmount: candidate.amount, maxGas: settings.maxGas }, { ...candidate, price: snapshot.price });
  }
}

async function notifyReadyActions(report, automaticExecutionEnabled) {
  if (!telegramEnabled(env)) return;
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.warn("Telegram notifications are enabled but TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing.");
    return;
  }

  await withNotificationLock(async () => {
    const state = await loadNotificationState();
    let changed = false;
    for (const item of report) {
      if (item.action === "no action") {
        if (state[item.symbol]) {
          delete state[item.symbol];
          changed = true;
        }
        continue;
      }

      if (state[item.symbol]?.action === item.action) continue;
      await sendTelegramNotification(env, { ...item, automaticExecutionEnabled });
      state[item.symbol] = { action: item.action };
      changed = true;
      console.log(`Telegram alert sent for ${item.symbol}.`);
    }
    if (changed) await saveNotificationState(state);
  });
}

async function executeOneReadyJames(report, configuration) {
  const item = report.find((candidate) => candidate.symbol === configuration.symbol);
  if (!item?.ready) {
    console.log("Automatic execution armed, but JAMES has no actionable policy.");
    return;
  }
  if (!item.keeperMatches) throw new Error("Refusing automatic execution because the configured wallet is not the JAMES keeper.");

  await withExecutionLock(async () => {
    const state = await loadExecutionState();
    if (state.successfulExecutions >= 1) {
      console.warn("Automatic JAMES test has already completed once; refusing another automatic execution.");
      return;
    }

    const request = { address: item.vault, abi: vaultAbi, functionName: "executePolicy", account };
    await client.simulateContract(request);
    const estimate = await client.estimateContractGas(request);
    const gas = estimate + (estimate / 10n);
    if (gas > configuration.maxGas) {
      throw new Error(`Refusing automatic JAMES execution: estimated gas with 10% buffer (${gas}) exceeds AUTO_EXECUTE_MAX_GAS (${configuration.maxGas}).`);
    }

    console.log(`Automatic JAMES execution passed simulation. Gas limit: ${gas} (estimate ${estimate}, 10% buffer).`);
    const hash = await walletClient.writeContract({ ...request, gas });
    console.log(`Automatic JAMES execution broadcast: ${hash}`);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Automatic JAMES execution reverted: ${hash}`);
    await saveExecutionState({ successfulExecutions: 1, hash, completedAt: new Date().toISOString() });
    console.log(`Automatic JAMES execution confirmed: ${hash}`);
    if (telegramEnabled(env) && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      await sendTelegramExecutionResult(env, hash, gas);
    }
  });
}

async function sendTelegramExecutionResult(env, hash, gas) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: [
        "Take Profit automatic test completed",
        "Network: Monad Testnet (10143)",
        "Vault: JAMES",
        `Gas limit: ${gas}`,
        `Transaction: https://testnet.monadvision.com/tx/${hash}`,
      ].join("\n"),
    }),
  });
  if (!response.ok) throw new Error(`Telegram execution notification failed (HTTP ${response.status}).`);
}

const watch = process.argv.includes("--watch");
if (!watch) {
  await inspect();
} else {
  const intervalSeconds = Number(env.KEEPER_POLL_INTERVAL_SECONDS ?? 10);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 10) throw new Error("KEEPER_POLL_INTERVAL_SECONDS must be an integer of at least 10.");
  console.log(`Watch mode started: checking every ${intervalSeconds} seconds. Press Ctrl+C to stop.`);
  const inspectWithHealthFallback = async () => {
    try {
      await inspect();
    } catch (error) {
      await saveTemporaryRpcHealth(error, intervalSeconds);
      console.error("Watch check failed; health status saved for retry:", error instanceof Error ? error.message : error);
    }
  };
  await inspectWithHealthFallback();
  setInterval(() => { void inspectWithHealthFallback(); }, intervalSeconds * 1_000);
}
