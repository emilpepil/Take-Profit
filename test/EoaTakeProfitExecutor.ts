import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hre from "hardhat";

const { viem, networkHelpers } = await hre.network.create();
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;

describe("EoaTakeProfitExecutor", () => {
  async function fixture() {
    const [owner, keeper, outsider] = await viem.getWalletClients();
    const asset = await viem.deployContract("MockERC20", ["James", "JAMES", 18]);
    const stable = await viem.deployContract("MockERC20", ["Demo USD", "USDm", 6]);
    const pool = await viem.deployContract("SimplePool", [asset.address, stable.address]);
    const executor = await viem.deployContract("EoaTakeProfitExecutor", [asset.address, stable.address, pool.address, keeper.account.address]);

    await asset.write.mint([owner.account.address, 20_000n * E18]);
    await stable.write.mint([owner.account.address, 200_000n * E6]);
    await asset.write.approve([pool.address, 10_000n * E18]);
    await stable.write.approve([pool.address, 100_000n * E6]);
    await pool.write.addLiquidity([10_000n * E18, 100_000n * E6]);
    await asset.write.approve([executor.address, 250n * E18]);
    await executor.write.configurePolicy([250n * E18, 11n * E18, 100]);
    await stable.write.approve([pool.address, 50_000n * E6]);
    await pool.write.swap([stable.address, 50_000n * E6, 1n, owner.account.address]);
    return { owner, keeper, outsider, asset, stable, executor };
  }

  it("keeps tokens in the EOA until execution and returns proceeds to the EOA", async () => {
    const { owner, keeper, asset, stable, executor } = await networkHelpers.loadFixture(fixture);
    const assetBefore = await asset.read.balanceOf([owner.account.address]);
    const stableBefore = await stable.read.balanceOf([owner.account.address]);
    assert.equal(await asset.read.balanceOf([executor.address]), 0n);
    await executor.write.executePolicy([owner.account.address], { account: keeper.account });
    assert.equal(await asset.read.balanceOf([owner.account.address]), assetBefore - 250n * E18);
    assert.ok(await stable.read.balanceOf([owner.account.address]) > stableBefore);
    assert.equal(await asset.read.balanceOf([executor.address]), 0n);
  });

  it("allows the owner to cancel without moving wallet assets", async () => {
    const { owner, keeper, asset, executor } = await networkHelpers.loadFixture(fixture);
    const before = await asset.read.balanceOf([owner.account.address]);
    await executor.write.cancelPolicy();
    assert.equal(await asset.read.balanceOf([owner.account.address]), before);
    await viem.assertions.revertWithCustomError(executor.write.executePolicy([owner.account.address], { account: keeper.account }), executor, "PolicyInactive");
  });

  it("rejects a keeper execution when the owner removed the allowance", async () => {
    const { owner, keeper, asset, executor } = await networkHelpers.loadFixture(fixture);
    await asset.write.approve([executor.address, 0n]);
    await viem.assertions.revertWithCustomError(executor.write.executePolicy([owner.account.address], { account: keeper.account }), executor, "InsufficientAllowance");
  });
});
