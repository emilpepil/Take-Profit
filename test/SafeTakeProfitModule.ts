import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hre from "hardhat";
import { encodeFunctionData } from "viem";

const { viem, networkHelpers } = await hre.network.create();
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
const moduleAbi = [
  { type: "function", name: "configurePolicy", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }, { name: "targetPriceE18", type: "uint256" }, { name: "maxSlippageBps", type: "uint16" }], outputs: [] },
  { type: "function", name: "cancelPolicy", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;

describe("SafeTakeProfitModule", () => {
  async function fixture() {
    const [owner, keeper, outsider] = await viem.getWalletClients();
    const asset = await viem.deployContract("MockERC20", ["James", "JAMES", 18]);
    const stable = await viem.deployContract("MockERC20", ["Demo USD", "USDm", 6]);
    const pool = await viem.deployContract("SimplePool", [asset.address, stable.address]);
    const safe = await viem.deployContract("MockSafeAccount", [owner.account.address]);
    const module = await viem.deployContract("SafeTakeProfitModule", [asset.address, stable.address, pool.address, keeper.account.address]);

    await asset.write.mint([owner.account.address, 20_000n * E18]);
    await stable.write.mint([owner.account.address, 200_000n * E6]);
    await asset.write.approve([pool.address, 10_000n * E18]);
    await stable.write.approve([pool.address, 100_000n * E6]);
    await pool.write.addLiquidity([10_000n * E18, 100_000n * E6]);
    await asset.write.transfer([safe.address, 1_000n * E18]);
    await safe.write.enableModule([module.address]);
    const configData = encodeFunctionData({ abi: moduleAbi, functionName: "configurePolicy", args: [250n * E18, 11n * E18, 100] });
    await safe.write.execute([module.address, configData]);
    await stable.write.approve([pool.address, 50_000n * E6]);
    await pool.write.swap([stable.address, 50_000n * E6, 1n, owner.account.address]);
    return { owner, keeper, outsider, asset, stable, pool, safe, module };
  }

  it("keeps assets in the Safe and pays swap proceeds back to the Safe", async () => {
    const { keeper, asset, stable, safe, module } = await networkHelpers.loadFixture(fixture);
    const beforeStable = await stable.read.balanceOf([safe.address]);
    await module.write.executePolicy([safe.address], { account: keeper.account });
    assert.equal(await asset.read.balanceOf([safe.address]), 750n * E18);
    assert.ok(await stable.read.balanceOf([safe.address]) > beforeStable);
    assert.equal((await module.read.policies([safe.address]))[3], false);
  });

  it("allows only the Safe to cancel and blocks later keeper execution", async () => {
    const { keeper, outsider, safe, module } = await networkHelpers.loadFixture(fixture);
    await viem.assertions.revertWithCustomError(module.write.cancelPolicy([], { account: outsider.account }), module, "PolicyInactive");
    const cancelData = encodeFunctionData({ abi: moduleAbi, functionName: "cancelPolicy" });
    await safe.write.execute([module.address, cancelData]);
    await viem.assertions.revertWithCustomError(module.write.executePolicy([safe.address], { account: keeper.account }), module, "PolicyInactive");
  });
});
