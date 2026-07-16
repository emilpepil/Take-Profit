import { createPublicClient, createWalletClient, custom, defineChain, encodeDeployData, formatUnits, getAddress, http, parseUnits, type Address } from "viem";
import poolArtifact from "./generated/SimplePool.json";
import vaultArtifact from "./generated/PolicyVault.json";
import "./style.css";

declare global { interface Window { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } } }

const rpc = "https://testnet-rpc.monad.xyz";
const chain = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const client = createPublicClient({ chain, transport: http(rpc) });
let account: Address | undefined;
const usdm = getAddress("0x0f1471d41e25e7880a3c3021dfcb5efb29079f71");
const pairs = [
  { symbol: "JAMES", token: getAddress("0x8f32e211244706c9b0902a9bd823e1c768a032c2"), pool: getAddress("0x6ba5e36975ce93778543a512f2c99679daadaf04"), vault: getAddress("0x88760064022811c60771fd5fb574895361189a2d") },
  { symbol: "EMO", token: getAddress("0x3d07c291cc9a7eaa11fa2f2bd2894643c0923e6c"), pool: getAddress("0x127428881a30bc257b9a0b2bd57ab11a3bbad0e7"), vault: getAddress("0x59f70bfabce71c8463ee97295e5af60ae4d05492") },
  { symbol: "CHOG", token: getAddress("0x6bf60cc379ad2c76ebf4c1d4f0ef528427483313"), pool: getAddress("0xf5d0a5d5458a095f4a7065e999837dfe34ef2e92"), vault: getAddress("0xe7f348cf2cfb94428784e6480f046df86fe826f1") },
];
const erc20 = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const set = (value: string) => { status.textContent = value; };
const display = (amount: bigint, decimals: number) => Number(formatUnits(amount, decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 });

document.querySelector<HTMLDivElement>("#swaps")!.innerHTML = pairs.map((pair) => `<section><h2>${pair.symbol}/USDm</h2><label>Direction <select id="${pair.symbol}-direction"><option value="buy">Buy ${pair.symbol} with USDm (price up)</option><option value="sell">Sell ${pair.symbol} for USDm (price down)</option></select></label><label>Amount in <input id="${pair.symbol}-amount" value="10000" inputmode="decimal"/></label><p id="${pair.symbol}-quote">Enter an amount to calculate the quote.</p><button id="${pair.symbol}-swap" disabled>Swap</button></section>`).join("");
document.querySelector<HTMLDivElement>("#vaults")!.innerHTML = pairs.map((pair) => `<section><h2>${pair.symbol} PolicyVault</h2><label>Take-profit price (USDm) <input id="${pair.symbol}-take" value="14" inputmode="decimal"/></label><label>Rebalance price (USDm) <input id="${pair.symbol}-rebalance" value="10" inputmode="decimal"/></label><label>Trade share (%) <input id="${pair.symbol}-share" value="25" inputmode="numeric"/></label><label>Max slippage (%) <input id="${pair.symbol}-slippage" value="1" inputmode="decimal"/></label><button id="${pair.symbol}-deploy" disabled>Deploy ${pair.symbol} PolicyVault</button></section>`).join("");
document.querySelector<HTMLDivElement>("#funding")!.innerHTML = pairs.map((pair) => `<section><h2>Fund ${pair.symbol} vault</h2><label>${pair.symbol} <input id="${pair.symbol}-fund-asset" value="1000" inputmode="decimal"/></label><label>USDm <input id="${pair.symbol}-fund-usdm" value="10000" inputmode="decimal"/></label><button id="${pair.symbol}-fund" disabled>Approve and fund vault</button></section>`).join("");
document.querySelector<HTMLDivElement>("#execution")!.innerHTML = pairs.map((pair) => `<section><h2>${pair.symbol} policy status</h2><p id="${pair.symbol}-policy">Connect MetaMask to read the policy.</p><button id="${pair.symbol}-refresh">Refresh policy</button><button id="${pair.symbol}-execute" disabled>Execute policy</button></section>`).join("");

function wallet() {
  if (!window.ethereum || !account) throw new Error("Connect MetaMask first.");
  return createWalletClient({ account, chain, transport: custom(window.ethereum) });
}
async function wait(hash: `0x${string}`) { await client.waitForTransactionReceipt({ hash }); }
async function approveIfNeeded(token: Address, spender: Address, amount: bigint, symbol: string) {
  const allowance = await client.readContract({ address: token, abi: erc20, functionName: "allowance", args: [account!, spender] });
  if (allowance >= amount) return;
  const connectedWallet = wallet();
  set(`Approve exactly ${symbol} in MetaMask...`);
  const approval = { account: account!, address: token, abi: erc20, functionName: "approve" as const, args: [spender, amount] };
  const gas = await client.estimateContractGas(approval);
  await wait(await connectedWallet.writeContract({ ...approval, gas: gas + gas / 10n }));
}
async function refreshPolicy(pair: typeof pairs[number]) {
  const info = document.querySelector<HTMLParagraphElement>(`#${pair.symbol}-policy`)!;
  const execute = document.querySelector<HTMLButtonElement>(`#${pair.symbol}-execute`)!;
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
    for (const pair of pairs) { document.querySelector<HTMLButtonElement>(`#${pair.symbol}-swap`)!.disabled = false; document.querySelector<HTMLButtonElement>(`#${pair.symbol}-deploy`)!.disabled = false; document.querySelector<HTMLButtonElement>(`#${pair.symbol}-fund`)!.disabled = false; await quote(pair); await refreshPolicy(pair); }
    set("Connected. You can swap or configure a PolicyVault.");
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
      set(`${pair.symbol} PolicyVault deployed at ${receipt.contractAddress}. Send this transaction link to verify it.`);
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
}
