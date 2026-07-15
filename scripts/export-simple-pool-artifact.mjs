import { cp, mkdir } from "node:fs/promises";

await mkdir("web/src/generated", { recursive: true });
await cp(
  "artifacts/contracts/SimplePool.sol/SimplePool.json",
  "web/src/generated/SimplePool.json"
);
await cp(
  "artifacts/contracts/DemoMarketFactory.sol/DemoMarketFactory.json",
  "web/src/generated/DemoMarketFactory.json"
);
await cp(
  "artifacts/contracts/PolicyVault.sol/PolicyVault.json",
  "web/src/generated/PolicyVault.json"
);
