import { createPublicClient, createWalletClient, custom, defineChain, getAddress, http, parseEther, parseUnits, type Address } from "viem";
import artifact from "./generated/SimplePool.json";
import "./style.css";

declare global { interface Window { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } } }

const rpcUrl = "https://testnet-rpc.monad.xyz";
const monadTestnet = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } }, blockExplorers: { default: { name: "Monad Explorer", url: "https://testnet.monadexplorer.com" } } });
const WMON = getAddress("0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541");
const USDC = getAddress("0x534b2f3A21130d7a60830c2Df862319e593943A3");
const POOL = getAddress("0xd1880a25c8ec7c7949d2a6c52a9b72848e2e4692");
const erc20Abi = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
const wmonAbi = [{ type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] }] as const;
const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
const connectButton = document.querySelector<HTMLButtonElement>("#connect")!;
const deployButton = document.querySelector<HTMLButtonElement>("#deploy")!;
const wrapButton = document.querySelector<HTMLButtonElement>("#wrap")!;
const liquidityButton = document.querySelector<HTMLButtonElement>("#liquidity")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
document.querySelector<HTMLDListElement>("#wmon")!.textContent = WMON;
document.querySelector<HTMLDListElement>("#usdc")!.textContent = USDC;
let account: Address | undefined;

function setStatus(message: string) { status.textContent = message; }
async function ensureNetwork() {
  const current = await window.ethereum!.request({ method: "eth_chainId" });
  if (current === "0x279f") return;
  try { await window.ethereum!.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x279f" }] }); }
  catch (error: unknown) {
    if ((error as { code?: number }).code !== 4902) throw error;
    await window.ethereum!.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0x279f", chainName: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: [rpcUrl], blockExplorerUrls: ["https://testnet.monadexplorer.com"] }] });
  }
}

connectButton.addEventListener("click", async () => {
  try {
    if (!window.ethereum) throw new Error("MetaMask was not found. Install or unlock it first.");
    await ensureNetwork();
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" }) as string[];
    account = getAddress(accounts[0]);
    connectButton.textContent = `${account.slice(0, 6)}…${account.slice(-4)}`;
    deployButton.disabled = false;
    wrapButton.disabled = false;
    liquidityButton.disabled = false;
    setStatus("Wallet connected. Review the MetaMask transaction before confirming.");
  } catch (error) { setStatus(error instanceof Error ? error.message : "Could not connect MetaMask."); }
});

function wallet() { if (!window.ethereum || !account) throw new Error("Connect MetaMask first."); return createWalletClient({ account, chain: monadTestnet, transport: custom(window.ethereum) }); }
async function wait(hash: `0x${string}`) { await publicClient.waitForTransactionReceipt({ hash }); }
wrapButton.addEventListener("click", async () => { try { const value = parseEther((document.querySelector<HTMLInputElement>("#wrap-amount")!).value); setStatus("Confirm wrapping in MetaMask…"); await wait(await wallet().writeContract({ account, address: WMON, abi: wmonAbi, functionName: "deposit", value })); setStatus("WMON received. Request USDC from Circle Faucet, then add liquidity."); } catch (error) { setStatus(error instanceof Error ? error.message : "Wrapping failed or was cancelled."); } });
liquidityButton.addEventListener("click", async () => { try { const wmonAmount = parseEther((document.querySelector<HTMLInputElement>("#wmon-amount")!).value); const usdcAmount = parseUnits((document.querySelector<HTMLInputElement>("#usdc-amount")!).value, 6); const client = wallet(); setStatus("1/3: confirm WMON approval in MetaMask…"); await wait(await client.writeContract({ account, address: WMON, abi: erc20Abi, functionName: "approve", args: [POOL, wmonAmount] })); setStatus("2/3: confirm USDC approval in MetaMask…"); await wait(await client.writeContract({ account, address: USDC, abi: erc20Abi, functionName: "approve", args: [POOL, usdcAmount] })); setStatus("3/3: confirm adding liquidity in MetaMask…"); await wait(await client.writeContract({ account, address: POOL, abi: artifact.abi, functionName: "addLiquidity", args: [wmonAmount, usdcAmount] })); setStatus("Liquidity added. Send the last transaction hash for verification."); } catch (error) { setStatus(error instanceof Error ? error.message : "Liquidity action failed or was cancelled."); } });

deployButton.addEventListener("click", async () => {
  try {
    if (!window.ethereum || !account) throw new Error("Connect MetaMask first.");
    deployButton.disabled = true;
    setStatus("Verifying token contracts…");
    const [wmonCode, usdcCode] = await Promise.all([publicClient.getBytecode({ address: WMON }), publicClient.getBytecode({ address: USDC })]);
    if (!wmonCode || wmonCode === "0x" || !usdcCode || usdcCode === "0x") throw new Error("Token contract verification failed. Deployment cancelled.");
    const walletClient = createWalletClient({ account, chain: monadTestnet, transport: custom(window.ethereum) });
    setStatus("MetaMask will now show the deployment transaction. Check the network and fee, then confirm.");
    const hash = await walletClient.deployContract({ account, abi: artifact.abi, bytecode: artifact.bytecode as `0x${string}`, args: [WMON, USDC] });
    setStatus(`Submitted: ${hash}. Waiting for confirmation…`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    setStatus(`Deployed successfully: ${receipt.contractAddress}. Save this address — it is needed for liquidity.`);
  } catch (error) { setStatus(error instanceof Error ? error.message : "Deployment was cancelled or failed."); }
  finally { deployButton.disabled = false; }
});
