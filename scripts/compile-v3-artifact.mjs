import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const entry = "contracts/EoaTakeProfitExecutorV3.sol";
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

await collect(entry);

const solcPath = "C:/Users/Vibe Code/AppData/Local/hardhat-nodejs/Cache/compilers-v3/wasm/soljson-v0.8.28+commit.7893614a.js";
const wrapperPath = pathToFileURL(path.join(root, "node_modules/hardhat/dist/src/internal/builtin-plugins/solidity/build-system/compiler/solcjs-wrapper.js")).href;
const [{ default: wrapSolc }, solcModule] = await Promise.all([import(wrapperPath), import(pathToFileURL(solcPath).href)]);
const compiler = wrapSolc(solcModule.default ?? solcModule);
const output = JSON.parse(compiler.compile(JSON.stringify({
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
  }
})));

const errors = (output.errors ?? []).filter((error) => error.severity === "error");
if (errors.length) throw new Error(errors.map((error) => error.formattedMessage).join("\n"));
const artifact = output.contracts[entry].EoaTakeProfitExecutorV3;
await writeFile(
  path.join(root, "web/src/generated/EoaTakeProfitExecutorV3.json"),
  `${JSON.stringify({ contractName: "EoaTakeProfitExecutorV3", abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}` })}\n`
);
console.log(`V3 artifact compiled: ${artifact.evm.bytecode.object.length / 2} bytes of creation code.`);
