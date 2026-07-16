import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, defineChain, formatUnits, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const MONAD_TESTNET_CHAIN_ID = 10143;
const EXPECTED_KEEPER = "0xD88394629BbE7Be91B1eFE6E984e7aCb118edd8B";
const statePath = "keeper/state.json";
const notificationLockPath = "keeper/notification.lock";
const executionStatePath = "keeper/auto-execution-state.json";
const executionLockPath = "keeper/auto-execution.lock";
const AUTO_EXECUTE_CONFIRMATION = "MONAD_TESTNET_JAMES_ONCE";
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
  if (!Number.isInteger(maxGas) || maxGas < 21_000 || maxGas > 300_000) {
    throw new Error("AUTO_EXECUTE_MAX_GAS must be an integer between 21000 and 300000.");
  }
  return { symbol: env.AUTO_EXECUTE_SYMBOL, maxGas: BigInt(maxGas) };
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
    if (error.code === "ENOENT") return { successfulExecutions: 0 };
    throw new Error("Could not read keeper auto-execution state.");
  }
}

async function saveExecutionState(state) {
  await mkdir("keeper", { recursive: true });
  await writeFile(executionStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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

const env = readEnv(await readFile(".env", "utf8"));
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
  const report = [];
  for (const [index, vault] of vaults.entries()) {
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
  } else {
    console.log("Dry-run complete: no transaction was created or signed.");
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
  const intervalSeconds = Number(env.KEEPER_POLL_INTERVAL_SECONDS ?? 30);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 10) throw new Error("KEEPER_POLL_INTERVAL_SECONDS must be an integer of at least 10.");
  console.log(`Watch mode started: checking every ${intervalSeconds} seconds. Press Ctrl+C to stop.`);
  await inspect();
  setInterval(() => { void inspect().catch((error) => console.error("Watch check failed:", error.message)); }, intervalSeconds * 1_000);
}
