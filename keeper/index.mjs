import { readFile } from "node:fs/promises";
import { createPublicClient, defineChain, formatUnits, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const MONAD_TESTNET_CHAIN_ID = 10143;
const EXPECTED_KEEPER = "0xD88394629BbE7Be91B1eFE6E984e7aCb118edd8B";
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

const env = readEnv(await readFile(".env", "utf8"));
if (!env.MONAD_TESTNET_RPC_URL || !env.KEEPER_PRIVATE_KEY) throw new Error("Set MONAD_TESTNET_RPC_URL and KEEPER_PRIVATE_KEY in .env.");

const account = privateKeyToAccount(env.KEEPER_PRIVATE_KEY);
if (account.address.toLowerCase() !== EXPECTED_KEEPER.toLowerCase()) throw new Error("KEEPER_PRIVATE_KEY does not match the assigned test keeper.");

const chain = defineChain({ id: MONAD_TESTNET_CHAIN_ID, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [env.MONAD_TESTNET_RPC_URL] } } });
const client = createPublicClient({ chain, transport: http(env.MONAD_TESTNET_RPC_URL) });
if (await client.getChainId() !== MONAD_TESTNET_CHAIN_ID) throw new Error("Refusing to run outside Monad Testnet (chain ID 10143).");

const report = [];
for (const vault of vaults) {
  const [keeper, price, takeProfit, rebalance, tradeBps, assetBalance, stableBalance] = await Promise.all([
    client.readContract({ address: vault.vault, abi: vaultAbi, functionName: "keeper" }),
    client.readContract({ address: vault.vault, abi: vaultAbi, functionName: "spotPriceE18" }),
    client.readContract({ address: vault.vault, abi: vaultAbi, functionName: "takeProfitPriceE18" }),
    client.readContract({ address: vault.vault, abi: vaultAbi, functionName: "rebalancePriceE18" }),
    client.readContract({ address: vault.vault, abi: vaultAbi, functionName: "tradeBps" }),
    client.readContract({ address: vault.asset, abi: erc20Abi, functionName: "balanceOf", args: [vault.vault] }),
    client.readContract({ address: usdm, abi: erc20Abi, functionName: "balanceOf", args: [vault.vault] }),
  ]);
  report.push({ symbol: vault.symbol, keeperMatches: keeper.toLowerCase() === account.address.toLowerCase(), priceUsd: formatUnits(price, 18), action: actionFor({ price, takeProfit, rebalance, assetBalance, stableBalance, tradeBps }), dryRun: true });
}

console.table(report);
console.log("Dry-run complete: no transaction was created or signed.");
