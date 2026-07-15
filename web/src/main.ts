import { createPublicClient, createWalletClient, custom, defineChain, formatUnits, getAddress, http, parseEther, parseUnits, type Address } from "viem";
import poolArtifact from "./generated/SimplePool.json";
import "./style.css";

declare global { interface Window { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } } }

const rpc = "https://testnet-rpc.monad.xyz";
const chain = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const client = createPublicClient({ chain, transport: http(rpc) });
let account: Address | undefined;
const usdm = getAddress("0x0f1471d41e25e7880a3c3021dfcb5efb29079f71");
const pairs = [
  { symbol: "JAMES", token: getAddress("0x8f32e211244706c9b0902a9bd823e1c768a032c2"), pool: getAddress("0x6ba5e36975ce93778543a512f2c99679daadaf04") },
  { symbol: "EMO", token: getAddress("0x3d07c291cc9a7eaa11fa2f2bd2894643c0923e6c"), pool: getAddress("0x127428881a30bc257b9a0b2bd57ab11a3bbad0e7") },
  { symbol: "CHOG", token: getAddress("0x6bf60cc379ad2c76ebf4c1d4f0ef528427483313"), pool: getAddress("0xf5d0a5d5458a095f4a7065e999837dfe34ef2e92") },
];
const erc20 = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const set = (value: string) => { status.textContent = value; };
const display = (amount: bigint, decimals: number) => Number(formatUnits(amount, decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 });

document.querySelector<HTMLDivElement>("#swaps")!.innerHTML = pairs.map((pair) => `<section><h2>${pair.symbol}/USDm</h2><label>Direction <select id="${pair.symbol}-direction"><option value="buy">Buy ${pair.symbol} with USDm (price up)</option><option value="sell">Sell ${pair.symbol} for USDm (price down)</option></select></label><label>Amount in <input id="${pair.symbol}-amount" value="10000" inputmode="decimal"/></label><p id="${pair.symbol}-quote">Enter an amount to calculate the quote.</p><button id="${pair.symbol}-swap" disabled>Swap</button></section>`).join("");

function wallet() {
  if (!window.ethereum || !account) throw new Error("Connect MetaMask first.");
  return createWalletClient({ account, chain, transport: custom(window.ethereum) });
}
async function wait(hash: `0x${string}`) { await client.waitForTransactionReceipt({ hash }); }
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
  const quoteBox = document.querySelector<HTMLParagraphElement>(`#${pair.symbol}-quote`)!;
  try {
    const data = inputs(pair);
    if (data.amountIn <= 0n) throw new Error("Amount must be greater than zero.");
    const output = await client.readContract({ address: pair.pool, abi: poolArtifact.abi, functionName: "getAmountOut", args: [data.tokenIn, data.amountIn] }) as bigint;
    const minimum = output * 9900n / 10000n;
    quoteBox.textContent = `Expected: ${display(output, data.decimalsOut)} ${data.symbolOut}. Minimum received: ${display(minimum, data.decimalsOut)} ${data.symbolOut}.`;
  } catch (error) { quoteBox.textContent = error instanceof Error ? error.shortMessage ?? error.message : "Quote unavailable."; }
}

document.querySelector<HTMLButtonElement>("#connect")!.onclick = async () => {
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
    for (const pair of pairs) { document.querySelector<HTMLButtonElement>(`#${pair.symbol}-swap`)!.disabled = false; await quote(pair); }
    set("Connected. Choose a swap direction and amount.");
  } catch (error) { set(error instanceof Error ? error.message : "Connection failed."); }
};

for (const pair of pairs) {
  document.querySelector<HTMLInputElement>(`#${pair.symbol}-amount`)!.oninput = () => { void quote(pair); };
  document.querySelector<HTMLSelectElement>(`#${pair.symbol}-direction`)!.onchange = () => { void quote(pair); };
  document.querySelector<HTMLButtonElement>(`#${pair.symbol}-swap`)!.onclick = async () => {
    try {
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
      set(`${pair.symbol} price moved. Quote refreshed.`);
      await quote(pair);
    } catch (error) { set(error instanceof Error ? error.shortMessage ?? error.message : "Cancelled or failed."); }
  };
}
