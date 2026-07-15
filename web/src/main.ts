import { createPublicClient, createWalletClient, custom, defineChain, getAddress, http, type Address } from "viem";
import artifact from "./generated/SimplePool.json";
import "./style.css";

declare global { interface Window { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } } }

const rpcUrl = "https://testnet-rpc.monad.xyz";
const monadTestnet = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } }, blockExplorers: { default: { name: "Monad Explorer", url: "https://testnet.monadexplorer.com" } } });
const WMON = getAddress("0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541");
const USDC = getAddress("0x534b2f3A21130d7a60830c2Df862319e593943A3");
const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
const connectButton = document.querySelector<HTMLButtonElement>("#connect")!;
const deployButton = document.querySelector<HTMLButtonElement>("#deploy")!;
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
    setStatus("Wallet connected. Review the MetaMask transaction before confirming.");
  } catch (error) { setStatus(error instanceof Error ? error.message : "Could not connect MetaMask."); }
});

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
