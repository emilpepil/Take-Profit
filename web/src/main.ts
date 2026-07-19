import { createPublicClient, createWalletClient, custom, defineChain, encodeDeployData, formatUnits, getAddress, http, parseUnits, type Address } from "viem";
import poolArtifact from "./generated/SimplePool.json";
import vaultArtifact from "./generated/PolicyVault.json";
import safeModuleArtifact from "./generated/SafeTakeProfitModule.json";
import eoaExecutorArtifact from "./generated/EoaTakeProfitExecutor.json";
import eoaExecutorV2Artifact from "./generated/EoaTakeProfitExecutorV2.json";
import eoaExecutorV3Artifact from "./generated/EoaTakeProfitExecutorV3.json";
import "./style.css";
import "./market-controls.css";

// Cloudflare Pages serves this Vite SPA for both `/` and `/app`. Keep the
// product dashboard on the explicit app route, leaving `/` for the public
// landing page and hackathon introduction.
const isAppRoute = window.location.pathname === "/app" || window.location.pathname.startsWith("/app/");
const isPortfolioV2Route = window.location.pathname === "/app/1" || window.location.pathname.startsWith("/app/1/");
const landingPage = document.querySelector<HTMLElement>("#landing-page")!;
const appShell = document.querySelector<HTMLElement>("#app-shell")!;
const portfolioV2Page = document.querySelector<HTMLElement>("#portfolio-v2-page")!;
landingPage.hidden = isAppRoute;
appShell.hidden = !isAppRoute || isPortfolioV2Route;
portfolioV2Page.hidden = !isPortfolioV2Route;
document.title = isPortfolioV2Route ? "Portfolio · Cinch" : isAppRoute ? "Cinch · Monad Testnet" : "Cinch · Automated exits on Monad";

// The `/app/1` route reuses the exact same wallet, balance, price and swap
// logic as `/app` — it only moves the real DOM nodes into a new layout so
// nothing about the underlying blockchain behavior is duplicated or forked.
if (isPortfolioV2Route) {
  document.querySelector("#v2-wallet-slot")!.appendChild(document.querySelector("#connect")!);
  document.querySelector("#v2-metrics-slot")!.append(
    document.querySelector("#portfolio-total-card")!,
    document.querySelector("#portfolio-change-card")!,
    document.querySelector("#portfolio-rules-card")!,
  );
  document.querySelector("#v2-table-body-slot")!.appendChild(document.querySelector("#asset-rows")!);
  document.querySelector("#v2-swap-slot")!.appendChild(document.querySelector("#trade-panel")!);
  document.querySelector("#v2-onboarding-slot")!.appendChild(document.querySelector("#demo-faucet-panel")!);
}

declare global { interface Window { ethereum?: { request(args: { method: string; params?: unknown }): Promise<unknown> } } }

const rpc = "https://testnet-rpc.monad.xyz";
const chain = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const client = createPublicClient({ chain, transport: http(rpc) });
let account: Address | undefined;
let safeAccount: Address | undefined;
const usdm = getAddress("0x0f1471d41e25e7880a3c3021dfcb5efb29079f71");
const demoTokenOwner = getAddress("0x55dB95b0772633664Ba1F482741fe4DD22e0d8bB");
const demoFaucetWallet = getAddress("0xA6Cd5434bDAd0960a21EdD9b666dAc55687B70A9");
const demoFaucetStock = [
  { symbol: "USDm", token: usdm, decimals: 6, amount: "10000000" },
  { symbol: "JAMES", token: getAddress("0x8f32e211244706c9b0902a9bd823e1c768a032c2"), decimals: 18, amount: "100000" },
  { symbol: "EMO", token: getAddress("0x3d07c291cc9a7eaa11fa2f2bd2894643c0923e6c"), decimals: 18, amount: "100000" },
  { symbol: "CHOG", token: getAddress("0x6bf60cc379ad2c76ebf4c1d4f0ef528427483313"), decimals: 18, amount: "100000" },
] as const;
const safeKeeper = getAddress("0xD88394629BbE7Be91B1eFE6E984e7aCb118edd8B");
const pairs = [
  { symbol: "JAMES", token: getAddress("0x8f32e211244706c9b0902a9bd823e1c768a032c2"), pool: getAddress("0x6ba5e36975ce93778543a512f2c99679daadaf04"), vault: getAddress("0x88760064022811c60771fd5fb574895361189a2d") },
  { symbol: "EMO", token: getAddress("0x3d07c291cc9a7eaa11fa2f2bd2894643c0923e6c"), pool: getAddress("0x127428881a30bc257b9a0b2bd57ab11a3bbad0e7"), vault: getAddress("0x59f70bfabce71c8463ee97295e5af60ae4d05492") },
  { symbol: "CHOG", token: getAddress("0x6bf60cc379ad2c76ebf4c1d4f0ef528427483313"), pool: getAddress("0xf5d0a5d5458a095f4a7065e999837dfe34ef2e92"), vault: getAddress("0xe7f348cf2cfb94428784e6480f046df86fe826f1") },
];
try {
  const savedVaults = JSON.parse(localStorage.getItem("take-profit-vaults") ?? "{}") as Record<string, string>;
  for (const pair of pairs) if (savedVaults[pair.symbol]) pair.vault = getAddress(savedVaults[pair.symbol]);
} catch { /* Ignore malformed browser storage and use the demo vaults. */ }
const erc20 = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const demoTokenMintAbi = [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }] as const;
const safeAbi = [
  { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
const cancellablePolicyAbi = [
  { type: "function", name: "policyActive", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "cancelPolicy", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const set = (value: string) => { status.textContent = value; };
const demoGuideBackdrop = document.querySelector<HTMLElement>("#demo-guide-backdrop")!;
const openDemoGuide = document.querySelector<HTMLButtonElement>("#open-demo-guide")!;
const closeDemoGuide = document.querySelector<HTMLButtonElement>("#close-demo-guide")!;
const showDemoGuide = () => { demoGuideBackdrop.hidden = false; closeDemoGuide.focus(); };
const hideDemoGuide = () => { demoGuideBackdrop.hidden = true; openDemoGuide.focus(); };
openDemoGuide.addEventListener("click", showDemoGuide);
closeDemoGuide.addEventListener("click", hideDemoGuide);
demoGuideBackdrop.addEventListener("click", (event) => { if (event.target === demoGuideBackdrop) hideDemoGuide(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !demoGuideBackdrop.hidden) hideDemoGuide(); });
function highlightDemoBlock(el: Element | null) {
  if (!el) return;
  el.classList.remove("demo-highlight");
  void (el as HTMLElement).offsetWidth; // restart the animation if it's already running
  el.classList.add("demo-highlight");
  window.setTimeout(() => el.classList.remove("demo-highlight"), 5200);
}
document.querySelector<HTMLElement>(".demo-guide-steps")!.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-demo-action]");
  if (!button) return;
  const action = button.dataset.demoAction;
  hideDemoGuide();
  if (action === "connect") {
    document.querySelector<HTMLElement>("[data-tab='portfolio']")?.click();
    document.querySelector<HTMLButtonElement>("#connect")?.click();
    return;
  }
  if (action === "create-rule") {
    document.querySelector<HTMLElement>("[data-tab='take-profit']")?.click();
    const target = document.querySelector(".rule-config");
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
    highlightDemoBlock(target);
    return;
  }
  if (action === "swap") {
    document.querySelector<HTMLElement>("[data-tab='portfolio']")?.click();
    const target = document.querySelector(".market-panel");
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
    highlightDemoBlock(target);
    return;
  }
  if (action === "history") {
    document.querySelector<HTMLElement>("[data-tab='take-profit']")?.click();
    const target = document.querySelector(".execution-history");
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
    highlightDemoBlock(target);
    return;
  }
  // "claim" and "telegram" scroll to the Demo Faucet card, then trigger the
  // same real button used elsewhere in the app (no duplicated logic).
  document.querySelector<HTMLElement>("[data-tab='portfolio']")?.click();
  const faucetPanel = document.querySelector<HTMLElement>("#demo-faucet-panel");
  faucetPanel?.scrollIntoView({ behavior: "smooth", block: "start" });
  if (action === "claim") highlightDemoBlock(faucetPanel);
  window.setTimeout(() => {
    if (action === "claim") demoFaucetButton.click();
    if (action === "telegram") connectTelegramButton.click();
  }, 400);
});
const display = (amount: bigint, decimals: number) => Number(formatUnits(amount, decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 });
const safeAddressInput = document.querySelector<HTMLInputElement>("#safe-address")!;
const safeStatus = document.querySelector<HTMLParagraphElement>("#safe-status")!;
const safeState = document.querySelector<HTMLSpanElement>("#safe-state")!;
const moduleAsset = document.querySelector<HTMLSelectElement>("#module-asset")!;
const moduleStatus = document.querySelector<HTMLParagraphElement>("#module-status")!;
const deploySafeModule = document.querySelector<HTMLButtonElement>("#deploy-safe-module")!;
const executorAsset = document.querySelector<HTMLSelectElement>("#executor-asset")!;
const executorStatus = document.querySelector<HTMLParagraphElement>("#executor-status")!;
const deployEoaExecutor = document.querySelector<HTMLButtonElement>("#deploy-eoa-executor")!;
const eoaState = document.querySelector<HTMLSpanElement>("#eoa-state")!;
const keeperLiveStatus = document.querySelector<HTMLParagraphElement>("#keeper-live-status")!;
// The VM-backed HTTPS endpoint keeps keeper status and signed rule settings available
// even when a developer's local machine and SSH tunnel are offline. Local overrides
// remain possible through VITE_KEEPER_HEALTH_URL.
const keeperHealthUrl = import.meta.env.VITE_KEEPER_HEALTH_URL ?? "https://34.55.12.195.nip.io/health";
const demoFaucetUrl = import.meta.env.VITE_DEMO_FAUCET_URL ?? keeperHealthUrl.replace(/\/health$/, "/faucet");
const telegramLinkUrl = import.meta.env.VITE_TELEGRAM_LINK_URL ?? keeperHealthUrl.replace(/\/health$/, "/telegram");
const demoFaucetButton = document.querySelector<HTMLButtonElement>("#claim-demo-faucet")!;
const addDemoTokensButton = document.querySelector<HTMLButtonElement>("#add-demo-tokens")!;
document.querySelector<HTMLElement>(".demo-faucet-tools")!.insertAdjacentHTML("beforeend", '<button id="connect-telegram" class="ghost-button" type="button" disabled>Telegram notification</button><button id="disconnect-telegram" class="ghost-button" type="button" hidden>Disconnect Telegram</button>');
const connectTelegramButton = document.querySelector<HTMLButtonElement>("#connect-telegram")!;
const disconnectTelegramButton = document.querySelector<HTMLButtonElement>("#disconnect-telegram")!;
const telegramBell = document.querySelector<HTMLButtonElement>("#telegram-bell")!;
const ruleSummaryTelegramButton = document.querySelector<HTMLButtonElement>("#rule-summary-telegram")!;
const fundDemoFaucetButton = document.querySelector<HTMLButtonElement>("#fund-demo-faucet")!;
const demoFaucetStatus = document.querySelector<HTMLParagraphElement>("#demo-faucet-status")!;
function faucetMessage(address: Address) {
  const command = { action: "take-profit-demo-faucet-claim", chainId: 10143, address, issuedAt: Date.now() };
  return ["Take Profit - Demo Faucet claim", "", "This signature does not move tokens or grant spending permission.", "It proves that this wallet requests one test-token bundle, limited to once every 4 hours.", "", JSON.stringify(command)].join("\n");
}
function telegramLinkMessage(address: Address) {
  const command = { action: "take-profit-telegram-link", chainId: 10143, address, issuedAt: Date.now() };
  return ["Take Profit - Connect Telegram notifications", "", "This signature does not move tokens or grant spending permission.", "It creates a one-time 10-minute code that links this wallet to the Take Profit Telegram bot.", "", JSON.stringify(command)].join("\n");
}
function telegramUnlinkMessage(address: Address) {
  const command = { action: "take-profit-telegram-unlink", chainId: 10143, address, issuedAt: Date.now() };
  return ["Take Profit - Disconnect Telegram notifications", "", "This signature does not move tokens or grant spending permission.", "It removes the Telegram link for this wallet so a different chat can be connected.", "", JSON.stringify(command)].join("\n");
}
function keeperRegistrationMessage(executor: Address, owner: Address) {
  const command = { action: "take-profit-keeper-register", chainId: 10143, version: "v3", executor, owner, issuedAt: Date.now() };
  return ["Take Profit - Connect this executor to the keeper", "", "This signature does not move tokens or grant spending permission.", "It authorizes the Take Profit keeper to monitor and execute only the V3 rules already created by this wallet on this executor.", "", JSON.stringify(command)].join("\n");
}
async function registerExecutorWithKeeper(executor: Address, owner: Address) {
  const message = keeperRegistrationMessage(executor, owner);
  const signature = await wallet().signMessage({ message });
  const response = await fetch(`${keeperHealthUrl.replace(/\/health$/, "")}/keeper/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, signature }), signal: AbortSignal.timeout(15_000) });
  const payload = await response.json() as { ok?: boolean; error?: string };
  if (!response.ok || !payload.ok) throw new Error(payload.error ?? "Could not connect this executor to the keeper.");
}
// The bot's public @username, used to jump straight into the chat once a
// wallet is already linked (the one-time /telegram/link deep-link is for
// first-time linking only and expires, so it can't be reused for this).
const telegramBotChatUrl = "https://t.me/Auto_Take_Profit_Bot";
let telegramLinked = false;
async function refreshTelegramLink() {
  connectTelegramButton.disabled = !account;
  telegramBell.disabled = !account;
  ruleSummaryTelegramButton.disabled = !account;
  telegramLinked = false;
  disconnectTelegramButton.hidden = true;
  if (!account) { connectTelegramButton.textContent = "Telegram notification"; ruleSummaryTelegramButton.textContent = "Telegram notification"; return; }
  try {
    const response = await fetch(`${telegramLinkUrl}/status?address=${account}`, { signal: AbortSignal.timeout(5_000) });
    const payload = await response.json() as { linked?: boolean };
    if (!response.ok) throw new Error("Telegram link status is unavailable.");
    telegramLinked = Boolean(payload.linked);
    connectTelegramButton.textContent = "Telegram notification";
    telegramBell.setAttribute("aria-label", telegramLinked ? "Open Telegram notifications" : "Connect Telegram notifications");
    ruleSummaryTelegramButton.textContent = "Telegram notification";
    disconnectTelegramButton.hidden = !telegramLinked;
    disconnectTelegramButton.disabled = false;
  } catch {
    connectTelegramButton.textContent = "Telegram notification";
    ruleSummaryTelegramButton.textContent = "Telegram notification";
  }
}
const disconnectTelegramDefaultLabel = "Disconnect Telegram";
async function disconnectTelegram() {
  if (!account) return;
  try {
    disconnectTelegramButton.disabled = true;
    disconnectTelegramButton.textContent = "Disconnecting…";
    const message = telegramUnlinkMessage(account);
    const signature = await wallet().signMessage({ message });
    const response = await fetch(`${telegramLinkUrl}/unlink`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, signature }), signal: AbortSignal.timeout(15_000) });
    const payload = await response.json() as { unlinked?: boolean; error?: string };
    if (!response.ok) throw new Error(payload.error ?? "Could not disconnect Telegram.");
    demoFaucetStatus.textContent = "Telegram disconnected. You can connect a new chat anytime.";
    demoFaucetStatus.className = "demo-faucet-status ready";
    await refreshTelegramLink();
  } catch (error) {
    demoFaucetStatus.textContent = error instanceof Error ? error.message : "Could not disconnect Telegram.";
    demoFaucetStatus.className = "demo-faucet-status error";
  } finally {
    disconnectTelegramButton.disabled = !account;
    disconnectTelegramButton.textContent = disconnectTelegramDefaultLabel;
  }
}
let disconnectTelegramArmed = false;
let disconnectTelegramArmedTimer: number | undefined;
disconnectTelegramButton.addEventListener("click", () => {
  if (!account) return;
  if (!disconnectTelegramArmed) {
    disconnectTelegramArmed = true;
    disconnectTelegramButton.textContent = "Click again to confirm";
    window.clearTimeout(disconnectTelegramArmedTimer);
    disconnectTelegramArmedTimer = window.setTimeout(() => {
      disconnectTelegramArmed = false;
      disconnectTelegramButton.textContent = disconnectTelegramDefaultLabel;
    }, 4_000);
    return;
  }
  disconnectTelegramArmed = false;
  window.clearTimeout(disconnectTelegramArmedTimer);
  void disconnectTelegram();
});
async function refreshDemoFaucet() {
  fundDemoFaucetButton.hidden = account?.toLowerCase() !== demoTokenOwner.toLowerCase();
  demoFaucetButton.disabled = !account;
  addDemoTokensButton.disabled = !account;
  void refreshTelegramLink();
  demoFaucetButton.textContent = account ? "Check claim availability" : "Connect wallet to claim";
  demoFaucetStatus.className = "demo-faucet-status";
  if (!account) { demoFaucetStatus.textContent = "Connect MetaMask to claim demo tokens."; return; }
  try {
    const response = await fetch(`${demoFaucetUrl}/status?address=${account}`, { signal: AbortSignal.timeout(5_000) });
    const payload = await response.json() as { enabled?: boolean; configured?: boolean; faucetAddress?: string | null; available?: boolean; nextClaimAt?: string | null; error?: string };
    if (!response.ok) throw new Error(payload.error ?? "Faucet status is unavailable.");
    if (!payload.enabled) { demoFaucetStatus.textContent = "Demo Faucet is being funded. Use Monad Faucet to get MON first."; return; }
    if (!payload.configured || payload.faucetAddress?.toLowerCase() !== demoFaucetWallet.toLowerCase()) {
      demoFaucetButton.disabled = true;
      demoFaucetStatus.textContent = "Demo Faucet server wallet is not configured correctly yet. Please try again shortly.";
      demoFaucetStatus.classList.add("error");
      return;
    }
    if (payload.available) { demoFaucetButton.disabled = false; demoFaucetButton.textContent = "Claim demo bundle"; demoFaucetStatus.textContent = "Bundle available for this wallet."; demoFaucetStatus.classList.add("ready"); return; }
    const next = payload.nextClaimAt ? new Date(payload.nextClaimAt).toLocaleString(undefined, { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) : "later";
    demoFaucetStatus.textContent = `Next bundle available: ${next} UTC.`;
  } catch {
    demoFaucetStatus.textContent = "Demo Faucet status is temporarily unavailable. Keeper and rules remain available.";
  }
}
addDemoTokensButton.addEventListener("click", async () => {
  try {
    if (!account || !window.ethereum) throw new Error("Connect MetaMask first.");
    addDemoTokensButton.disabled = true;
    for (const asset of demoFaucetStock) {
      addDemoTokensButton.textContent = `Add ${asset.symbol} to MetaMask...`;
      const added = await window.ethereum.request({ method: "wallet_watchAsset", params: { type: "ERC20", options: { address: asset.token, symbol: asset.symbol, decimals: asset.decimals } } });
      if (!added) throw new Error(`Adding ${asset.symbol} was cancelled in MetaMask.`);
    }
    demoFaucetStatus.textContent = "Demo tokens were added to MetaMask.";
    demoFaucetStatus.className = "demo-faucet-status ready";
  } catch (error) {
    demoFaucetStatus.textContent = error instanceof Error ? error.message : "Could not add demo tokens to MetaMask.";
    demoFaucetStatus.className = "demo-faucet-status error";
  } finally {
    addDemoTokensButton.disabled = !account;
    addDemoTokensButton.textContent = "Add demo tokens to MetaMask";
  }
});
async function startTelegramLink() {
  let botWindow: Window | null = null;
  try {
    if (!account) throw new Error("Connect MetaMask first.");
    // Open synchronously from the user gesture so popup blockers do not prevent
    // the bot from opening after MetaMask resolves the signature request.
    botWindow = window.open("", "_blank");
    connectTelegramButton.disabled = true;
    telegramBell.disabled = true;
    ruleSummaryTelegramButton.disabled = true;
    connectTelegramButton.textContent = "Confirm in MetaMask...";
    ruleSummaryTelegramButton.textContent = "Confirm in MetaMask...";
    const message = telegramLinkMessage(account);
    const signature = await wallet().signMessage({ message });
    const response = await fetch(`${telegramLinkUrl}/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, signature }), signal: AbortSignal.timeout(15_000) });
    const payload = await response.json() as { botUrl?: string; error?: string };
    if (!response.ok || !payload.botUrl) throw new Error(payload.error ?? "Could not create a Telegram link.");
    if (botWindow) {
      botWindow.opener = null;
      botWindow.location.assign(payload.botUrl);
    } else window.open(payload.botUrl, "_blank", "noopener");
    demoFaucetStatus.textContent = "Telegram opened. Press Start in the bot within 10 minutes to finish linking this wallet.";
    demoFaucetStatus.className = "demo-faucet-status ready";
    connectTelegramButton.textContent = "Waiting for Telegram...";
    ruleSummaryTelegramButton.textContent = "Waiting for Telegram...";
    window.setTimeout(() => void refreshTelegramLink(), 5_000);
  } catch (error) {
    botWindow?.close();
    demoFaucetStatus.textContent = error instanceof Error ? error.message : "Could not connect Telegram.";
    demoFaucetStatus.className = "demo-faucet-status error";
    await refreshTelegramLink();
  }
}

// The Connect Telegram button, the topbar bell, and the rule Summary button
// share one explanation-and-confirm popover before actually starting (or
// undoing) the Telegram link (real user gesture preserved so the bot popup
// is not blocked). Its question and Yes-action switch based on link state.
const telegramConfirmPopover = document.querySelector<HTMLElement>("#telegram-confirm-popover")!;
const telegramConfirmText = document.querySelector<HTMLElement>("#telegram-confirm-text")!;
let telegramConfirmMode: "connect" | "disconnect" = "connect";
function openTelegramConfirm(trigger: HTMLElement, mode: "connect" | "disconnect") {
  telegramConfirmMode = mode;
  telegramConfirmText.textContent = mode === "disconnect"
    ? "Your wallet is connected to Telegram notifications. Do you want to disconnect notifications?"
    : "Do you want to create automatic notifications about rule execution in Telegram?";
  telegramConfirmPopover.hidden = false;
  const rect = trigger.getBoundingClientRect();
  const popoverRect = telegramConfirmPopover.getBoundingClientRect();
  const left = Math.max(12, Math.min(rect.right - popoverRect.width, window.innerWidth - popoverRect.width - 12));
  telegramConfirmPopover.style.top = `${rect.bottom + 8}px`;
  telegramConfirmPopover.style.left = `${left}px`;
}
function closeTelegramConfirm() { telegramConfirmPopover.hidden = true; }
telegramBell.addEventListener("click", (event) => {
  event.stopPropagation();
  openTelegramConfirm(telegramBell, telegramLinked ? "disconnect" : "connect");
});
for (const trigger of [connectTelegramButton, ruleSummaryTelegramButton]) {
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    if (telegramLinked) { window.open(telegramBotChatUrl, "_blank", "noopener"); return; }
    openTelegramConfirm(trigger, "connect");
  });
}
telegramConfirmPopover.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-telegram-confirm]");
  if (!target) return;
  const mode = telegramConfirmMode;
  closeTelegramConfirm();
  if (target.dataset.telegramConfirm === "yes") {
    if (mode === "disconnect") void disconnectTelegram();
    else void startTelegramLink();
  }
});
document.addEventListener("click", () => closeTelegramConfirm());
fundDemoFaucetButton.addEventListener("click", async () => {
  try {
    if (!account || account.toLowerCase() !== demoTokenOwner.toLowerCase()) throw new Error("Only the demo-token owner can fund the faucet.");
    fundDemoFaucetButton.disabled = true;
    for (const [index, asset] of demoFaucetStock.entries()) {
      const target = parseUnits(asset.amount, asset.decimals);
      const balance = await client.readContract({ address: asset.token, abi: erc20, functionName: "balanceOf", args: [demoFaucetWallet] });
      if (balance >= target) continue;
      fundDemoFaucetButton.textContent = `Confirm ${asset.symbol} funding (${index + 1}/4)`;
      const request = { address: asset.token, abi: demoTokenMintAbi, functionName: "mint", args: [demoFaucetWallet, target - balance] } as const;
      const gas = await client.estimateContractGas({ ...request, account });
      await wait(await wallet().writeContract({ ...request, gas: gas + gas / 10n }));
    }
    demoFaucetStatus.textContent = "Faucet funded for up to 1,000 demo bundles. Configure its separate VM wallet to start claims.";
    demoFaucetStatus.className = "demo-faucet-status ready";
  } catch (error) {
    demoFaucetStatus.textContent = error instanceof Error ? error.message : "Could not fund the Demo Faucet.";
    demoFaucetStatus.className = "demo-faucet-status error";
  } finally {
    fundDemoFaucetButton.disabled = false;
    fundDemoFaucetButton.textContent = "Fund 1,000 demo bundles";
  }
});
demoFaucetButton.addEventListener("click", async () => {
  try {
    if (!account) throw new Error("Connect MetaMask first.");
    demoFaucetButton.disabled = true;
    demoFaucetButton.textContent = "Confirm request in MetaMask...";
    const message = faucetMessage(account);
    const signature = await wallet().signMessage({ message });
    demoFaucetButton.textContent = "Sending demo tokens...";
    const response = await fetch(`${demoFaucetUrl}/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, signature }), signal: AbortSignal.timeout(90_000) });
    const payload = await response.json() as { status?: string; error?: string };
    if (!response.ok) throw new Error(payload.error ?? "Demo Faucet claim failed.");
    demoFaucetStatus.textContent = payload.status === "claimed" ? "Demo bundle sent. Refreshing wallet balances..." : "This wallet is still in its 4-hour claim window.";
    demoFaucetStatus.className = "demo-faucet-status ready";
    await refreshOnchainAccountData();
  } catch (error) {
    demoFaucetStatus.textContent = error instanceof Error ? error.message : "Demo Faucet claim failed.";
    demoFaucetStatus.className = "demo-faucet-status error";
  } finally {
    // Keep a failed claim message visible instead of replacing it immediately
    // with the ordinary availability status.
    if (!demoFaucetStatus.classList.contains("error")) await refreshDemoFaucet();
  }
});
type KeeperHealth = {
  checkedAt: string;
  mode: string;
  pollIntervalSeconds: number;
  providerStatus?: "ok" | "temporarily-limited" | "unavailable";
  providerMessage?: string;
  lastSuccessfulCheckAt?: string | null;
  retryAt?: string;
  eoaRule: null | { symbol: string; version: "v1" | "v2" | "v3"; owner: string; executor: string; priceUsd: string; targetUsd?: string; amount?: string; active?: boolean; ready?: boolean; policies?: Array<{ policyId: string; active: boolean; completed?: boolean; ready: boolean }>; history?: Array<{ symbol?: string; policyId: string; amountIn: string; amountOut: string; priceUsd: string; gasLimit: string; hash: string; executedAt: string }> };
  eoaRules?: Array<{ symbol: string; version: "v1" | "v2" | "v3"; owner: string; executor: string; priceUsd: string; targetUsd?: string; amount?: string; active?: boolean; ready?: boolean; policies?: Array<{ policyId: string; active: boolean; completed?: boolean; ready: boolean }>; history?: Array<{ symbol?: string; policyId: string; amountIn: string; amountOut: string; priceUsd: string; gasLimit: string; hash: string; executedAt: string }> }>;
};
let keeperHealth: KeeperHealth | undefined;
const eoaExecutors: Record<string, Address> = {};
const eoaExecutorsV2: Record<string, Address> = {};
const eoaExecutorsV3: Record<string, Address> = {};
const keeperDryRunRule = {
  symbol: "JAMES",
  executor: getAddress("0xb8467cac60ce9087407942c7812820351436baea"),
  owner: getAddress("0x55db95b0772633664ba1f482741fe4DD22e0d8bB"),
};
function monitoredKeeperRule(version: "v1" | "v2" | "v3", executor: Address, owner: Address) {
  const rules = keeperHealth?.eoaRules ?? (keeperHealth?.eoaRule ? [keeperHealth.eoaRule] : []);
  return rules.find((rule) => rule.version === version
    && rule.executor.toLowerCase() === executor.toLowerCase()
    && rule.owner.toLowerCase() === owner.toLowerCase());
}
const eoaExecutorV2LifecycleAbi = [
  { type: "event", name: "PolicyCancelled", anonymous: false, inputs: [{ indexed: true, name: "owner", type: "address" }, { indexed: true, name: "policyId", type: "uint256" }] },
  { type: "event", name: "PolicyExecuted", anonymous: false, inputs: [{ indexed: true, name: "owner", type: "address" }, { indexed: true, name: "policyId", type: "uint256" }, { indexed: false, name: "spotPriceE18", type: "uint256" }, { indexed: false, name: "amountIn", type: "uint256" }, { indexed: false, name: "amountOut", type: "uint256" }] },
] as const;

async function loadLifecycleLogs(executor: Address, event: typeof eoaExecutorV2LifecycleAbi[number], owner: Address) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await client.getLogs({ address: executor, event, args: { owner }, fromBlock: 0n });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => window.setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw lastError;
}

function formatElapsed(seconds: number) {
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

const pause = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
function isTemporaryRpcError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /requests limited|rate limit|too many requests|\b429\b|timeout|network|fetch failed|socket/i.test(message);
}
async function retryRpc<T>(action: () => Promise<T>) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (!isTemporaryRpcError(error) || attempt === 2) throw error;
      await pause(600 * (attempt + 1));
    }
  }
  throw lastError;
}

async function refreshKeeperHealth() {
  keeperLiveStatus.classList.remove("rpc-limited");
  keeperLiveStatus.textContent = "Checking keeper status…";
  try {
    const response = await fetch(keeperHealthUrl, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error("Health API unavailable");
    const payload = await response.json() as KeeperHealth;
    if (!payload.checkedAt) throw new Error("No keeper heartbeat yet");
    keeperHealth = payload;
    if (payload.providerStatus === "temporarily-limited") {
      keeperLiveStatus.classList.add("rpc-limited");
      const retrySeconds = payload.retryAt ? Math.max(0, Math.ceil((new Date(payload.retryAt).getTime() - Date.now()) / 1000)) : Number(payload.pollIntervalSeconds || 30);
      const successfulAt = payload.lastSuccessfulCheckAt ? Math.max(0, Math.floor((Date.now() - new Date(payload.lastSuccessfulCheckAt).getTime()) / 1000)) : undefined;
      keeperLiveStatus.textContent = `RPC temporarily limited · keeper will retry in ${formatElapsed(retrySeconds)}${successfulAt === undefined ? "" : ` · last successful check ${formatElapsed(successfulAt)} ago`}`;
      return;
    }
    const elapsed = Math.max(0, Math.floor((Date.now() - new Date(payload.checkedAt).getTime()) / 1000));
    const next = Math.max(0, Number(payload.pollIntervalSeconds || 30) - elapsed);
    const state = payload.mode === "dry-run" ? "Dry-run" : payload.mode;
    keeperLiveStatus.textContent = `Keeper online · ${state} · checked ${formatElapsed(elapsed)} ago · next check in ${formatElapsed(next)}`;
  } catch {
    keeperLiveStatus.classList.add("rpc-limited");
    keeperHealth = undefined;
    keeperLiveStatus.textContent = "Keeper status unavailable. Rule data is still loaded directly from Monad Testnet.";
  }
}
try {
  const saved = JSON.parse(localStorage.getItem("take-profit-eoa-executors") ?? "{}") as Record<string, string>;
  for (const [symbol, address] of Object.entries(saved)) eoaExecutors[symbol] = getAddress(address);
} catch { /* Ignore malformed browser storage. */ }
try {
  const saved = JSON.parse(localStorage.getItem("take-profit-eoa-executors-v2") ?? "{}") as Record<string, string>;
  for (const [symbol, address] of Object.entries(saved)) eoaExecutorsV2[symbol] = getAddress(address);
} catch { /* Ignore malformed browser storage. */ }
try {
  const saved = JSON.parse(localStorage.getItem("take-profit-eoa-executors-v3") ?? "{}") as Record<string, string>;
  for (const [symbol, address] of Object.entries(saved)) eoaExecutorsV3[symbol] = getAddress(address);
} catch { /* Ignore malformed browser storage. */ }
const safeModules: Record<string, Address> = {};
try {
  const saved = JSON.parse(localStorage.getItem("take-profit-safe-modules") ?? "{}") as Record<string, string>;
  for (const [symbol, address] of Object.entries(saved)) safeModules[symbol] = getAddress(address);
} catch { /* Ignore malformed browser storage. */ }
const walletDrawer = document.querySelector<HTMLElement>("#wallet-drawer")!;
const walletDrawerBackdrop = document.querySelector<HTMLElement>("#wallet-drawer-backdrop")!;
const drawerWalletAddress = document.querySelector<HTMLElement>("#drawer-wallet-address")!;

function openWalletDrawer() {
  if (!account) return;
  drawerWalletAddress.textContent = `${account.slice(0, 6)}...${account.slice(-4)}`;
  walletDrawerBackdrop.hidden = false;
  walletDrawer.classList.add("open");
  walletDrawer.setAttribute("aria-hidden", "false");
}
function closeWalletDrawer() {
  walletDrawer.classList.remove("open");
  walletDrawer.setAttribute("aria-hidden", "true");
  window.setTimeout(() => { walletDrawerBackdrop.hidden = true; }, 220);
}
document.querySelector<HTMLButtonElement>("#close-wallet-drawer")!.addEventListener("click", closeWalletDrawer);
walletDrawerBackdrop.addEventListener("click", closeWalletDrawer);
document.querySelector<HTMLButtonElement>("#disconnect-wallet")!.addEventListener("click", async () => {
  let permissionRevoked = false;
  try {
    await window.ethereum?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
    permissionRevoked = true;
  } catch {
    /* Some injected wallets do not implement permission revocation. Local disconnect still applies. */
  }
  account = undefined;
  safeAccount = undefined;
  nativeBalance = 0n;
  assetBalances.clear();
  assetPrices.clear();
  localStorage.removeItem("take-profit-safe-account");
  const connect = document.querySelector<HTMLButtonElement>("#connect")!;
  connect.classList.remove("wallet-button");
  connect.textContent = "Connect wallet";
  marketSwap.disabled = true;
  marketSwap.textContent = "Connect wallet to swap";
  renderSafeAccount();
  renderEoaAutomation();
  renderAssetRows();
  renderRebalancePlan();
  updatePortfolioMetrics();
  portfolioActiveRules.textContent = "0";
  updateRuleSummary("asset");
  closeWalletDrawer();
  set(permissionRevoked
    ? "MetaMask access was revoked for Take Profit. The next connection will ask MetaMask for approval again."
    : "Take Profit was disconnected locally. If MetaMask does not ask again, revoke this site's connection in MetaMask Connected sites.");
});

function renderSafeAccount() {
  safeAddressInput.value = safeAccount ?? "";
  if (!safeAccount) {
    safeState.textContent = "Not connected";
    safeStatus.textContent = "Create a Safe in Safe Wallet or paste an existing Safe address.";
    renderModuleSetup();
    return;
  }
  safeState.textContent = "Safe verified";
  safeStatus.textContent = `Assets and future rules use ${safeAccount.slice(0, 6)}...${safeAccount.slice(-4)}.`;
  renderModuleSetup();
}

function renderModuleSetup() {
  const moduleAddress = safeModules[moduleAsset.value];
  deploySafeModule.disabled = !account || !safeAccount || Boolean(moduleAddress);
  deploySafeModule.textContent = moduleAddress ? "Module deployed" : "Deploy module";
  moduleStatus.textContent = !safeAccount
    ? "Select and verify a Safe first."
    : moduleAddress
      ? `${moduleAsset.value} module: ${moduleAddress.slice(0, 6)}...${moduleAddress.slice(-4)}. Enable it in Safe before creating a rule.`
      : `Deploy a constrained ${moduleAsset.value} module. It can only execute after you enable it through Safe.`;
}

async function useSafeAccount() {
  try {
    if (!account) throw new Error("Connect MetaMask first.");
    const candidate = getAddress(safeAddressInput.value.trim());
    safeStatus.textContent = "Verifying Safe ownership on Monad Testnet...";
    const [code, owners, threshold] = await Promise.all([
      client.getCode({ address: candidate }),
      client.readContract({ address: candidate, abi: safeAbi, functionName: "getOwners" }) as Promise<Address[]>,
      client.readContract({ address: candidate, abi: safeAbi, functionName: "getThreshold" }) as Promise<bigint>,
    ]);
    if (!code || code === "0x" || threshold === 0n) throw new Error("This address is not an initialized Safe.");
    if (!owners.some((owner) => owner.toLowerCase() === account!.toLowerCase())) throw new Error("The connected MetaMask address is not an owner of this Safe.");
    safeAccount = candidate;
    localStorage.setItem("take-profit-safe-account", candidate);
    renderSafeAccount();
    await refreshOnchainAccountData();
    set("Smart Account verified. Portfolio balances now show Safe assets; MON remains in MetaMask for transaction fees.");
  } catch (error) {
    safeAccount = undefined;
    renderSafeAccount();
    safeStatus.textContent = error instanceof Error ? error.message : "Safe verification failed.";
  }
}

document.querySelector<HTMLButtonElement>("#use-safe")!.addEventListener("click", () => { void useSafeAccount(); });
moduleAsset.addEventListener("change", renderModuleSetup);
deploySafeModule.addEventListener("click", async () => {
  try {
    if (!account || !safeAccount) throw new Error("Connect MetaMask and verify your Safe first.");
    const pair = pairs.find((item) => item.symbol === moduleAsset.value)!;
    const deployment = { account, abi: safeModuleArtifact.abi, bytecode: safeModuleArtifact.bytecode as `0x${string}`, args: [pair.token, usdm, pair.pool, safeKeeper] };
    const data = encodeDeployData({ abi: deployment.abi, bytecode: deployment.bytecode, args: deployment.args });
    const estimate = await client.estimateGas({ account, data });
    const gas = estimate + estimate / 10n;
    moduleStatus.textContent = `Confirm module deployment in MetaMask. Gas limit: ${gas}.`;
    const hash = await wallet().deployContract({ ...deployment, gas });
    moduleStatus.textContent = `Deployment sent: ${hash}. Waiting for Monad Testnet...`;
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error("Deployment confirmed without a module address.");
    safeModules[pair.symbol] = getAddress(receipt.contractAddress);
    localStorage.setItem("take-profit-safe-modules", JSON.stringify(safeModules));
    renderModuleSetup();
    set(`${pair.symbol} Safe module deployed. Next: enable this exact address in your Safe.`);
  } catch (error) {
    moduleStatus.textContent = error instanceof Error ? error.shortMessage ?? error.message : "Module deployment failed.";
  }
});
try { safeAccount = getAddress(localStorage.getItem("take-profit-safe-account") ?? ""); } catch { safeAccount = undefined; }
renderSafeAccount();

function renderEoaAutomation() {
  const executor = eoaExecutorsV3[executorAsset.value] ?? eoaExecutorsV2[executorAsset.value];
  const monitored = Boolean(account && executorAsset.value === keeperDryRunRule.symbol && executor?.toLowerCase() === keeperDryRunRule.executor.toLowerCase() && account.toLowerCase() === keeperDryRunRule.owner.toLowerCase());
  eoaState.textContent = !account ? "Not connected" : monitored ? "Keeper monitoring" : "Wallet connected";
  executorStatus.textContent = !account
    ? "Connect MetaMask to start."
    : monitored
      ? `Keeper checks this JAMES rule every ${keeperHealth?.pollIntervalSeconds ?? 10} seconds in safe dry-run mode. It cannot submit a trade.`
    : executor
      ? `Multi-level automation is ready for ${executorAsset.value}. Executor: ${executor.slice(0, 6)}...${executor.slice(-4)}. Each new target gets its own independent rule.`
      : "V3 automation is deployed automatically with your first new rule. It supports up to 100 active levels; completed and cancelled levels free a slot.";
}
executorAsset.addEventListener("change", renderEoaAutomation);
async function deployExecutorV3(pair: typeof pairs[number]) {
  if (!account) throw new Error("Connect MetaMask first.");
  const existing = eoaExecutorsV3[pair.symbol];
  if (existing) {
    // A reverted CREATE transaction can still expose a prospective
    // contractAddress in its receipt. Never reuse such an address: it has no
    // bytecode and calls such as policyCount return the empty value 0x.
    const code = await retryRpc(() => client.getBytecode({ address: existing }));
    if (code && code !== "0x") return existing;
    delete eoaExecutorsV3[pair.symbol];
    localStorage.setItem("take-profit-eoa-executors-v3", JSON.stringify(eoaExecutorsV3));
    set("The previous V3 deployment did not complete, so its empty address was removed. Open MetaMask to deploy V3 again.");
  }
  const deployment = { account, abi: eoaExecutorV3Artifact.abi, bytecode: eoaExecutorV3Artifact.bytecode as `0x${string}`, args: [pair.token, usdm, pair.pool, safeKeeper] };
  // Do not perform a separate public-RPC gas estimate before opening MetaMask.
  // On the rate-limited Testnet endpoint that request can fail silently from a
  // user's perspective and prevent the wallet prompt from ever appearing.
  // MetaMask estimates this one-time deployment in its own confirmation flow.
  set(`Open MetaMask to confirm the one-time ${pair.symbol} V3 automation setup. No tokens are moved. V3 supports 100 active levels.`);
  const hash = await wallet().deployContract({ ...deployment, gas: EOA_V3_DEPLOY_GAS_LIMIT });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`V3 executor deployment reverted: ${hash}`);
  if (!receipt.contractAddress) throw new Error("Deployment confirmed without an executor address.");
  const executor = getAddress(receipt.contractAddress);
  eoaExecutorsV3[pair.symbol] = executor;
  localStorage.setItem("take-profit-eoa-executors-v3", JSON.stringify(eoaExecutorsV3));
  renderEoaAutomation();
  return executor;
}
renderEoaAutomation();

const assetRows = document.querySelector<HTMLDivElement>("#asset-rows")!;
const assetBalances = new Map<string, bigint>();
const assetPrices = new Map<string, bigint>();
let nativeBalance = 0n;
const usd = (value: number) => `${value.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
const portfolioTotalValue = document.querySelector<HTMLElement>("#portfolio-total-value")!;
const portfolioTotalCard = document.querySelector<HTMLElement>("#portfolio-total-card")!;
const portfolioTotalChart = document.querySelector<HTMLElement>("#portfolio-total-chart")!;
const portfolioChangeValue = document.querySelector<HTMLElement>("#portfolio-24h-change")!;
const portfolioChangeCard = document.querySelector<HTMLElement>("#portfolio-change-card")!;
const portfolioChangeChart = document.querySelector<HTMLElement>("#portfolio-change-chart")!;
const portfolioChangeNote = document.querySelector<HTMLElement>("#portfolio-change-note")!;
const portfolioActiveRules = document.querySelector<HTMLElement>("#portfolio-active-rules")!;
type PortfolioSnapshot = { at: number; value: number };
const portfolioHistoryKey = "take-profit-portfolio-value-history";

function portfolioValueUsd() {
  const stableValue = number(assetBalances.get("USDm") ?? 0n, 6);
  return stableValue + pairs.reduce((total, pair) => total + number(assetBalances.get(pair.symbol) ?? 0n, 18) * number(assetPrices.get(pair.symbol) ?? 0n, 18), 0);
}

function portfolioChangePercent() {
  if (!account) return 0;
  try {
    const saved = JSON.parse(localStorage.getItem(portfolioHistoryKey) ?? "{}") as Record<string, PortfolioSnapshot[]>;
    const history = saved[account.toLowerCase()];
    const baseline = history?.[0]?.value;
    const total = portfolioValueUsd();
    return baseline && total > 0 ? ((total - baseline) / baseline) * 100 : 0;
  } catch {
    return 0;
  }
}

// A swap made through this interface changes the owner's asset composition,
// but must not be reported as market profit or loss. Keep the already-earned
// percentage and rebase the portfolio value after the confirmed swap.
function preservePortfolioChangeAfterOwnSwap(changeBeforeSwap: number) {
  if (!account) return;
  const total = portfolioValueUsd();
  const multiplier = 1 + changeBeforeSwap / 100;
  if (total <= 0 || multiplier <= 0) return;
  try {
    const saved = JSON.parse(localStorage.getItem(portfolioHistoryKey) ?? "{}") as Record<string, PortfolioSnapshot[]>;
    const key = account.toLowerCase();
    const history = Array.isArray(saved[key]) ? saved[key] : [];
    const baselineAt = history[0]?.at ?? Date.now();
    saved[key] = [{ at: baselineAt, value: total / multiplier }];
    localStorage.setItem(portfolioHistoryKey, JSON.stringify(saved));
  } catch {
    /* The portfolio can still render without locally persisted performance history. */
  }
}

function updatePortfolioMetrics() {
  const total = portfolioValueUsd();
  portfolioTotalValue.innerHTML = `${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span class="portfolio-total-unit">USDm</span>`;
  if (!account || total <= 0) {
    portfolioChangeValue.textContent = "--";
    portfolioChangeNote.textContent = "Connect a wallet to build price history";
    setPortfolioChartState(0);
    return;
  }

  let history: PortfolioSnapshot[] = [];
  try {
    const saved = JSON.parse(localStorage.getItem(portfolioHistoryKey) ?? "{}") as Record<string, PortfolioSnapshot[]>;
    history = Array.isArray(saved[account.toLowerCase()]) ? saved[account.toLowerCase()] : [];
    const now = Date.now();
    history = history.filter((snapshot) => Number.isFinite(snapshot.at) && Number.isFinite(snapshot.value) && snapshot.at > now - 24 * 60 * 60 * 1000);
    const last = history.at(-1);
    if (!last || now - last.at >= 5 * 60 * 1000) history.push({ at: now, value: total });
    saved[account.toLowerCase()] = history;
    localStorage.setItem(portfolioHistoryKey, JSON.stringify(saved));
  } catch {
    history = [{ at: Date.now(), value: total }];
  }
  const baseline = history[0]?.value || total;
  const change = baseline > 0 ? ((total - baseline) / baseline) * 100 : 0;
  portfolioChangeValue.textContent = `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
  setPortfolioChartState(change);
  const historyAge = Date.now() - (history[0]?.at ?? Date.now());
  portfolioChangeNote.textContent = historyAge >= 23.75 * 60 * 60 * 1000 ? "Value change over the last 24 hours" : "Value change since this wallet session started";
}

function setPortfolioChartState(change: number) {
  const isPositive = change >= 0;
  for (const card of [portfolioTotalCard, portfolioChangeCard]) {
    card.classList.toggle("positive", isPositive);
    card.classList.toggle("negative", !isPositive);
  }
  const intensity = Math.min(1, Math.max(.35, Math.abs(change) / 5));
  portfolioTotalCard.style.setProperty("--pnl-intensity", intensity.toFixed(2));
  portfolioChangeCard.style.setProperty("--pnl-intensity", intensity.toFixed(2));

  for (const chart of [portfolioTotalChart, portfolioChangeChart]) {
    chart.classList.remove("chart-refresh");
    void chart.offsetWidth;
    chart.classList.add("chart-refresh");
  }
}

function flashCurrentPrice(direction: "up" | "down") {
  const className = direction === "up" ? "price-flash-up" : "price-flash-down";
  for (const target of document.querySelectorAll<HTMLElement>("#rule-current-price, #summary-current-price")) {
    target.classList.remove("price-flash-up", "price-flash-down");
    void target.offsetWidth;
    target.classList.add(className);
    window.setTimeout(() => target.classList.remove(className), 1300);
  }
}

type AssetPriceSnapshot = { at: number; price: number };
const assetPriceHistoryKey = "take-profit-asset-price-history";

function collectAssetPriceChanges() {
  const changes = new Map<string, number>();
  if (!account) return changes;

  try {
    const saved = JSON.parse(localStorage.getItem(assetPriceHistoryKey) ?? "{}") as Record<string, Record<string, AssetPriceSnapshot[]>>;
    const owner = account.toLowerCase();
    const ownerHistory = saved[owner] ?? {};
    const now = Date.now();

    for (const pair of pairs) {
      const price = number(assetPrices.get(pair.symbol) ?? 0n, 18);
      if (!Number.isFinite(price) || price <= 0) continue;
      const history = (Array.isArray(ownerHistory[pair.symbol]) ? ownerHistory[pair.symbol] : [])
        .filter((snapshot) => Number.isFinite(snapshot.at) && Number.isFinite(snapshot.price) && snapshot.at > now - 24 * 60 * 60 * 1000);
      const last = history.at(-1);
      if (!last || now - last.at >= 5 * 60 * 1000) history.push({ at: now, price });
      ownerHistory[pair.symbol] = history;
      const baseline = history[0]?.price ?? price;
      changes.set(pair.symbol, baseline > 0 ? ((price - baseline) / baseline) * 100 : 0);
    }

    saved[owner] = ownerHistory;
    localStorage.setItem(assetPriceHistoryKey, JSON.stringify(saved));
  } catch {
    // Price history is visual-only; the table still works without local storage.
  }
  return changes;
}

function priceChangeMarkup(change: number | undefined, isTradeable: boolean) {
  if (!isTradeable || change === undefined || Math.abs(change) < 0.005) {
    return '<small class="asset-price-change neutral">0.00%</small>';
  }
  const isNegative = change < 0;
  return `<small class="asset-price-change ${isNegative ? "negative" : "positive"}">${isNegative ? "↓" : "↑"} ${isNegative ? "" : "+"}${change.toFixed(2)}%</small>`;
}

const sparklinePaths = {
  neutral: "M1 14 L85 14",
  positive: "M1 19 8 13 15 20 23 15 30 17 38 8 46 16 53 11 60 14 68 6 76 12 85 5",
  negative: "M1 5 8 11 15 6 23 13 30 8 38 16 46 8 53 15 60 11 68 20 76 13 85 19",
} as const;

function priceSparklineMarkup(change: number | undefined, isTradeable: boolean) {
  const state = !isTradeable || change === undefined || Math.abs(change) < 0.005
    ? "neutral"
    : change < 0 ? "negative" : "positive";
  return `<i class="asset-sparkline ${state}" aria-hidden="true"><svg viewBox="0 0 86 28" preserveAspectRatio="none"><path d="${sparklinePaths[state]}"/></svg></i>`;
}

const allAssetSymbols = ["MON", ...pairs.map((pair) => pair.symbol), "USDm"];
type AssetSort = "none" | "value-desc" | "value-asc" | "change-desc" | "change-asc";
let assetSort: AssetSort = "none";
const hiddenAssetSymbols = new Set<string>();

function renderAssetRows() {
  const priceChanges = collectAssetPriceChanges();
  const assets = [{ symbol: "MON", balance: nativeBalance, price: 0n, decimals: 18 }, ...pairs.map((pair) => ({ symbol: pair.symbol, balance: assetBalances.get(pair.symbol) ?? 0n, price: assetPrices.get(pair.symbol) ?? 0n, decimals: 18 })), { symbol: "USDm", balance: assetBalances.get("USDm") ?? 0n, price: parseUnits("1", 18), decimals: 6 }]
    .filter((asset) => !hiddenAssetSymbols.has(asset.symbol))
    .map((asset) => {
      const numericValue = asset.symbol === "MON" ? -1 : Number(formatUnits(asset.balance, asset.decimals)) * Number(formatUnits(asset.price, 18));
      const numericChange = priceChanges.get(asset.symbol) ?? 0;
      return { ...asset, numericValue, numericChange };
    });
  if (assetSort === "value-desc") assets.sort((a, b) => b.numericValue - a.numericValue);
  else if (assetSort === "value-asc") assets.sort((a, b) => a.numericValue - b.numericValue);
  else if (assetSort === "change-desc") assets.sort((a, b) => b.numericChange - a.numericChange);
  else if (assetSort === "change-asc") assets.sort((a, b) => a.numericChange - b.numericChange);
  assetRows.innerHTML = assets.map((asset) => {
    const isTradeable = pairs.some((pair) => pair.symbol === asset.symbol);
    const change = priceChanges.get(asset.symbol);
    const price = asset.symbol === "MON" ? "Network token" : usd(Number(formatUnits(asset.price, 18)));
    const holding = `${display(asset.balance, asset.decimals)} ${asset.symbol}`;
    const value = asset.symbol === "MON" ? "—" : usd(asset.numericValue);
    const action = isTradeable ? `<button type="button" class="row-action" data-select-asset="${asset.symbol}">Take Profit</button>` : "";
    return `<div class="asset-row" data-symbol="${asset.symbol}"><span class="asset-name"><i class="token-dot">${asset.symbol.slice(0, 1)}</i><span><b>${asset.symbol}</b><small>${asset.symbol === "USDm" ? "Monad Dollar" : asset.symbol}</small></span></span><span class="asset-price"><span><b>${price}</b>${priceChangeMarkup(change, isTradeable)}</span>${priceSparklineMarkup(change, isTradeable)}</span><span>${holding}</span><span class="asset-value">${value}</span><span class="row-action-cell">${action}</span></div>`;
  }).join("");
  applyAssetFilter();
}

assetRows.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-select-asset]");
  if (!button) return;
  const symbol = button.dataset.selectAsset!;
  document.querySelector<HTMLElement>("[data-tab='take-profit']")?.click();
  if (ruleAsset.value !== symbol) {
    ruleAsset.value = symbol;
    ruleAsset.dispatchEvent(new Event("change", { bubbles: true }));
  }
  window.requestAnimationFrame(() => document.querySelector<HTMLElement>(".rule-config")?.scrollIntoView({ behavior: "smooth", block: "start" }));
});

const classicAssetSearch = document.querySelector<HTMLInputElement>("#asset-search");
const v2AssetSearch = document.querySelector<HTMLInputElement>("#v2-asset-search");
const v2AssetCount = document.querySelector<HTMLElement>("#v2-asset-count");
function applyAssetFilter() {
  const term = (isPortfolioV2Route ? v2AssetSearch?.value : classicAssetSearch?.value)?.trim().toLowerCase() ?? "";
  const rows = [...assetRows.querySelectorAll<HTMLElement>(".asset-row")];
  let visible = 0;
  for (const row of rows) {
    const match = !term || (row.dataset.symbol ?? "").toLowerCase().startsWith(term);
    row.hidden = !match;
    if (match) visible++;
  }
  if (v2AssetCount) v2AssetCount.textContent = `Showing ${visible} of ${rows.length} assets`;
}
classicAssetSearch?.addEventListener("input", applyAssetFilter);
v2AssetSearch?.addEventListener("input", applyAssetFilter);

function closeAssetPopovers(except?: HTMLElement) {
  for (const popover of document.querySelectorAll<HTMLElement>(".asset-popover")) {
    if (popover === except) continue;
    popover.hidden = true;
    popover.previousElementSibling?.setAttribute("aria-expanded", "false");
  }
}
function toggleAssetPopover(button: HTMLButtonElement | null, popover: HTMLElement | null) {
  if (!button || !popover) return;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const willOpen = popover.hidden;
    closeAssetPopovers(willOpen ? popover : undefined);
    popover.hidden = !willOpen;
    button.setAttribute("aria-expanded", String(willOpen));
  });
}
document.addEventListener("click", () => closeAssetPopovers());

const assetSortToggle = document.querySelector<HTMLButtonElement>("#asset-sort-toggle");
const assetSortMenu = document.querySelector<HTMLElement>("#asset-sort-menu");
toggleAssetPopover(assetSortToggle, assetSortMenu);
assetSortMenu?.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-sort]");
  if (!target) return;
  assetSort = target.dataset.sort as AssetSort;
  for (const option of assetSortMenu.querySelectorAll("[data-sort]")) option.classList.toggle("active", option === target);
  closeAssetPopovers();
  renderAssetRows();
});

const assetVisibilityToggle = document.querySelector<HTMLButtonElement>("#asset-visibility-toggle");
const assetVisibilityMenu = document.querySelector<HTMLElement>("#asset-visibility-menu");
if (assetVisibilityMenu) {
  assetVisibilityMenu.innerHTML = allAssetSymbols.map((symbol) => `<label><input type="checkbox" data-symbol="${symbol}" checked/>${symbol}</label>`).join("");
  assetVisibilityMenu.addEventListener("change", (event) => {
    const checkbox = event.target as HTMLInputElement;
    const symbol = checkbox.dataset.symbol;
    if (!symbol) return;
    if (checkbox.checked) hiddenAssetSymbols.delete(symbol); else hiddenAssetSymbols.add(symbol);
    renderAssetRows();
  });
}
toggleAssetPopover(assetVisibilityToggle, assetVisibilityMenu);

const rebalanceSymbols = ["JAMES", "EMO", "CHOG", "USDm"] as const;
const rebalanceDefaults: Record<(typeof rebalanceSymbols)[number], number> = { JAMES: 40, EMO: 30, CHOG: 20, USDm: 10 };
const rebalanceRows = document.querySelector<HTMLDivElement>("#rebalance-rows");
const rebalanceTotal = document.querySelector<HTMLElement>("#rebalance-total");
const rebalanceStatus = document.querySelector<HTMLElement>("#rebalance-status");

function rebalanceTarget(symbol: (typeof rebalanceSymbols)[number]) {
  const input = document.querySelector<HTMLInputElement>(`#rebalance-${symbol.toLowerCase()}`);
  const value = Number(input?.value ?? 0);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function renderRebalancePlan() {
  if (!rebalanceRows || !rebalanceTotal || !rebalanceStatus) return;

  const targets = Object.fromEntries(rebalanceSymbols.map((symbol) => [symbol, rebalanceTarget(symbol)])) as Record<(typeof rebalanceSymbols)[number], number>;
  const targetTotal = rebalanceSymbols.reduce((total, symbol) => total + targets[symbol], 0);
  rebalanceTotal.textContent = `${targetTotal.toFixed(2).replace(/\.00$/, "")}%`;
  rebalanceTotal.classList.toggle("invalid", Math.abs(targetTotal - 100) > 0.01);

  if (!account) {
    rebalanceRows.innerHTML = '<p class="empty-rebalance">Connect a wallet to load allocation data.</p>';
    rebalanceStatus.textContent = "Connect a wallet to build a rebalance preview.";
    return;
  }

  const values = Object.fromEntries(rebalanceSymbols.map((symbol) => {
    const balance = assetBalances.get(symbol) ?? 0n;
    const decimals = symbol === "USDm" ? 6 : 18;
    const price = symbol === "USDm" ? 1 : number(assetPrices.get(symbol) ?? 0n, 18);
    return [symbol, number(balance, decimals) * price];
  })) as Record<(typeof rebalanceSymbols)[number], number>;
  const total = rebalanceSymbols.reduce((sum, symbol) => sum + values[symbol], 0);

  if (total <= 0) {
    rebalanceRows.innerHTML = '<p class="empty-rebalance">Waiting for wallet balances and market prices.</p>';
    rebalanceStatus.textContent = "Wallet connected. Refreshing portfolio allocation…";
    return;
  }

  rebalanceRows.innerHTML = rebalanceSymbols.map((symbol) => {
    const current = values[symbol] / total * 100;
    const delta = targets[symbol] - current;
    const action = Math.abs(delta) < 0.05 ? "Balanced" : delta > 0 ? `Buy ${delta.toFixed(2)}%` : `Sell ${Math.abs(delta).toFixed(2)}%`;
    const actionClass = Math.abs(delta) < 0.05 ? "balanced" : delta > 0 ? "buy" : "sell";
    return `<div class="rebalance-row"><span class="asset-name"><i class="token-dot">${symbol.slice(0, 1)}</i><b>${symbol}</b></span><span>${current.toFixed(2)}%</span><span>${targets[symbol].toFixed(2)}%</span><span class="rebalance-action ${actionClass}">${action}</span></div>`;
  }).join("");
  rebalanceStatus.textContent = Math.abs(targetTotal - 100) > 0.01
    ? `Target allocation must equal 100%. ${targetTotal.toFixed(2)}% selected.`
    : "Preview ready. Confirm individual trades separately when execution is enabled.";
}

for (const symbol of rebalanceSymbols) {
  document.querySelector<HTMLInputElement>(`#rebalance-${symbol.toLowerCase()}`)?.addEventListener("input", renderRebalancePlan);
}

document.querySelector<HTMLButtonElement>("#reset-rebalance-targets")?.addEventListener("click", () => {
  for (const symbol of rebalanceSymbols) {
    const input = document.querySelector<HTMLInputElement>(`#rebalance-${symbol.toLowerCase()}`);
    if (input) input.value = String(rebalanceDefaults[symbol]);
  }
  renderRebalancePlan();
});

document.querySelector<HTMLButtonElement>("#preview-rebalance")?.addEventListener("click", () => {
  renderRebalancePlan();
  if (rebalanceStatus && Math.abs(rebalanceSymbols.reduce((total, symbol) => total + rebalanceTarget(symbol), 0) - 100) <= 0.01) {
    rebalanceStatus.textContent = "Rebalance preview updated. Review the suggested buys and sells before execution.";
  }
});

renderAssetRows();
renderRebalancePlan();

for (const trigger of document.querySelectorAll<HTMLElement>("[data-tab]")) {
  trigger.addEventListener("click", () => {
    const tab = trigger.dataset.tab!;
    document.querySelectorAll<HTMLElement>(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `${tab}-panel`));
    document.querySelectorAll<HTMLElement>(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.tab === tab));
  });
}

document.querySelector<HTMLButtonElement>("#view-all-rules")!.addEventListener("click", () => {
  document.querySelector<HTMLElement>("[data-tab='take-profit']")?.click();
  window.requestAnimationFrame(() => document.querySelector<HTMLElement>(".existing-rules")?.scrollIntoView({ behavior: "smooth", block: "start" }));
});

document.querySelector<HTMLDivElement>("#swaps")!.innerHTML = pairs.map((pair) => `<section><h2>${pair.symbol}/USDm</h2><label>Direction <select id="${pair.symbol}-direction"><option value="buy">Buy ${pair.symbol} with USDm (price up)</option><option value="sell">Sell ${pair.symbol} for USDm (price down)</option></select></label><label>Amount in <input id="${pair.symbol}-amount" value="10000" inputmode="decimal"/></label><p id="${pair.symbol}-quote">Enter an amount to calculate the quote.</p><button id="${pair.symbol}-swap" disabled>Swap</button></section>`).join("");
document.querySelector<HTMLDivElement>("#vaults")!.innerHTML = pairs.map((pair) => `<section><h2>${pair.symbol} PolicyVault</h2><label>Take-profit price (USDm) <input id="${pair.symbol}-take" value="14" inputmode="decimal"/></label><label>Rebalance price (USDm) <input id="${pair.symbol}-rebalance" value="10" inputmode="decimal"/></label><label>Trade share (%) <input id="${pair.symbol}-share" value="25" inputmode="numeric"/></label><label>Max slippage (%) <input id="${pair.symbol}-slippage" value="1" inputmode="decimal"/></label><button id="${pair.symbol}-deploy" disabled>Deploy ${pair.symbol} PolicyVault</button></section>`).join("");
document.querySelector<HTMLDivElement>("#funding")!.innerHTML = pairs.map((pair) => `<section><h2>Fund ${pair.symbol} vault</h2><label>${pair.symbol} <input id="${pair.symbol}-fund-asset" value="1000" inputmode="decimal"/></label><label>USDm <input id="${pair.symbol}-fund-usdm" value="10000" inputmode="decimal"/></label><button id="${pair.symbol}-fund" disabled>Approve and fund vault</button></section>`).join("");
document.querySelector<HTMLDivElement>("#execution")!.innerHTML = pairs.map((pair) => `<section><h2>${pair.symbol} policy status</h2><p id="${pair.symbol}-policy">Connect MetaMask to read the policy.</p><button id="${pair.symbol}-refresh">Refresh policy</button><button id="${pair.symbol}-execute" disabled>Execute policy</button></section>`).join("");
document.querySelector<HTMLDivElement>("#keepers")!.innerHTML = pairs.map((pair) => `<section><h2>${pair.symbol} keeper</h2><button id="${pair.symbol}-keeper" disabled>Assign keeper</button></section>`).join("");
document.querySelector<HTMLDivElement>("#ownership")!.innerHTML = pairs.map((pair) => `<section><h2>${pair.symbol} legacy vault owner</h2><button id="${pair.symbol}-ownership" disabled>Transfer legacy ownership</button></section>`).join("");

const marketAmount = document.querySelector<HTMLInputElement>("#market-amount")!;
marketAmount.autocomplete = "off";
marketAmount.setAttribute("aria-autocomplete", "none");
const marketSell = document.querySelector<HTMLSelectElement>("#market-sell-token")!;
const marketBuy = document.querySelector<HTMLSelectElement>("#market-buy-token")!;
const marketQuote = document.querySelector<HTMLOutputElement>("#market-quote")!;
const marketOutputNode = document.querySelector<HTMLOutputElement>("#market-output")!;
const marketOutput = document.createElement("input");
marketOutput.id = marketOutputNode.id;
marketOutput.value = marketOutputNode.value;
marketOutput.inputMode = "decimal";
marketOutput.autocomplete = "off";
marketOutput.setAttribute("aria-label", "Amount to buy");
marketOutputNode.replaceWith(marketOutput);
const marketSwap = document.querySelector<HTMLButtonElement>("#market-swap")!;
const marketPair = () => pairs.find((pair) => pair.symbol === (marketSell.value === "USDm" ? marketBuy.value : marketSell.value))!;
const marketDecimals = (symbol: string) => symbol === "USDm" ? 6 : 18;
const marketBalance = (symbol: string) => assetBalances.get(symbol) ?? 0n;
const formatMarketAmount = (amount: bigint, decimals: number) => formatUnits(amount, decimals);
const displayMarketBalance = (amount: bigint, decimals: number) => Number(formatUnits(amount, decimals)).toLocaleString(undefined, { maximumFractionDigits: 2 });
const ceilDiv = (value: bigint, divisor: bigint) => (value + divisor - 1n) / divisor;
let marketQuoteRequest = 0;
function renderMarketBalances() {
  const sellSymbol = marketSell.value;
  const buySymbol = marketBuy.value;
  document.querySelector<HTMLElement>("#sell-balance")!.textContent = `${displayMarketBalance(marketBalance(sellSymbol), marketDecimals(sellSymbol))} ${sellSymbol}`;
  document.querySelector<HTMLElement>("#buy-balance")!.textContent = `${displayMarketBalance(marketBalance(buySymbol), marketDecimals(buySymbol))} ${buySymbol}`;
}
function marketAmountRaw(value: string, symbol: string) {
  try { return parseUnits(normalizeDecimal(value) || "0", marketDecimals(symbol)); } catch { return 0n; }
}
async function syncMarketTrade(source: "sell" | "buy" = "sell") {
  const requestId = ++marketQuoteRequest;
  const pair = marketPair();
  const direction = marketSell.value === "USDm" ? "buy" : "sell";
  // The original per-pair controls are no longer rendered in the Portfolio
  // layout. Keep these references optional so the new market card can work
  // without the legacy DOM being present.
  const legacyDirection = document.querySelector<HTMLSelectElement>(`#${pair.symbol}-direction`);
  const legacyAmount = document.querySelector<HTMLInputElement>(`#${pair.symbol}-amount`);
  if (legacyDirection) legacyDirection.value = direction;
  renderMarketBalances();
  const sellAmount = marketAmountRaw(marketAmount.value, marketSell.value);
  marketAmount.classList.toggle("invalid", sellAmount > marketBalance(marketSell.value));
  if (source === "sell" && sellAmount <= 0n) {
    marketOutput.value = "0";
    marketQuote.value = "Enter an amount to calculate the quote.";
    marketSwap.disabled = true;
    return;
  }
  try {
    if (source === "buy") {
      const wanted = marketAmountRaw(marketOutput.value, marketBuy.value);
      if (wanted <= 0n) {
        marketAmount.value = "0";
        marketQuote.value = "Enter an amount to calculate the quote.";
        marketSwap.disabled = true;
        return;
      }
      const [assetReserve, stableReserve] = await client.readContract({ address: pair.pool, abi: poolArtifact.abi, functionName: "getReserves" }) as readonly [bigint, bigint];
      const reserveIn = marketSell.value === "USDm" ? stableReserve : assetReserve;
      const reserveOut = marketSell.value === "USDm" ? assetReserve : stableReserve;
      if (wanted >= reserveOut) throw new Error("Requested buy amount exceeds pool liquidity.");
      const afterFee = ceilDiv(wanted * reserveIn * 10_000n, reserveOut - wanted);
      const required = ceilDiv(afterFee, 9_970n);
      if (requestId !== marketQuoteRequest) return;
      marketAmount.value = formatMarketAmount(required, marketDecimals(marketSell.value));
      if (legacyAmount) legacyAmount.value = marketAmount.value;
      marketQuote.value = `Requires ${marketAmount.value} ${marketSell.value} for ${marketOutput.value} ${marketBuy.value}.`;
    } else {
      if (legacyAmount) legacyAmount.value = marketAmount.value;
      const output = await client.readContract({ address: pair.pool, abi: poolArtifact.abi, functionName: "getAmountOut", args: [marketSell.value === "USDm" ? usdm : pair.token, sellAmount] }) as bigint;
      if (requestId !== marketQuoteRequest) return;
      marketOutput.value = formatMarketAmount(output, marketDecimals(marketBuy.value));
      marketQuote.value = `Expected: ${marketOutput.value} ${marketBuy.value}.`;
    }
    const finalSellAmount = marketAmountRaw(marketAmount.value, marketSell.value);
    const exceedsBalance = finalSellAmount > marketBalance(marketSell.value);
    marketAmount.classList.toggle("invalid", exceedsBalance);
    marketSwap.disabled = !account || finalSellAmount <= 0n || exceedsBalance;
  } catch {
    if (requestId !== marketQuoteRequest) return;
    marketQuote.value = "Quote temporarily unavailable. Please retry.";
    marketSwap.disabled = true;
  }
}
function normalizeMarketTokens(changed: "sell" | "buy") {
  if (changed === "sell" && marketSell.value !== "USDm") marketBuy.value = "USDm";
  if (changed === "buy" && marketBuy.value !== "USDm") marketSell.value = "USDm";
  if (marketSell.value === marketBuy.value) marketBuy.value = marketSell.value === "USDm" ? "JAMES" : "USDm";
  void syncMarketTrade("sell");
}
let marketAmountIsInitialZero = marketAmount.value === "0";
let marketOutputIsInitialZero = marketOutput.value === "0";
marketAmount.addEventListener("focus", () => {
  if (!marketAmountIsInitialZero || marketAmount.value !== "0") return;
  marketAmount.value = "";
  marketAmountIsInitialZero = false;
  void syncMarketTrade("sell");
});
marketAmount.addEventListener("input", () => { marketAmountIsInitialZero = false; void syncMarketTrade("sell"); });
marketAmount.addEventListener("blur", () => {
  if (marketAmount.value.trim() === "") {
    marketAmount.value = "0";
    void syncMarketTrade("sell");
  }
});
marketOutput.addEventListener("focus", () => {
  if (!marketOutputIsInitialZero || marketOutput.value !== "0") return;
  marketOutput.value = "";
  marketOutputIsInitialZero = false;
});
marketOutput.addEventListener("input", () => { marketOutputIsInitialZero = false; void syncMarketTrade("buy"); });
marketOutput.addEventListener("blur", () => {
  if (marketOutput.value.trim() === "") {
    marketOutput.value = "0";
    void syncMarketTrade("buy");
  }
});
marketSell.addEventListener("change", () => normalizeMarketTokens("sell"));
marketBuy.addEventListener("change", () => normalizeMarketTokens("buy"));
document.querySelector<HTMLButtonElement>("#market-switch")!.addEventListener("click", () => {
  const sell = marketSell.value; marketSell.value = marketBuy.value; marketBuy.value = sell;
  const amount = marketAmount.value; marketAmount.value = marketOutput.value; marketOutput.value = amount;
  void syncMarketTrade("sell");
});
marketSwap.addEventListener("click", () => { document.querySelector<HTMLButtonElement>(`#${marketPair().symbol}-swap`)!.click(); });

const ruleAsset = document.querySelector<HTMLSelectElement>("#rule-asset")!;
const ruleCurrentPrice = document.querySelector<HTMLInputElement>("#rule-current-price")!;
const ruleTake = document.querySelector<HTMLInputElement>("#rule-take")!;
const ruleShare = document.querySelector<HTMLInputElement>("#rule-share")!;
const growthRange = document.querySelector<HTMLInputElement>("#growth-range")!;
const growthInput = document.querySelector<HTMLInputElement>("#growth-input")!;
const sellInput = document.querySelector<HTMLInputElement>("#sell-input")!;
if (!document.querySelector("#rule-slippage")) {
  document.querySelector<HTMLElement>(".rule-config .section-title")!.insertAdjacentHTML("beforeend", '<button id="rule-settings-toggle" class="rule-settings-toggle" type="button" aria-label="Rule settings" aria-expanded="false">⚙</button>');
  document.body.insertAdjacentHTML("beforeend", '<div id="rule-settings-backdrop" class="rule-settings-backdrop" hidden><section class="rule-settings-popover" role="dialog" aria-modal="true" aria-labelledby="rule-settings-title"><div class="rule-settings-heading"><div><p class="eyebrow">Execution settings</p><h3 id="rule-settings-title">Rule settings</h3></div><button id="rule-settings-close" class="rule-settings-close" type="button" aria-label="Close settings">×</button></div><label>Slippage (%)<input id="rule-slippage" type="text" value="1" inputmode="decimal"/></label><label>Max keeper gas<input id="rule-max-gas" type="text" value="320000" inputmode="numeric"/></label><small>Slippage is stored on-chain. Max gas is saved for this level and cannot exceed the keeper safety cap.</small></section></div>');
}
const ruleSlippage = document.querySelector<HTMLInputElement>("#rule-slippage")!;
document.querySelector("#rule-max-gas")?.closest("label")?.remove();
document.querySelector(".rule-settings-popover small")!.textContent = "Minimum sell price is calculated automatically. Keeper starts at 500,000 gas and selects a higher pre-flight tier only when required, up to 4,000,000.";
ruleSlippage.closest("label")!.insertAdjacentHTML("afterend", '<div class="rule-min-price"><span>Minimum sell price</span><strong id="rule-min-price">--</strong></div>');
document.querySelector("#summary-price")!.closest("div")!.insertAdjacentHTML("afterend", '<div><dt>Minimum sell price</dt><dd id="summary-min-price">--</dd></div>');
const ruleMinimumSellPrice = document.querySelector<HTMLElement>("#rule-min-price")!;
const summaryMinimumSellPrice = document.querySelector<HTMLElement>("#summary-min-price")!;
const ruleSettingsToggle = document.querySelector<HTMLButtonElement>("#rule-settings-toggle")!;
const ruleSettingsBackdrop = document.querySelector<HTMLElement>("#rule-settings-backdrop")!;
const closeRuleSettings = () => { ruleSettingsBackdrop.hidden = true; ruleSettingsToggle.setAttribute("aria-expanded", "false"); };
ruleSettingsToggle.addEventListener("click", () => { const isOpen = !ruleSettingsBackdrop.hidden; ruleSettingsBackdrop.hidden = isOpen; ruleSettingsToggle.setAttribute("aria-expanded", String(!isOpen)); if (!isOpen) ruleSlippage.focus(); });
document.querySelector<HTMLButtonElement>("#rule-settings-close")!.addEventListener("click", closeRuleSettings);
ruleSettingsBackdrop.addEventListener("click", (event) => { if (event.target === ruleSettingsBackdrop) closeRuleSettings(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeRuleSettings(); });
// Monad charges by the chosen gas limit. The V3 deployment bytecode is about
// 12.6 KB, whose code-deposit cost alone exceeds MetaMask's 1M default. This
// is only for the one-time executor deployment, never for rule execution.
// Monad charges the submitted gas limit, not merely gas used. The corrected
// V3 bytecode estimates at ~1.21M on Testnet; this leaves a small deployment
// buffer without making users pay for an oversized 3M limit.
const EOA_V3_DEPLOY_GAS_LIMIT = 1_350_000n;
type RuleExecutionSettings = { maxGas: number; slippageBps: number };
const ruleSettingsStorageKey = "take-profit-v2-rule-settings";
const loadRuleSettings = (): Record<string, RuleExecutionSettings> => {
  try { return JSON.parse(localStorage.getItem(ruleSettingsStorageKey) ?? "{}"); } catch { return {}; }
};
const saveRuleSettings = (settings: Record<string, RuleExecutionSettings>) => localStorage.setItem(ruleSettingsStorageKey, JSON.stringify(settings));
const ruleSettingsKey = (executor: Address, owner: Address, policyId: bigint) => `${executor.toLowerCase()}:${owner.toLowerCase()}:${policyId}`;
async function syncRuleMaxGas(executor: Address, owner: Address, policyId: bigint, maxGas: number) {
  const command = { action: "take-profit-rule-settings", chainId: 10143, executor, owner, policyId: policyId.toString(), maxGas, issuedAt: Date.now() };
  const message = [
    "Take Profit — keeper settings confirmation",
    "",
    "This signature does not move tokens or grant token spending permission.",
    "It only authorizes the keeper to store the maximum gas limit below for this specific rule.",
    "",
    JSON.stringify(command),
  ].join("\n");
  const signature = await wallet().signMessage({ message });
  const response = await fetch(`${keeperHealthUrl.replace(/\/health$/, "")}/rule-settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, signature }), signal: AbortSignal.timeout(5_000) });
  const result = await response.json() as { ok?: boolean; error?: string };
  if (!response.ok || !result.ok) throw new Error(result.error ?? "Keeper did not save the gas limit.");
}
growthInput.removeAttribute("max");
growthInput.step = "any";
growthRange.step = "0.01";
sellInput.min = "0.000000000000000001";
sellInput.step = "any";
ruleShare.min = "0.0000000001";
ruleShare.step = "0.01";
let sellAmountMode: "slider" | "manual" = "slider";
// Keep an explicitly entered target stable across balance refreshes and the
// multi-step MetaMask flow. Only growth controls may recalculate it.
let targetPriceMode: "growth" | "manual" = "growth";
const number = (amount: bigint, decimals: number) => Number(formatUnits(amount, decimals));
const normalizeDecimal = (value: string) => value.trim().replace(/\s/g, "").replace(",", ".");
const decimalNumber = (value: string) => Number(normalizeDecimal(value));
const displayPercent = (value: number) => Number.isFinite(value) ? value.toFixed(2) : "";
const updateRuleSummary = (source: "growth" | "target" | "asset" | "amount" | "growth-input" | "amount-input" | "slippage" = "growth") => {
  const pair = pairs.find((item) => item.symbol === ruleAsset.value)!;
  const balance = assetBalances.get(pair.symbol) ?? 0n;
  const currentPrice = number(assetPrices.get(pair.symbol) ?? 0n, 18);
  let growth = Number(growthRange.value);
  if (source === "growth-input") growth = decimalNumber(growthInput.value);
  // A target below the current price is a negative change. It is useful for a
  // dry-run trigger check, and must not be silently converted to +10%.
  if (!Number.isFinite(growth) || growth <= -100) growth = 0;
  if (source === "growth-input") growthRange.value = String(Math.max(-90, Math.min(500, growth)));
  if (source === "growth" || source === "growth-input") targetPriceMode = "growth";
  if (source === "target") targetPriceMode = "manual";
  if (source === "amount") sellAmountMode = "slider";
  if (source === "amount-input") sellAmountMode = "manual";
  const usingManualAmount = sellAmountMode === "manual";
  let amount = usingManualAmount ? decimalNumber(sellInput.value) : number(balance, 18) * Number(ruleShare.value) / 100;
  if (!Number.isFinite(amount) || amount < 0) amount = 0;
  if (usingManualAmount && balance > 0n) ruleShare.value = String(Math.max(0.0000000001, Math.min(100, amount / number(balance, 18) * 100)));
  const share = balance > 0n ? amount / number(balance, 18) * 100 : 0;
  if (currentPrice > 0) {
    ruleCurrentPrice.value = `${usd(currentPrice)} USDm`;
    ruleTake.disabled = false;
    if (targetPriceMode === "growth") ruleTake.value = (currentPrice * (1 + growth / 100)).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    if (targetPriceMode === "manual" || source === "amount" || source === "amount-input" || source === "slippage") {
      growth = (decimalNumber(ruleTake.value) / currentPrice - 1) * 100;
      growthInput.value = displayPercent(growth);
      growthRange.value = String(Math.max(-90, Math.min(500, growth)));
    }
  } else {
    ruleCurrentPrice.value = "Connect wallet to load price";
    ruleTake.value = "--";
    ruleTake.disabled = true;
  }
  const targetPrice = decimalNumber(ruleTake.value) || 0;
  const slippage = decimalNumber(ruleSlippage.value);
  const minimumSellPrice = targetPrice > 0 && Number.isFinite(slippage) && slippage >= 0 ? targetPrice * (1 - slippage / 100) : 0;
  const profit = amount * (targetPrice - currentPrice);
  const amountText = `${amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${pair.symbol}`;
  document.querySelector("#rule-available")!.textContent = account ? `Available in MetaMask: ${display(balance, 18)} ${pair.symbol}` : "Connect wallet to load balance";
  const growthValue = document.querySelector<HTMLElement>("#growth-value")!;
  growthValue.textContent = `${growth > 0 ? "+" : ""}${displayPercent(growth)}%`;
  growthValue.classList.toggle("negative", growth < 0);
  document.querySelector("#share-value")!.textContent = `${share.toLocaleString(undefined, { maximumFractionDigits: 6 })}%`;
  if (source !== "growth-input" && source !== "target" && source !== "amount" && source !== "amount-input") growthInput.value = displayPercent(growth);
  if (!usingManualAmount) sellInput.value = amount ? String(Number(amount.toFixed(6))) : "0";
  sellInput.disabled = !account || balance <= 0n;
  document.querySelector("#sell-amount")!.textContent = amountText;
  document.querySelector("#summary-asset")!.textContent = amountText;
  document.querySelector("#summary-current-price")!.textContent = currentPrice ? `${usd(currentPrice)} USDm` : "--";
  document.querySelector("#summary-price")!.textContent = targetPrice ? `${usd(targetPrice)} USDm` : "--";
  const minimumSellPriceText = minimumSellPrice > 0 ? `${usd(minimumSellPrice)} USDm` : "--";
  summaryMinimumSellPrice.textContent = minimumSellPriceText;
  ruleMinimumSellPrice.textContent = minimumSellPriceText;
  const summaryReturn = document.querySelector<HTMLElement>("#summary-return")!;
  summaryReturn.textContent = currentPrice ? `${profit >= 0 ? "+" : ""}${usd(profit)} USDm` : "--";
  summaryReturn.classList.toggle("negative", profit < 0);
  document.querySelector("#summary-sentence")!.textContent = targetPrice ? `${amountText} at ${usd(targetPrice)} USDm` : "--";
  // These fields belong to the retired per-asset configuration cards. They
  // may still exist on older builds, but are intentionally absent from /app.
  const legacyTake = document.querySelector<HTMLInputElement>(`#${pair.symbol}-take`);
  const legacyRebalance = document.querySelector<HTMLInputElement>(`#${pair.symbol}-rebalance`);
  const legacyShare = document.querySelector<HTMLInputElement>(`#${pair.symbol}-share`);
  if (legacyTake) legacyTake.value = String(targetPrice);
  if (legacyRebalance) legacyRebalance.value = currentPrice ? String(currentPrice * 0.9) : "0";
  if (legacyShare) legacyShare.value = ruleShare.value;
  const createRule = document.querySelector<HTMLButtonElement>("#create-rule")!;
  createRule.disabled = !account || amount <= 0 || amount > number(balance, 18) || currentPrice <= 0 || targetPrice <= 0;
  createRule.textContent = "Create take-profit rule";
};
growthRange.addEventListener("input", () => updateRuleSummary("growth"));
ruleTake.addEventListener("input", () => updateRuleSummary("target"));
ruleSlippage.addEventListener("input", () => updateRuleSummary("slippage"));
ruleShare.addEventListener("input", () => updateRuleSummary("amount"));
growthInput.addEventListener("input", () => updateRuleSummary("growth-input"));
sellInput.addEventListener("input", () => updateRuleSummary("amount-input"));
[ruleTake, growthInput, sellInput].forEach((input) => input.addEventListener("blur", () => {
  const normalized = normalizeDecimal(input.value);
  if (normalized && Number.isFinite(Number(normalized))) input.value = normalized;
}));
ruleAsset.addEventListener("change", () => { sellAmountMode = "slider"; targetPriceMode = "growth"; updateRuleSummary("asset"); });
async function loadV2Policies(pair: typeof pairs[number], executor: Address, owner: Address, version: "v2" | "v3" = "v2") {
  const count = await retryRpc(() => client.readContract({ address: executor, abi: eoaExecutorV2Artifact.abi, functionName: "policyCount", args: [owner] }) as Promise<bigint>);
  await pause(125);
  const currentPrice = await retryRpc(() => client.readContract({ address: executor, abi: eoaExecutorV2Artifact.abi, functionName: "spotPriceE18" }) as Promise<bigint>);
  await pause(125);
  const [cancelledResult, completedResult] = await Promise.all([
    loadLifecycleLogs(executor, eoaExecutorV2LifecycleAbi[0], owner).then((logs) => ({ ok: true, logs }), () => ({ ok: false, logs: [] })),
    loadLifecycleLogs(executor, eoaExecutorV2LifecycleAbi[1], owner).then((logs) => ({ ok: true, logs }), () => ({ ok: false, logs: [] })),
  ]);
  const cancelled = new Set(cancelledResult.logs.map((log) => log.args.policyId?.toString()));
  const completed = new Set(completedResult.logs.map((log) => log.args.policyId?.toString()));
  const policies = [] as Array<{ pair: typeof pair; executor: Address; version: "v2" | "v3"; id: bigint; amount: bigint; target: bigint; active: boolean; state: "active" | "completed" | "cancelled"; currentPrice: bigint }>;
  for (let index = 0; index < Number(count); index += 1) {
    const id = BigInt(index + 1);
    const policy = await retryRpc(() => client.readContract({ address: executor, abi: eoaExecutorV2Artifact.abi, functionName: "policies", args: [owner, id] }) as Promise<readonly [bigint, bigint, number, boolean]>);
    // The keeper may monitor several wallet executors at once. Use the matching
    // executor/owner heartbeat rather than the legacy single `eoaRule` field,
    // otherwise a completed rule of a second wallet can be shown as Cancelled
    // when public RPC lifecycle logs are temporarily unavailable.
    const keeperCompleted = monitoredKeeperRule(version, executor, owner)
      ?.policies?.some((item) => item.policyId === id.toString() && item.completed) ?? false;
    // An inactive V2 policy can only be cancelled or executed. The keeper keeps
    // durable completed markers; otherwise classify the inactive level as cancelled
    // instead of leaving a permanent Loading state when public RPC logs are limited.
    const state = policy[3] ? "active" : keeperCompleted || completed.has(id.toString()) ? "completed" : "cancelled";
    policies.push({ pair, executor, version, id, amount: policy[0], target: policy[1], active: policy[3], state, currentPrice });
    if (index < Number(count) - 1) await pause(125);
  }
  return policies;
}

// Rule creation only needs the active reservations and the next policy id. Avoid
// lifecycle-log queries here: on a wallet with many completed levels they can
// temporarily exhaust the public Testnet RPC before MetaMask is even opened.
async function loadV2PoliciesForCreation(executor: Address, owner: Address) {
  const count = await retryRpc(() => client.readContract({ address: executor, abi: eoaExecutorV2Artifact.abi, functionName: "policyCount", args: [owner] }) as Promise<bigint>);
  const policies: Array<{ amount: bigint; active: boolean }> = [];
  for (let index = 0; index < Number(count); index += 1) {
    const id = BigInt(index + 1);
    const policy = await retryRpc(() => client.readContract({ address: executor, abi: eoaExecutorV2Artifact.abi, functionName: "policies", args: [owner, id] }) as Promise<readonly [bigint, bigint, number, boolean]>);
    policies.push({ amount: policy[0], active: policy[3] });
    if (index < Number(count) - 1) await pause(125);
  }
  return { count, policies };
}
document.querySelector<HTMLButtonElement>("#create-rule")!.addEventListener("click", async () => {
  try {
    if (!account) throw new Error("Connect MetaMask first.");
    const pair = pairs.find((item) => item.symbol === ruleAsset.value)!;
    const balance = assetBalances.get(pair.symbol) ?? 0n;
    const amount = parseUnits(normalizeDecimal(sellInput.value) || "0", 18);
    const target = parseUnits(normalizeDecimal(ruleTake.value), 18);
    const slippage = decimalNumber(ruleSlippage.value);
    if (amount <= 0n || amount > balance || target <= 0n) throw new Error("Enter a valid target price and sell amount within your MetaMask balance.");
    if (!Number.isFinite(slippage) || slippage < 0 || slippage > 50) throw new Error("Slippage must be between 0% and 50%.");
    const legacyExecutor = eoaExecutors[pair.symbol];
    if (legacyExecutor) {
      const legacyPolicy = await client.readContract({ address: legacyExecutor, abi: eoaExecutorArtifact.abi, functionName: "policies", args: [account] }) as readonly [bigint, bigint, number, boolean];
      if (legacyPolicy[3]) throw new Error(`Cancel the legacy ${pair.symbol} V1 rule once before creating V2 levels. This prevents two executors from reserving the same wallet tokens.`);
    }
    const button = document.querySelector<HTMLButtonElement>("#create-rule")!;
    button.disabled = true;
    button.textContent = "Preparing rule…";
    set("Preparing the rule and checking active reservations…");
    const executor = await deployExecutorV3(pair);
    const existing = await loadV2PoliciesForCreation(executor, account);
    const reserved = existing.policies.filter((policy) => policy.active).reduce((total, policy) => total + policy.amount, 0n);
    const aggregate = reserved + amount;
    if (aggregate > balance) throw new Error(`Active rules would reserve ${display(aggregate, 18)} ${pair.symbol}, more than your wallet balance.`);
    set(`Approve ${display(aggregate, 18)} ${pair.symbol} for all active ${pair.symbol} levels in MetaMask. Tokens stay in your wallet.`);
    await approveIfNeeded(pair.token, executor, aggregate, pair.symbol);
    const slippageBps = Math.round(slippage * 100);
    const request = { account, address: executor, abi: eoaExecutorV3Artifact.abi, functionName: "createPolicy" as const, args: [amount, target, slippageBps] as const };
    const estimate = await retryRpc(() => client.estimateContractGas(request));
    const gas = estimate + estimate / 10n;
    set("Confirm the new take-profit level in MetaMask. This stores price and amount only; it does not move tokens.");
    const hash = await wallet().writeContract({ ...request, gas });
    await wait(hash);
    const policyId = existing.count + 1n;
    // Connect the VM keeper as part of the very first rule for this token.
    // This remains a message signature (not an approval or on-chain transaction),
    // but keeps the flow in one place instead of asking the user to find a
    // secondary button in Existing Rules.
    let keeperConnected = Boolean(monitoredKeeperRule("v3", executor, account));
    if (!keeperConnected && existing.count === 0n) {
      try {
        set(`One final signature connects the ${pair.symbol} keeper. It does not move tokens or change approvals.`);
        await registerExecutorWithKeeper(executor, account);
        keeperConnected = true;
      } catch {
        // The rule is already confirmed on-chain. Keep the explicit connection
        // button as a recovery path when a user closes or rejects this signature.
        keeperConnected = false;
      }
    }
    set(keeperConnected
      ? `${pair.symbol} V3 level #${policyId} is active and connected to the keeper. It will be checked automatically within 10 seconds. Total reserved: ${display(aggregate, 18)} ${pair.symbol}.`
      : `${pair.symbol} V3 level #${policyId} is active. Confirm the keeper signature when it opens; if it was closed, use Connect ${pair.symbol} keeper in Existing Rules. Total reserved: ${display(aggregate, 18)} ${pair.symbol}.`);
    await refreshExistingRules();
  } catch (error) {
    set(isTemporaryRpcError(error)
      ? "RPC is temporarily limited. Your approval remains valid, but the rule was not created yet. Click Create take-profit rule again; no additional approval should be needed."
      : error instanceof Error ? error.shortMessage ?? error.message : "Rule creation failed.");
  } finally {
    updateRuleSummary("asset");
  }
});
updateRuleSummary();

const existingRulesBody = document.querySelector<HTMLDivElement>("#existing-rules-body")!;
document.querySelector<HTMLElement>(".existing-rules")!.insertAdjacentHTML("afterend", '<section class="surface execution-history"><div class="section-title"><div><p class="eyebrow">Confirmed on Monad Testnet</p><h3>Execution history</h3><p>Completed levels and their confirmed settlement.</p></div></div><div class="history-head"><span>Time</span><span>Rule</span><span>Sold</span><span>Avg. price</span><span>Received</span><span>Transaction</span></div><div id="execution-history-body"></div></section>');
const executionHistoryBody = document.querySelector<HTMLDivElement>("#execution-history-body")!;
function renderExecutionHistory() {
  const history = (keeperHealth?.eoaRules ?? (keeperHealth?.eoaRule ? [keeperHealth.eoaRule] : []))
    .filter((rule) => account && rule.owner.toLowerCase() === account.toLowerCase())
    .flatMap((rule) => rule.history ?? []);
  if (!history.length) { executionHistoryBody.innerHTML = '<p class="rule-empty">No confirmed executions yet.</p>'; return; }
  executionHistoryBody.innerHTML = [...history].sort((a, b) => b.executedAt.localeCompare(a.executedAt)).map((entry) => {
    const time = new Date(entry.executedAt).toLocaleString();
    const href = `https://testnet.monadvision.com/tx/${entry.hash}`;
    const averagePrice = Number(entry.amountOut) / Number(entry.amountIn);
    const symbol = entry.symbol ?? "JAMES";
    return `<div class="history-row"><span>${time}</span><span>${symbol} #${entry.policyId}</span><span>${Number(entry.amountIn).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symbol}</span><span>${averagePrice.toLocaleString(undefined, { maximumFractionDigits: 6 })} USDm</span><span class="history-received">${Number(entry.amountOut).toLocaleString(undefined, { maximumFractionDigits: 6 })} USDm</span><a href="${href}" target="_blank" rel="noreferrer">View</a></div>`;
  }).join("");
}
type RuleFilter = "all" | "active" | "cancelled" | "completed";
let ruleFilter: RuleFilter = "all";
const rulesFilterHost = document.querySelector<HTMLElement>(".existing-rules .section-title > div")!;
rulesFilterHost.insertAdjacentHTML("beforeend", `<div class="rule-tabs" role="tablist" aria-label="Rule status filter"><button class="rule-tab active" type="button" role="tab" aria-selected="true" data-rule-filter="all">All Rules</button><button class="rule-tab" type="button" role="tab" aria-selected="false" data-rule-filter="active">Active</button><button class="rule-tab" type="button" role="tab" aria-selected="false" data-rule-filter="cancelled">Cancelled</button><button class="rule-tab" type="button" role="tab" aria-selected="false" data-rule-filter="completed">Completed</button></div>`);
function applyRuleFilter() {
  existingRulesBody.querySelectorAll<HTMLElement>(".rule-row").forEach((row) => { row.hidden = ruleFilter !== "all" && row.dataset.ruleState !== ruleFilter; });
  document.querySelectorAll<HTMLButtonElement>("[data-rule-filter]").forEach((button) => {
    const active = button.dataset.ruleFilter === ruleFilter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
}
rulesFilterHost.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-rule-filter]");
  if (!button) return;
  ruleFilter = button.dataset.ruleFilter as RuleFilter;
  applyRuleFilter();
});
document.querySelector<HTMLElement>(".rule-summary small")!.textContent = "Approval covers the total of active levels. Tokens remain in MetaMask until execution.";
document.querySelector<HTMLElement>(".existing-rules .section-title p")!.textContent = "Independent take-profit levels for your connected MetaMask wallet.";
let rulesRefreshInFlight: Promise<void> | undefined;
let lastKnownRulesMarkup = "";
// A policy becomes inactive as soon as the execution transaction is submitted.
// Keep this neutral state until the keeper records its confirmed receipt.
const finalizingRuleSince = new Map<string, number>();
const finalizingWindowMs = 90_000;
async function refreshExistingRulesNow() {
  if (!account) { existingRulesBody.innerHTML = `<p class="rule-empty">Connect MetaMask to load your wallet rules.</p>`; return; }
  await refreshKeeperHealth();
  renderExecutionHistory();
  let rpcReadFailed = false;
  const legacyRules = await Promise.all(pairs.map(async (pair) => {
    const executor = eoaExecutors[pair.symbol];
    if (!executor) return undefined;
    try {
      const [policy, currentPrice] = await Promise.all([
        client.readContract({ address: executor, abi: eoaExecutorArtifact.abi, functionName: "policies", args: [account] }) as Promise<readonly [bigint, bigint, number, boolean]>,
        client.readContract({ address: executor, abi: eoaExecutorArtifact.abi, functionName: "spotPriceE18" }) as Promise<bigint>,
      ]);
      const keeperMonitored = pair.symbol === keeperDryRunRule.symbol
        && executor.toLowerCase() === keeperDryRunRule.executor.toLowerCase()
        && account!.toLowerCase() === keeperDryRunRule.owner.toLowerCase();
      return { pair, executor, amount: policy[0], target: policy[1], active: policy[3], currentPrice, keeperMonitored };
    } catch { rpcReadFailed = true; return undefined; }
  }));
  const legacyVisible = legacyRules.filter((rule): rule is NonNullable<typeof rule> => Boolean(rule && (rule.active || rule.amount > 0n || rule.target > 0n)));
  const v2Rules = (await Promise.all(pairs.map(async (pair) => {
    const executor = eoaExecutorsV2[pair.symbol];
    if (!executor) return [];
    try { return await loadV2Policies(pair, executor, account!); } catch { rpcReadFailed = true; return []; }
  }))).flat();
  const v3Rules = (await Promise.all(pairs.map(async (pair) => {
    const executor = eoaExecutorsV3[pair.symbol];
    if (!executor) return [];
    try { return await loadV2Policies(pair, executor, account!, "v3"); } catch { rpcReadFailed = true; return []; }
  }))).flat();
  portfolioActiveRules.textContent = String([...legacyVisible, ...v2Rules, ...v3Rules].filter((rule) => rule.active).length);
  const legacyRows = legacyVisible.map((rule) => {
    const targetReached = rule.currentPrice >= rule.target;
    const heartbeatMatches = Boolean(monitoredKeeperRule("v1", rule.executor, account!));
    const detail = !rule.active
      ? "Automation stopped"
      : rule.keeperMonitored && heartbeatMatches
        ? targetReached
          ? "Target reached — keeper is in dry-run"
          : `Target not reached · ${usd(number(rule.currentPrice, 18))} / ${usd(number(rule.target, 18))} USDm`
        : "Not monitored by the configured keeper";
    const label = !rule.active ? "Cancelled" : rule.keeperMonitored && heartbeatMatches ? "Keeper monitoring" : "Active";
    return `<div class="rule-row" data-rule-state="${rule.active ? "active" : "cancelled"}"><span class="asset-name"><i class="token-dot">${rule.pair.symbol.slice(0, 1)}</i><b>${rule.pair.symbol}</b></span><span>Target ${usd(number(rule.target, 18))} USDm</span><span>Sell ${display(rule.amount, 18)} ${rule.pair.symbol}</span><span class="rule-state"><span class="rule-status ${rule.active ? (rule.keeperMonitored && heartbeatMatches ? "monitoring" : "") : "legacy"}">${rule.keeperMonitored && heartbeatMatches && rule.active ? "<i></i>" : ""}${label}</span><small>Legacy V1 · ${detail}</small></span><button class="cancel-rule" type="button" data-cancel-eoa-rule="${rule.pair.symbol}" ${rule.active ? "" : "disabled"}>${rule.active ? "Cancel" : "Cancelled"}</button></div>`;
  });
  const v2Rows = [...v2Rules, ...v3Rules].sort((a, b) => a.version === b.version ? (a.id === b.id ? 0 : a.id > b.id ? -1 : 1) : a.version === "v3" ? -1 : 1).map((rule) => {
    const targetReached = rule.currentPrice >= rule.target;
    const heartbeatMatches = Boolean(monitoredKeeperRule(rule.version, rule.executor, account!));
    const keeperMode = keeperHealth?.mode === "dry-run" ? "keeper dry-run" : "keeper auto-execute armed";
    const ruleKey = `${account!.toLowerCase()}:${rule.executor.toLowerCase()}:${rule.id}`;
    const canBeFinalizing = rule.state === "cancelled" && targetReached && heartbeatMatches && keeperHealth?.mode !== "dry-run";
    if (rule.state === "active" || rule.state === "completed" || !canBeFinalizing) finalizingRuleSince.delete(ruleKey);
    // While the RPC provider is known to be rate-limited, keep pushing the
    // finalizing clock forward instead of letting it expire — a slow public
    // testnet RPC (not an actual cancellation) should never flash "Cancelled"
    // on a rule the keeper is genuinely about to confirm as completed.
    const rpcCurrentlyLimited = keeperHealth?.providerStatus === "temporarily-limited";
    if (canBeFinalizing && (!finalizingRuleSince.has(ruleKey) || rpcCurrentlyLimited)) finalizingRuleSince.set(ruleKey, Date.now());
    const finalizing = canBeFinalizing && Date.now() - (finalizingRuleSince.get(ruleKey) ?? 0) < finalizingWindowMs;
    if (rule.state === "unknown") {
      return `<div class="rule-row" data-rule-state="unknown"><span class="asset-name"><i class="token-dot">${rule.pair.symbol.slice(0, 1)}</i><b>${rule.pair.symbol} ${rule.version.toUpperCase()} #${rule.id}</b></span><span>Target ${usd(number(rule.target, 18))} USDm</span><span>Sell ${display(rule.amount, 18)} ${rule.pair.symbol}</span><span class="rule-state"><span class="rule-status legacy">Loading</span><small>Multi-rule ${rule.version.toUpperCase()} · Checking on-chain execution status</small></span><button class="cancel-rule" type="button" disabled>Loading</button></div>`;
    }
    if (finalizing) {
      return `<div class="rule-row" data-rule-state="active"><span class="asset-name"><i class="token-dot">${rule.pair.symbol.slice(0, 1)}</i><b>${rule.pair.symbol} ${rule.version.toUpperCase()} #${rule.id}</b></span><span>Target ${usd(number(rule.target, 18))} USDm</span><span>Sell ${display(rule.amount, 18)} ${rule.pair.symbol}</span><span class="rule-state"><span class="rule-status finalizing">Finalizing execution</span><small>Multi-rule ${rule.version.toUpperCase()} · Execution submitted · waiting for on-chain confirmation</small></span><button class="cancel-rule" type="button" disabled>Finalizing</button></div>`;
    }
    const rpcLimited = rule.state === "active" && keeperHealth?.providerStatus === "temporarily-limited";
    const detail = rule.state === "completed" ? "Executed by keeper" : rule.state === "cancelled" ? "Automation stopped" : rpcLimited ? "RPC temporarily limited · keeper will retry automatically" : heartbeatMatches ? targetReached ? `Target reached · ${keeperMode}` : `Target not reached · ${usd(number(rule.currentPrice, 18))} / ${usd(number(rule.target, 18))} USDm` : "Keeper setup required";
    const label = rule.state === "active" ? rpcLimited ? "RPC temporarily limited" : heartbeatMatches ? "Keeper monitoring" : "Active level" : rule.state === "completed" ? "Completed" : "Cancelled";
    const statusClass = rpcLimited ? "rpc-limited" : rule.state === "active" && heartbeatMatches ? "monitoring" : rule.state === "active" ? "" : "legacy";
    return `<div class="rule-row" data-rule-state="${rule.state}"><span class="asset-name"><i class="token-dot">${rule.pair.symbol.slice(0, 1)}</i><b>${rule.pair.symbol} ${rule.version.toUpperCase()} #${rule.id}</b></span><span>Target ${usd(number(rule.target, 18))} USDm</span><span>Sell ${display(rule.amount, 18)} ${rule.pair.symbol}</span><span class="rule-state"><span class="rule-status ${statusClass}">${rule.state === "active" && heartbeatMatches && !rpcLimited ? "<i></i>" : ""}${label}</span><small>Multi-rule ${rule.version.toUpperCase()} · ${detail}</small></span><button class="cancel-rule" type="button" data-cancel-eoa-v2-rule="${rule.pair.symbol}" data-policy-id="${rule.id}" data-rule-version="${rule.version}" ${rule.active ? "" : "disabled"}>${rule.active ? "Cancel" : label}</button></div>`;
  });
  const rows = [...v2Rows, ...legacyRows];
  if (!rows.length && rpcReadFailed && lastKnownRulesMarkup) {
    existingRulesBody.innerHTML = lastKnownRulesMarkup;
    applyRuleFilter();
    return;
  }
  existingRulesBody.innerHTML = rows.length ? rows.join("") : `<p class="rule-empty">No wallet rules yet. Create your first multi-level take-profit rule.</p>`;
  // Only offer the recovery button when the keeper health API actually
  // answered. When it's unreachable, monitoredKeeperRule() can never confirm
  // a match, which would otherwise show this button for every already-
  // registered rule just because we couldn't ask the VM.
  const unregisteredV3 = keeperHealth ? v3Rules.find((rule) => rule.active && !monitoredKeeperRule("v3", rule.executor, account!)) : undefined;
  if (unregisteredV3) {
    existingRulesBody.insertAdjacentHTML("afterbegin", `<div class="rule-empty"><button class="primary-button" type="button" data-register-eoa-v3="${unregisteredV3.pair.symbol}">Connect ${unregisteredV3.pair.symbol} keeper</button><br/><small>This one-time signature lets the VM monitor and execute this wallet's V3 rules. It does not move tokens or change approvals.</small></div>`);
  }
  if (rows.length) lastKnownRulesMarkup = existingRulesBody.innerHTML;
  applyRuleFilter();
}
function refreshExistingRules() {
  if (rulesRefreshInFlight) return rulesRefreshInFlight;
  rulesRefreshInFlight = refreshExistingRulesNow().finally(() => { rulesRefreshInFlight = undefined; });
  return rulesRefreshInFlight;
}
document.querySelector<HTMLButtonElement>("#refresh-rules")!.addEventListener("click", () => { void refreshExistingRules(); });
setInterval(() => { if (account) void refreshExistingRules(); }, 15_000);
existingRulesBody.addEventListener("click", async (event) => {
  const registerButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-register-eoa-v3]");
  if (registerButton && account) {
    try {
      const pair = pairs.find((item) => item.symbol === registerButton.dataset.registerEoaV3)!;
      const executor = eoaExecutorsV3[pair.symbol];
      if (!executor) throw new Error("This V3 executor is not available in this browser.");
      registerButton.disabled = true;
      registerButton.textContent = "Confirm in MetaMask...";
      await registerExecutorWithKeeper(executor, account);
      set(`${pair.symbol} keeper connection saved. The VM will check this wallet's active V3 rules on its next cycle.`);
      await refreshExistingRules();
    } catch (error) {
      set(error instanceof Error ? error.message : "Could not connect this executor to the keeper.");
      registerButton.disabled = false;
      registerButton.textContent = "Connect keeper";
    }
    return;
  }
  const eoaV2Button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-cancel-eoa-v2-rule]");
  if (eoaV2Button && !eoaV2Button.disabled && account) {
    const pair = pairs.find((item) => item.symbol === eoaV2Button.dataset.cancelEoaV2Rule)!;
    const executor = eoaV2Button.dataset.ruleVersion === "v3" ? eoaExecutorsV3[pair.symbol] : eoaExecutorsV2[pair.symbol];
    const policyId = BigInt(eoaV2Button.dataset.policyId ?? "0");
    if (!executor || policyId === 0n) return;
    try {
      eoaV2Button.disabled = true;
      set(`Confirm cancellation of ${pair.symbol} ${eoaV2Button.dataset.ruleVersion?.toUpperCase() ?? "V2"} level #${policyId} in MetaMask. Other levels remain active.`);
      const request = { account, address: executor, abi: eoaExecutorV2Artifact.abi, functionName: "cancelPolicy" as const, args: [policyId] as const };
      const estimate = await client.estimateContractGas(request);
      await wait(await wallet().writeContract({ ...request, gas: estimate + estimate / 10n }));
      set(`${pair.symbol} level #${policyId} cancelled. Other take-profit levels are unchanged.`);
      await refreshExistingRules();
    } catch (error) {
      set(error instanceof Error ? error.shortMessage ?? error.message : "Cancellation failed.");
      await refreshExistingRules();
    }
    return;
  }
  const eoaButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-cancel-eoa-rule]");
  if (eoaButton && !eoaButton.disabled && account) {
    const pair = pairs.find((item) => item.symbol === eoaButton.dataset.cancelEoaRule)!;
    const executor = eoaExecutors[pair.symbol];
    if (!executor) return;
    try {
      eoaButton.disabled = true;
      const request = { account, address: executor, abi: eoaExecutorArtifact.abi, functionName: "cancelPolicy" as const, args: [] as const };
      const estimate = await client.estimateContractGas(request);
      set("Confirm cancellation in MetaMask. This stops automation and leaves all tokens in your wallet.");
      await wait(await wallet().writeContract({ ...request, gas: estimate + estimate / 10n }));
      set(`${pair.symbol} rule cancelled. Your token approval can remain unused, or you can revoke it in MetaMask.`);
      await refreshExistingRules();
    } catch (error) {
      set(error instanceof Error ? error.shortMessage ?? error.message : "Cancellation failed.");
      await refreshExistingRules();
    }
    return;
  }
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-cancel-rule]");
  if (!button || button.disabled || !account) return;
  const pair = pairs.find((item) => item.symbol === button.dataset.cancelRule)!;
  try {
    button.disabled = true;
    set(`Cancel ${pair.symbol} policy in MetaMask. This stops automation; vault funds remain withdrawable by the owner.`);
    const request = { account, address: pair.vault, abi: cancellablePolicyAbi, functionName: "cancelPolicy" as const, args: [] as const };
    const gas = await client.estimateContractGas(request);
    await wait(await wallet().writeContract({ ...request, gas: gas + gas / 10n }));
    set(`${pair.symbol} policy cancelled.`);
    await refreshExistingRules();
  } catch (error) {
    set(error instanceof Error ? error.shortMessage ?? error.message : "Cancellation failed.");
    await refreshExistingRules();
  }
});

async function refreshOnchainAccountData() {
  if (!account) return;
  const assetHolder = account;
  const [monBalance, stableBalance, ...tokenData] = await Promise.all([
    client.getBalance({ address: account }),
    client.readContract({ address: usdm, abi: erc20, functionName: "balanceOf", args: [assetHolder] }) as Promise<bigint>,
    ...pairs.map(async (pair) => {
      try {
        const [balance, price] = await Promise.all([
          client.readContract({ address: pair.token, abi: erc20, functionName: "balanceOf", args: [assetHolder] }) as Promise<bigint>,
          client.readContract({ address: pair.vault, abi: vaultArtifact.abi, functionName: "spotPriceE18" }) as Promise<bigint>,
        ]);
        return { symbol: pair.symbol, balance, price };
      } catch {
        return { symbol: pair.symbol, balance: 0n, price: 0n };
      }
    }),
  ]);
  nativeBalance = monBalance;
  assetBalances.set("USDm", stableBalance);
  for (const token of tokenData) { assetBalances.set(token.symbol, token.balance); assetPrices.set(token.symbol, token.price); }
  renderAssetRows();
  renderRebalancePlan();
  renderMarketBalances();
  updatePortfolioMetrics();
  updateRuleSummary("asset");
  await refreshExistingRules();
}

// Live reads refresh wallet balances and pool quotes without overwriting a
// user's manually entered target or sell amount while a rule is configured.
let livePriceRefreshInFlight: Promise<void> | undefined;
function refreshLivePrices() {
  if (livePriceRefreshInFlight || !account) return livePriceRefreshInFlight;
  const requestedFor = account;
  livePriceRefreshInFlight = (async () => {
    try {
      const [monBalance, stableBalance, updates] = await Promise.all([
        client.getBalance({ address: requestedFor }),
        client.readContract({ address: usdm, abi: erc20, functionName: "balanceOf", args: [requestedFor] }) as Promise<bigint>,
        Promise.all(pairs.map(async (pair) => {
          const [balance, price] = await Promise.all([
            client.readContract({ address: pair.token, abi: erc20, functionName: "balanceOf", args: [requestedFor] }) as Promise<bigint>,
            client.readContract({ address: pair.vault, abi: vaultArtifact.abi, functionName: "spotPriceE18" }) as Promise<bigint>,
          ]);
          return { symbol: pair.symbol, balance, price };
        })),
      ]);
      // Do not apply a late response after the user switches MetaMask accounts.
      if (account !== requestedFor) return;
      const selectedSymbol = ruleAsset.value;
      const previousSelectedPrice = assetPrices.get(selectedSymbol);
      nativeBalance = monBalance;
      assetBalances.set("USDm", stableBalance);
      for (const update of updates) {
        assetBalances.set(update.symbol, update.balance);
        assetPrices.set(update.symbol, update.price);
      }
      renderAssetRows();
      renderRebalancePlan();
      renderMarketBalances();
      updatePortfolioMetrics();
      updateRuleSummary("asset");
      const nextSelectedPrice = assetPrices.get(selectedSymbol);
      if (previousSelectedPrice && nextSelectedPrice && previousSelectedPrice !== nextSelectedPrice) {
        flashCurrentPrice(nextSelectedPrice > previousSelectedPrice ? "up" : "down");
      }
    } catch {
      // The next scheduled refresh retries transient RPC errors without replacing good UI data.
    }
  })().finally(() => { livePriceRefreshInFlight = undefined; });
  return livePriceRefreshInFlight;
}

function wallet() {
  if (!window.ethereum || !account) throw new Error("Connect MetaMask first.");
  return createWalletClient({ account, chain, transport: custom(window.ethereum) });
}
async function wait(hash: `0x${string}`) { await retryRpc(() => client.waitForTransactionReceipt({ hash })); }
async function approveIfNeeded(token: Address, spender: Address, amount: bigint, symbol: string) {
  const allowance = await retryRpc(() => client.readContract({ address: token, abi: erc20, functionName: "allowance", args: [account!, spender] }));
  if (allowance >= amount) return;
  const connectedWallet = wallet();
  set(`Approve exactly ${symbol} in MetaMask...`);
  const approval = { account: account!, address: token, abi: erc20, functionName: "approve" as const, args: [spender, amount] };
  const gas = await retryRpc(() => client.estimateContractGas(approval));
  await wait(await connectedWallet.writeContract({ ...approval, gas: gas + gas / 10n }));
}
async function refreshPolicy(pair: typeof pairs[number]) {
  const info = document.querySelector<HTMLParagraphElement>(`#${pair.symbol}-policy`);
  const execute = document.querySelector<HTMLButtonElement>(`#${pair.symbol}-execute`);
  if (!info || !execute) return;
  try {
    const [price, takeProfit, rebalance, assetBalance, stableBalance] = await Promise.all([
      client.readContract({ address: pair.vault, abi: vaultArtifact.abi, functionName: "spotPriceE18" }),
      client.readContract({ address: pair.vault, abi: vaultArtifact.abi, functionName: "takeProfitPriceE18" }),
      client.readContract({ address: pair.vault, abi: vaultArtifact.abi, functionName: "rebalancePriceE18" }),
      client.readContract({ address: pair.token, abi: erc20, functionName: "balanceOf", args: [pair.vault] }),
      client.readContract({ address: usdm, abi: erc20, functionName: "balanceOf", args: [pair.vault] }),
    ]) as [bigint, bigint, bigint, bigint, bigint];
    let action = `Price ${display(price, 18)} USDm is inside the ${display(rebalance, 18)}-${display(takeProfit, 18)} band.`;
    let enabled = false;
    if (price >= takeProfit && assetBalance > 0n) { action = `Take profit ready: sell 25% of ${display(assetBalance, 18)} ${pair.symbol}.`; enabled = true; }
    if (price <= rebalance && stableBalance > 0n) { action = `Rebalance ready: spend 25% of ${display(stableBalance, 6)} USDm.`; enabled = true; }
    if (price >= takeProfit && assetBalance === 0n) action = "Take-profit threshold reached, but the vault has no asset balance.";
    if (price <= rebalance && stableBalance === 0n) action = "Rebalance threshold reached, but the vault has no USDm balance.";
    info.textContent = action;
    execute.disabled = !enabled || !account;
  } catch (error) { info.textContent = error instanceof Error ? error.shortMessage ?? error.message : "Unable to read policy."; execute.disabled = true; }
}
function inputs(pair: typeof pairs[number]) {
  const direction = document.querySelector<HTMLSelectElement>(`#${pair.symbol}-direction`)!.value as "buy" | "sell";
  const raw = document.querySelector<HTMLInputElement>(`#${pair.symbol}-amount`)!.value;
  const tokenIn = direction === "buy" ? usdm : pair.token;
  const decimalsIn = direction === "buy" ? 6 : 18;
  const decimalsOut = direction === "buy" ? 18 : 6;
  const symbolIn = direction === "buy" ? "USDm" : pair.symbol;
  const symbolOut = direction === "buy" ? pair.symbol : "USDm";
  return { direction, amountIn: parseUnits(raw, decimalsIn), tokenIn, decimalsOut, symbolIn, symbolOut };
}
async function quote(pair: typeof pairs[number]) {
  const quoteBox = document.querySelector<HTMLParagraphElement>(`#${pair.symbol}-quote`);
  if (!quoteBox) return;
  try {
    const data = inputs(pair);
    if (data.amountIn <= 0n) throw new Error("Amount must be greater than zero.");
    const output = await client.readContract({ address: pair.pool, abi: poolArtifact.abi, functionName: "getAmountOut", args: [data.tokenIn, data.amountIn] }) as bigint;
    const minimum = output * 9900n / 10000n;
    quoteBox.textContent = `Expected: ${display(output, data.decimalsOut)} ${data.symbolOut}. Minimum received: ${display(minimum, data.decimalsOut)} ${data.symbolOut}.`;
  } catch (error) { quoteBox.textContent = error instanceof Error ? error.shortMessage ?? error.message : "Quote unavailable."; }
}

document.querySelector<HTMLButtonElement>("#connect")!.onclick = async () => {
  const connectButton = document.querySelector<HTMLButtonElement>("#connect")!;
  if (account) { openWalletDrawer(); return; }
  connectButton.disabled = true;
  const connectLabel = connectButton.textContent;
  connectButton.textContent = "Connecting…";
  try {
    if (!window.ethereum) throw new Error("Install MetaMask.");
    if (await window.ethereum.request({ method: "eth_chainId" }) !== "0x279f") {
      try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x279f" }] }); }
      catch (error) {
        if ((error as { code?: number }).code !== 4902) throw error;
        await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0x279f", chainName: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: [rpc], blockExplorerUrls: ["https://testnet.monadvision.com"] }] });
      }
    }
    account = getAddress((await window.ethereum.request({ method: "eth_requestAccounts" }) as string[])[0]);
    set("Loading wallet balances and live prices from Monad Testnet...");
    safeAccount = undefined;
    await refreshOnchainAccountData();
    for (const pair of pairs) {
      for (const action of ["swap", "deploy", "fund", "keeper", "ownership"] as const) {
        const legacyButton = document.querySelector<HTMLButtonElement>(`#${pair.symbol}-${action}`);
        if (legacyButton) legacyButton.disabled = false;
      }
      await quote(pair);
      await refreshPolicy(pair);
    }
    const shortAccount = `${account.slice(0, 5)}...${account.slice(-4)}`;
    const connect = document.querySelector<HTMLButtonElement>("#connect")!;
    connect.classList.add("wallet-button");
    connect.innerHTML = `<span class="wallet-balance">${display(nativeBalance, 18)} MON</span><span>${shortAccount}</span><span class="wallet-avatar">${account.slice(2, 4).toUpperCase()}</span>`;
    connect.disabled = false;
    marketSwap.disabled = false;
    marketSwap.textContent = "Swap";
    await syncMarketTrade();
    await refreshDemoFaucet();
    await refreshTelegramLink();
    renderEoaAutomation();
    set("Connected. Your MetaMask balances and live prices are loaded. Deploy an executor once, then create a rule.");
  } catch (error) {
    set(error instanceof Error ? error.message : "Connection failed.");
    connectButton.disabled = false;
    connectButton.textContent = connectLabel;
  }
};

void (async () => {
  if (!window.ethereum) return;
  try {
    const authorizedAccounts = await window.ethereum.request({ method: "eth_accounts" }) as string[];
    if (authorizedAccounts.length > 0) document.querySelector<HTMLButtonElement>("#connect")!.click();
  } catch { /* The explicit Connect wallet action remains available. */ }
  window.ethereum.on?.("accountsChanged", () => window.location.reload());
  window.ethereum.on?.("chainChanged", () => window.location.reload());
})();

void refreshDemoFaucet();
void refreshTelegramLink();
setInterval(() => { if (account) void refreshTelegramLink(); }, 10_000);
setInterval(() => { if (account) void refreshLivePrices(); }, 10_000);

for (const pair of pairs) {
  const legacyAmountInput = document.querySelector<HTMLInputElement>(`#${pair.symbol}-amount`);
  const legacyDirectionInput = document.querySelector<HTMLSelectElement>(`#${pair.symbol}-direction`);
  // The legacy panel is not included in the current Portfolio route. Avoid
  // registering handlers for controls that do not exist.
  if (!legacyAmountInput || !legacyDirectionInput) continue;
  legacyAmountInput.oninput = () => { void quote(pair); };
  legacyDirectionInput.onchange = () => { void quote(pair); };
  document.querySelector<HTMLButtonElement>(`#${pair.symbol}-swap`)!.onclick = async () => {
    try {
      const changeBeforeSwap = portfolioChangePercent();
      const data = inputs(pair);
      if (data.amountIn <= 0n) throw new Error("Amount must be greater than zero.");
      const output = await client.readContract({ address: pair.pool, abi: poolArtifact.abi, functionName: "getAmountOut", args: [data.tokenIn, data.amountIn] }) as bigint;
      const minimum = output * 9900n / 10000n;
      const connectedWallet = wallet();
      const allowance = await client.readContract({ address: data.tokenIn, abi: erc20, functionName: "allowance", args: [account!, pair.pool] });
      if (allowance < data.amountIn) {
        set(`Approve exactly ${display(data.amountIn, data.direction === "buy" ? 6 : 18)} ${data.symbolIn} in MetaMask...`);
        const approval = { account: account!, address: data.tokenIn, abi: erc20, functionName: "approve" as const, args: [pair.pool, data.amountIn] };
        const approvalGas = await client.estimateContractGas(approval);
        await wait(await connectedWallet.writeContract({ ...approval, gas: approvalGas + approvalGas / 10n }));
      }
      set(`Swap ${data.symbolIn} for ${data.symbolOut} in MetaMask...`);
      const swap = { account: account!, address: pair.pool, abi: poolArtifact.abi, functionName: "swap" as const, args: [data.tokenIn, data.amountIn, minimum, account!] };
      const swapGas = await client.estimateContractGas(swap);
      await wait(await connectedWallet.writeContract({ ...swap, gas: swapGas + swapGas / 10n }));
      await refreshOnchainAccountData();
      preservePortfolioChangeAfterOwnSwap(changeBeforeSwap);
      updatePortfolioMetrics();
      set(`${pair.symbol} price moved. Quote refreshed.`);
      await quote(pair);
      await syncMarketTrade();
    } catch (error) { set(error instanceof Error ? error.shortMessage ?? error.message : "Cancelled or failed."); }
  };

  document.querySelector<HTMLButtonElement>(`#${pair.symbol}-deploy`)!.onclick = async () => {
    try {
      const takeProfit = parseUnits(document.querySelector<HTMLInputElement>(`#${pair.symbol}-take`)!.value, 18);
      const rebalance = parseUnits(document.querySelector<HTMLInputElement>(`#${pair.symbol}-rebalance`)!.value, 18);
      const tradeBps = BigInt(Math.round(Number(document.querySelector<HTMLInputElement>(`#${pair.symbol}-share`)!.value) * 100));
      const slippageBps = BigInt(Math.round(Number(document.querySelector<HTMLInputElement>(`#${pair.symbol}-slippage`)!.value) * 100));
      if (takeProfit <= rebalance || rebalance <= 0n || tradeBps <= 0n || tradeBps > 10_000n || slippageBps > 1_000n) throw new Error("Use upper price > lower price, trade share 1-100%, and slippage 0-10%.");
      const connectedWallet = wallet();
      const deployment = { account: account!, abi: vaultArtifact.abi, bytecode: vaultArtifact.bytecode as `0x${string}`, args: [pair.token, usdm, pair.pool, account!, account!, takeProfit, rebalance, Number(tradeBps), Number(slippageBps)] };
      set(`MetaMask will deploy ${pair.symbol} PolicyVault. Review the parameters and gas limit.`);
      const deploymentData = encodeDeployData({ abi: deployment.abi, bytecode: deployment.bytecode, args: deployment.args });
      const gas = await client.estimateGas({ account: account!, data: deploymentData });
      const hash = await connectedWallet.deployContract({ ...deployment, gas: gas + gas / 10n });
      set(`${pair.symbol} PolicyVault sent: ${hash}. Waiting for confirmation...`);
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (!receipt.contractAddress) throw new Error("Deployment confirmed without a contract address.");
      pair.vault = getAddress(receipt.contractAddress);
      const savedVaults = JSON.parse(localStorage.getItem("take-profit-vaults") ?? "{}") as Record<string, string>;
      savedVaults[pair.symbol] = pair.vault;
      localStorage.setItem("take-profit-vaults", JSON.stringify(savedVaults));
      await refreshOnchainAccountData();
      set(`${pair.symbol} cancellable PolicyVault deployed at ${pair.vault}. Fund the new vault before it can execute.`);
    } catch (error) { set(error instanceof Error ? error.shortMessage ?? error.message : "Cancelled or failed."); }
  };

  document.querySelector<HTMLButtonElement>(`#${pair.symbol}-fund`)!.onclick = async () => {
    try {
      const assetAmount = parseUnits(document.querySelector<HTMLInputElement>(`#${pair.symbol}-fund-asset`)!.value, 18);
      const stableAmount = parseUnits(document.querySelector<HTMLInputElement>(`#${pair.symbol}-fund-usdm`)!.value, 6);
      if (assetAmount <= 0n && stableAmount <= 0n) throw new Error("Enter a positive token or USDm amount.");
      if (assetAmount > 0n) await approveIfNeeded(pair.token, pair.vault, assetAmount, `${display(assetAmount, 18)} ${pair.symbol}`);
      if (stableAmount > 0n) await approveIfNeeded(usdm, pair.vault, stableAmount, `${display(stableAmount, 6)} USDm`);
      set(`Fund ${pair.symbol} PolicyVault in MetaMask...`);
      const connectedWallet = wallet();
      const funding = { account: account!, address: pair.vault, abi: vaultArtifact.abi, functionName: "fund" as const, args: [assetAmount, stableAmount] };
      const gas = await client.estimateContractGas(funding);
      await wait(await connectedWallet.writeContract({ ...funding, gas: gas + gas / 10n }));
      set(`${pair.symbol} PolicyVault funded. Send the funding transaction link to verify balances.`);
    } catch (error) { set(error instanceof Error ? error.shortMessage ?? error.message : "Cancelled or failed."); }
  };

  document.querySelector<HTMLButtonElement>(`#${pair.symbol}-refresh`)!.onclick = () => { void refreshPolicy(pair); };
  document.querySelector<HTMLButtonElement>(`#${pair.symbol}-execute`)!.onclick = async () => {
    try {
      await refreshPolicy(pair);
      const execute = document.querySelector<HTMLButtonElement>(`#${pair.symbol}-execute`)!;
      if (execute.disabled) throw new Error("Policy is not currently actionable.");
      set(`Execute ${pair.symbol} policy in MetaMask...`);
      const connectedWallet = wallet();
      const request = { account: account!, address: pair.vault, abi: vaultArtifact.abi, functionName: "executePolicy" as const, args: [] as const };
      const gas = await client.estimateContractGas(request);
      await wait(await connectedWallet.writeContract({ ...request, gas: gas + gas / 10n }));
      set(`${pair.symbol} policy executed. Refreshing state.`);
      await refreshPolicy(pair);
    } catch (error) { set(error instanceof Error ? error.shortMessage ?? error.message : "Cancelled or failed."); }
  };

  document.querySelector<HTMLButtonElement>(`#${pair.symbol}-keeper`)!.onclick = async () => {
    try {
      const keeper = getAddress(document.querySelector<HTMLInputElement>("#keeper-address")!.value);
      set(`Assign ${keeper} as ${pair.symbol} keeper in MetaMask...`);
      const connectedWallet = wallet();
      const request = { account: account!, address: pair.vault, abi: vaultArtifact.abi, functionName: "setKeeper" as const, args: [keeper] };
      const gas = await client.estimateContractGas(request);
      await wait(await connectedWallet.writeContract({ ...request, gas: gas + gas / 10n }));
      set(`${pair.symbol} keeper assigned. Send the transaction link to verify it.`);
    } catch (error) { set(error instanceof Error ? error.shortMessage ?? error.message : "Cancelled or failed."); }
  };

  document.querySelector<HTMLButtonElement>(`#${pair.symbol}-ownership`)!.onclick = async () => {
    try {
      if (!safeAccount) throw new Error("Select a Safe before migrating a legacy vault.");
      set(`Transfer ${pair.symbol} legacy vault ownership to the selected Safe in MetaMask.`);
      const connectedWallet = wallet();
      const request = { account: account!, address: pair.vault, abi: vaultArtifact.abi, functionName: "transferOwnership" as const, args: [safeAccount] };
      const gas = await client.estimateContractGas(request);
      await wait(await connectedWallet.writeContract({ ...request, gas: gas + gas / 10n }));
      set(`${pair.symbol} ownership transferred to Safe. Send the transaction link to verify it.`);
    } catch (error) { set(error instanceof Error ? error.shortMessage ?? error.message : "Cancelled or failed."); }
  };
}
