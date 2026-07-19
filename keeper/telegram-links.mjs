import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { getAddress, recoverMessageAddress } from "viem";

const chainId = 10143;
const statePath = process.env.TELEGRAM_LINKS_PATH ?? "keeper/telegram-links.json";
const botUsername = process.env.TELEGRAM_BOT_USERNAME ?? "Auto_Take_Profit_Bot";
const signatureLifetimeMs = 5 * 60_000;
const linkLifetimeMs = 10 * 60_000;

async function loadState() {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    return { pending: {}, links: {}, ...state };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return { pending: {}, links: {} };
    throw error;
  }
}

async function saveState(state) {
  await mkdir(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporaryPath, statePath);
}

function commandFromMessage(message) {
  if (typeof message !== "string") throw new Error("A signed Telegram-link message is required.");
  const jsonStart = message.indexOf("\n{");
  return JSON.parse(jsonStart === -1 ? message : message.slice(jsonStart + 1));
}

function discardExpiredPending(state) {
  const now = Date.now();
  for (const [code, pending] of Object.entries(state.pending ?? {})) {
    if (!pending || Date.parse(pending.expiresAt) <= now) delete state.pending[code];
  }
}

export async function createTelegramLink({ message, signature }) {
  const command = commandFromMessage(message);
  if (command.action !== "take-profit-telegram-link" || command.chainId !== chainId) throw new Error("Unexpected Telegram-link command.");
  if (!Number.isInteger(command.issuedAt) || Math.abs(Date.now() - command.issuedAt) > signatureLifetimeMs) {
    throw new Error("Telegram-link signature expired. Please try again.");
  }
  const address = getAddress(command.address);
  const signer = await recoverMessageAddress({ message, signature });
  if (signer.toLowerCase() !== address.toLowerCase()) throw new Error("Signature must belong to the connected wallet.");

  const state = await loadState();
  discardExpiredPending(state);
  const code = `tp_${randomBytes(8).toString("hex")}`;
  const expiresAt = new Date(Date.now() + linkLifetimeMs).toISOString();
  state.pending[code] = { address, expiresAt, createdAt: new Date().toISOString() };
  await saveState(state);
  return { code, expiresAt, botUrl: `https://t.me/${botUsername}?start=${code}` };
}

export async function unlinkTelegram({ message, signature }) {
  const command = commandFromMessage(message);
  if (command.action !== "take-profit-telegram-unlink" || command.chainId !== chainId) throw new Error("Unexpected Telegram-unlink command.");
  if (!Number.isInteger(command.issuedAt) || Math.abs(Date.now() - command.issuedAt) > signatureLifetimeMs) {
    throw new Error("Telegram-unlink signature expired. Please try again.");
  }
  const address = getAddress(command.address);
  const signer = await recoverMessageAddress({ message, signature });
  if (signer.toLowerCase() !== address.toLowerCase()) throw new Error("Signature must belong to the connected wallet.");

  const state = await loadState();
  const walletKey = address.toLowerCase();
  const existing = state.links?.[walletKey];
  if (existing) {
    delete state.links[walletKey];
    await saveState(state);
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (token) {
      try { await sendTelegramMessage(token, existing.chatId, "This wallet has been disconnected from Take Profit notifications. Reconnect anytime from the app."); } catch { /* best-effort notice only */ }
    }
  }
  return { unlinked: Boolean(existing) };
}

export async function telegramLinkStatus(address) {
  const state = await loadState();
  discardExpiredPending(state);
  const normalized = getAddress(address).toLowerCase();
  const link = state.links?.[normalized];
  return { linked: Boolean(link), linkedAt: link?.linkedAt ?? null };
}

async function sendTelegramMessage(token, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!response.ok) throw new Error(`Telegram message failed (HTTP ${response.status}).`);
}

let pollInProgress = false;
export async function pollTelegramLinkUpdates() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || pollInProgress) return;
  pollInProgress = true;
  try {
    const state = await loadState();
    discardExpiredPending(state);
    const query = new URLSearchParams({ timeout: "0" });
    if (Number.isInteger(state.telegramOffset)) query.set("offset", String(state.telegramOffset));
    const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates?${query}`);
    if (!response.ok) throw new Error(`Telegram update polling failed (HTTP ${response.status}).`);
    const payload = await response.json();
    for (const update of payload.result ?? []) {
      state.telegramOffset = Number(update.update_id) + 1;
      const message = update.message;
      const text = message?.text;
      const match = typeof text === "string" ? text.match(/^\/start(?:@\w+)?\s+(tp_[a-f0-9]{16})\s*$/i) : null;
      if (!match) continue;
      const pending = state.pending?.[match[1]];
      if (!pending || Date.parse(pending.expiresAt) <= Date.now()) {
        await sendTelegramMessage(token, message.chat.id, "This Take Profit link code has expired. Return to the app and create a new one.");
        continue;
      }
      const walletKey = getAddress(pending.address).toLowerCase();
      state.links[walletKey] = { chatId: String(message.chat.id), linkedAt: new Date().toISOString() };
      delete state.pending[match[1]];
      await sendTelegramMessage(token, message.chat.id, `Take Profit connected to ${pending.address.slice(0, 6)}…${pending.address.slice(-4)}. Execution notifications will be sent here.`);
    }
    await saveState(state);
  } finally {
    pollInProgress = false;
  }
}

export async function telegramChatIdForWallet(address) {
  const state = await loadState();
  return state.links?.[getAddress(address).toLowerCase()]?.chatId;
}
