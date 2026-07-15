import { createPublicClient, createWalletClient, custom, defineChain, getAddress, http, parseEther, parseUnits, type Address } from "viem";
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
const erc20 = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const set = (value: string) => { status.textContent = value; };

document.querySelector<HTMLDivElement>("#pools")!.innerHTML = pairs.map((pair) => `<section><h2>${pair.symbol}/USDm</h2><label>${pair.symbol} <input id="${pair.symbol}-asset" value="10000"/></label><label>USDm <input id="${pair.symbol}-usdm" value="100000"/></label><button id="${pair.symbol}" disabled>Approve and add liquidity</button></section>`).join("");

function wallet() {
  if (!window.ethereum || !account) throw new Error("Connect MetaMask first.");
  return createWalletClient({ account, chain, transport: custom(window.ethereum) });
}

async function wait(hash: `0x${string}`) { await client.waitForTransactionReceipt({ hash }); }

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
    for (const pair of pairs) document.querySelector<HTMLButtonElement>(`#${pair.symbol}`)!.disabled = false;
    set("Connected. Choose a pool to seed.");
  } catch (error) { set(error instanceof Error ? error.message : "Connection failed."); }
};

for (const pair of pairs) document.querySelector<HTMLButtonElement>(`#${pair.symbol}`)!.onclick = async () => {
  try {
    const asset = parseEther(document.querySelector<HTMLInputElement>(`#${pair.symbol}-asset`)!.value);
    const stable = parseUnits(document.querySelector<HTMLInputElement>(`#${pair.symbol}-usdm`)!.value, 6);
    const connectedWallet = wallet();
    set(`1/3 approve ${pair.symbol}...`);
    await wait(await connectedWallet.writeContract({ account, address: pair.token, abi: erc20, functionName: "approve", args: [pair.pool, asset] }));
    set("2/3 approve USDm...");
    await wait(await connectedWallet.writeContract({ account, address: usdm, abi: erc20, functionName: "approve", args: [pair.pool, stable] }));
    set(`3/3 add ${pair.symbol}/USDm liquidity...`);
    await wait(await connectedWallet.writeContract({ account, address: pair.pool, abi: poolArtifact.abi, functionName: "addLiquidity", args: [asset, stable] }));
    set(`${pair.symbol}/USDm seeded. Continue with the next pool.`);
  } catch (error) { set(error instanceof Error ? error.message : "Cancelled or failed."); }
};
