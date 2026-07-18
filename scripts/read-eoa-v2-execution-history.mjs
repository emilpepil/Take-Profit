import { createPublicClient, decodeEventLog, defineChain, formatUnits, http } from "viem";

const hashes = process.argv.slice(2);
if (!hashes.length) throw new Error("Pass one or more transaction hashes.");

const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
});
const executionEvent = [{
  type: "event",
  name: "PolicyExecuted",
  anonymous: false,
  inputs: [
    { indexed: true, name: "owner", type: "address" },
    { indexed: true, name: "policyId", type: "uint256" },
    { indexed: false, name: "spotPriceE18", type: "uint256" },
    { indexed: false, name: "amountIn", type: "uint256" },
    { indexed: false, name: "amountOut", type: "uint256" },
  ],
}];
const executor = "0xb8467CAc60cE9087407942c7812820351436bAea";
const client = createPublicClient({ chain: monadTestnet, transport: http() });

const records = [];
for (const hash of hashes) {
  const receipt = await client.getTransactionReceipt({ hash });
  const event = receipt.logs.map((log) => {
    if (log.address.toLowerCase() !== executor.toLowerCase()) return undefined;
    try { return decodeEventLog({ abi: executionEvent, eventName: "PolicyExecuted", data: log.data, topics: log.topics }); } catch { return undefined; }
  }).find(Boolean);
  if (!event) throw new Error(`PolicyExecuted not found in ${hash}.`);
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  records.push({
    executor,
    owner: event.args.owner,
    policyId: event.args.policyId.toString(),
    amountIn: formatUnits(event.args.amountIn, 18),
    amountOut: formatUnits(event.args.amountOut, 6),
    priceUsd: formatUnits(event.args.spotPriceE18, 18),
    hash,
    executedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
  });
}
console.log(JSON.stringify(records, null, 2));
