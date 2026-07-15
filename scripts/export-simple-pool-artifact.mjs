import { cp, mkdir } from "node:fs/promises";

await mkdir("web/src/generated", { recursive: true });
await cp(
  "artifacts/contracts/SimplePool.sol/SimplePool.json",
  "web/src/generated/SimplePool.json"
);
