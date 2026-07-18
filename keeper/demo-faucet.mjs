import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createPublicClient, defineChain, encodeFunctionData, getAddress, http, isAddress, parseUnits, recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const chain = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } } });
const transferAbi = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }];
const fourHours = 4 * 60 * 60 * 1_000;

const faucetAssets = [
  { symbol: "USDm", address: "0x0f1471d41e25e7880a3c3021dfcb5efb29079f71", decimals: 6, amount: "10000" },
  { symbol: "JAMES", address: "0x8f32e211244706c9b0902a9bd823e1c768a032c2", decimals: 18, amount: "100" },
  { symbol: "EMO", address: "0x3d07c291cc9a7eaa11fa2f2bd2894643c0923e6c", decimals: 18, amount: "100" },
  { symbol: "CHOG", address: "0x6bf60cc379ad2c76ebf4c1d4f0ef528427483313", decimals: 18, amount: "100" },
].map((asset) => ({ ...asset, address: getAddress(asset.address) }));

const statePath = process.env.DEMO_FAUCET_STATE_PATH ?? "keeper/demo-faucet-state.json";
const enabled = process.env.DEMO_FAUCET_ENABLED === "true";
const rpcUrl = process.env.MONAD_TESTNET_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const locks = new Set();
const expectedFaucetAddress = getAddress("0xA6Cd5434bDAd0960a21EdD9b666dAc55687B70A9");
// A plain ERC-20 transfer has a predictable upper bound for these four demo
// tokens. Monad charges the declared gas limit, so avoid unsupported RPC
// estimation and keep the faucet's limit deliberately tight.
const erc20TransferGasLimit = 120_000n;

function configuredFaucetAddress() {
  try {
    const privateKey = process.env.DEMO_FAUCET_PRIVATE_KEY;
    return privateKey ? privateKeyToAccount(privateKey).address : null;
  } catch {
    return null;
  }
}

function emptyState() { return { claims: {} }; }
async function readState() {
  try { return JSON.parse(await readFile(statePath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return emptyState(); throw error; }
}
async function saveState(state) {
  await mkdir(dirname(statePath), { recursive: true });
  const temp = `${statePath}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temp, statePath);
}
function parseSignedCommand(message) {
  const start = message.indexOf("\n{");
  return JSON.parse(start === -1 ? message : message.slice(start + 1));
}
function publicStatus(address, claim) {
  const nextClaimAt = claim?.nextClaimAt ?? null;
  const faucetAddress = configuredFaucetAddress();
  const configured = faucetAddress?.toLowerCase() === expectedFaucetAddress.toLowerCase();
  return { enabled, configured, faucetAddress, address, nextClaimAt, available: configured && (claim?.status === "pending" || !nextClaimAt || Date.now() >= Date.parse(nextClaimAt)), bundle: faucetAssets.map(({ symbol, amount }) => ({ symbol, amount })) };
}

export function demoFaucetAllowedOrigins() {
  return new Set(["http://127.0.0.1:5173", "http://localhost:5173", ...(process.env.DEMO_FAUCET_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean)]);
}

export async function demoFaucetStatus(addressText) {
  if (!isAddress(addressText ?? "")) throw new Error("A valid wallet address is required.");
  const address = getAddress(addressText);
  const state = await readState();
  return publicStatus(address, state.claims[address.toLowerCase()]);
}

export async function claimDemoFaucet({ message, signature }) {
  if (!enabled) throw new Error("Demo Faucet is not funded yet. Get Testnet MON from Monad Faucet and try again later.");
  const command = parseSignedCommand(message);
  if (command.action !== "take-profit-demo-faucet-claim" || command.chainId !== 10143) throw new Error("Unexpected faucet request.");
  if (!isAddress(command.address ?? "")) throw new Error("Invalid wallet address.");
  if (!Number.isInteger(command.issuedAt) || Math.abs(Date.now() - command.issuedAt) > 5 * 60_000) throw new Error("Faucet signature expired. Please try again.");
  const address = getAddress(command.address);
  const signer = await recoverMessageAddress({ message, signature });
  if (signer.toLowerCase() !== address.toLowerCase()) throw new Error("The signature must belong to the receiving wallet.");
  const key = address.toLowerCase();
  if (locks.has(key)) throw new Error("A faucet claim for this wallet is already in progress.");
  locks.add(key);
  try {
    const state = await readState();
    const existing = state.claims[key];
    if (existing?.nextClaimAt && Date.now() < Date.parse(existing.nextClaimAt) && existing.status !== "pending") return { ...publicStatus(address, existing), status: "cooldown" };
    const faucetAddress = configuredFaucetAddress();
    if (!faucetAddress) throw new Error("Demo Faucet wallet key is missing or invalid on the server.");
    if (faucetAddress.toLowerCase() !== expectedFaucetAddress.toLowerCase()) throw new Error("Demo Faucet is configured with a different wallet. Contact the demo administrator.");
    const faucetAccount = privateKeyToAccount(process.env.DEMO_FAUCET_PRIVATE_KEY);
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const claim = existing?.status === "pending" ? existing : { status: "pending", startedAt: new Date().toISOString(), nextClaimAt: new Date(Date.now() + fourHours).toISOString(), transfers: {} };
    state.claims[key] = claim;
    await saveState(state);
    for (const asset of faucetAssets) {
      if (claim.transfers[asset.symbol]?.hash) continue;
      const amount = parseUnits(asset.amount, asset.decimals);
      // This public Monad Testnet RPC accepts raw signed transactions but not
      // wallet_sendTransaction. Sign locally with the dedicated faucet key.
      const nonce = await publicClient.getTransactionCount({ address: faucetAccount.address, blockTag: "pending" });
      const gasPrice = await publicClient.getGasPrice();
      const data = encodeFunctionData({ address: asset.address, abi: transferAbi, functionName: "transfer", args: [address, amount] });
      const serializedTransaction = await faucetAccount.signTransaction({ chainId: chain.id, nonce, to: asset.address, data, gas: erc20TransferGasLimit, gasPrice });
      const hash = await publicClient.sendRawTransaction({ serializedTransaction });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${asset.symbol} transfer reverted: ${hash}`);
      claim.transfers[asset.symbol] = { hash, sentAt: new Date().toISOString() };
      await saveState(state);
    }
    claim.status = "claimed";
    claim.claimedAt = new Date().toISOString();
    await saveState(state);
    return { ...publicStatus(address, claim), status: "claimed", transfers: claim.transfers };
  } finally { locks.delete(key); }
}
