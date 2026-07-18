import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import solc from "solc";

const root = process.cwd();
const artifacts = [
  ["contracts/SimplePool.sol", "SimplePool"],
  ["contracts/DemoMarketFactory.sol", "DemoMarketFactory"],
  ["contracts/PolicyVault.sol", "PolicyVault"],
  ["contracts/SafeTakeProfitModule.sol", "SafeTakeProfitModule"],
  ["contracts/EoaTakeProfitExecutor.sol", "EoaTakeProfitExecutor"],
  ["contracts/EoaTakeProfitExecutorV2.sol", "EoaTakeProfitExecutorV2"],
  ["contracts/EoaTakeProfitExecutorV3.sol", "EoaTakeProfitExecutorV3"]
];

const sources = {};

async function collect(sourceName) {
  if (sources[sourceName]) return;
  const absolute = sourceName.startsWith("@openzeppelin/")
    ? path.join(root, "node_modules", sourceName)
    : path.join(root, sourceName);
  const content = await readFile(absolute, "utf8");
  sources[sourceName] = { content };

  for (const match of content.matchAll(/import\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["'];/g)) {
    const imported = match[1];
    const child = imported.startsWith(".")
      ? path.posix.normalize(path.posix.join(path.posix.dirname(sourceName), imported))
      : imported;
    await collect(child);
  }
}

for (const [sourceName] of artifacts) await collect(sourceName);

const output = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
  }
})));

const errors = (output.errors ?? []).filter((error) => error.severity === "error");
if (errors.length) throw new Error(errors.map((error) => error.formattedMessage).join("\n"));

await mkdir(path.join(root, "web/src/generated"), { recursive: true });
for (const [sourceName, contractName] of artifacts) {
  const contract = output.contracts[sourceName][contractName];
  await writeFile(
    path.join(root, "web/src/generated", `${contractName}.json`),
    `${JSON.stringify({ contractName, abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` })}\n`
  );
}

console.log(`Frontend contract artifacts compiled with solc ${solc.version()}.`);
