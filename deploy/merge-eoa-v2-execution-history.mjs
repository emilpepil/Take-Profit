import { readFile, rename, writeFile } from "node:fs/promises";

const [statePath, seedPath] = process.argv.slice(2);
if (!statePath || !seedPath) throw new Error("Usage: node merge-eoa-v2-execution-history.mjs <state-path> <seed-path>");

const state = JSON.parse(await readFile(statePath, "utf8"));
const seeded = JSON.parse(await readFile(seedPath, "utf8"));
const key = (entry) => `${entry.executor.toLowerCase()}:${entry.owner.toLowerCase()}:${entry.policyId}`;
const history = [...(state.executionHistory ?? []), ...seeded]
  .reduce((records, entry) => records.set(key(entry), entry), new Map())
  .values();
state.executionHistory = [...history].sort((a, b) => a.executedAt.localeCompare(b.executedAt)).slice(-50);
await writeFile(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`, "utf8");
await rename(`${statePath}.tmp`, statePath);
console.log(`Merged ${state.executionHistory.length} execution-history records.`);
