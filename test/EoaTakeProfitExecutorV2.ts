import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hre from "hardhat";

const { viem, networkHelpers } = await hre.network.create();
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;

describe("EoaTakeProfitExecutorV2", () => {
  async function fixture() {
    const [owner, keeper] = await viem.getWalletClients();
    const asset = await viem.deployContract("MockERC20", ["James", "JAMES", 18]);
    const stable = await viem.deployContract("MockERC20", ["Demo USD", "USDm", 6]);
    const pool = await viem.deployContract("SimplePool", [asset.address, stable.address]);
    const executor = await viem.deployContract("EoaTakeProfitExecutorV2", [asset.address, stable.address, pool.address, keeper.account.address]);
    await asset.write.mint([owner.account.address, 20_000n * E18]);
    await stable.write.mint([owner.account.address, 200_000n * E6]);
    await asset.write.approve([pool.address, 10_000n * E18]);
    await stable.write.approve([pool.address, 100_000n * E6]);
    await pool.write.addLiquidity([10_000n * E18, 100_000n * E6]);
    await asset.write.approve([executor.address, 500n * E18]);
    return { owner, keeper, asset, stable, pool, executor };
  }

  it("stores multiple independent rules and tracks the aggregate reservation", async () => {
    const { owner, executor } = await networkHelpers.loadFixture(fixture);
    await executor.write.createPolicy([100n * E18, 11n * E18, 100]);
    await executor.write.createPolicy([150n * E18, 12n * E18, 100]);
    assert.equal(await executor.read.policyCount([owner.account.address]), 2n);
    assert.equal(await executor.read.activeAmount([owner.account.address]), 250n * E18);
    assert.equal((await executor.read.policies([owner.account.address, 1n]))[0], 100n * E18);
    assert.equal((await executor.read.policies([owner.account.address, 2n]))[0], 150n * E18);
  });

  it("cancels only the selected rule without moving wallet assets", async () => {
    const { owner, asset, executor } = await networkHelpers.loadFixture(fixture);
    await executor.write.createPolicy([100n * E18, 11n * E18, 100]);
    await executor.write.createPolicy([150n * E18, 12n * E18, 100]);
    const before = await asset.read.balanceOf([owner.account.address]);
    await executor.write.cancelPolicy([1n]);
    assert.equal((await executor.read.policies([owner.account.address, 1n]))[3], false);
    assert.equal((await executor.read.policies([owner.account.address, 2n]))[3], true);
    assert.equal(await executor.read.activeAmount([owner.account.address]), 150n * E18);
    assert.equal(await asset.read.balanceOf([owner.account.address]), before);
  });

  it("executes one reached rule and leaves another active", async () => {
    const { owner, keeper, asset, stable, pool, executor } = await networkHelpers.loadFixture(fixture);
    await executor.write.createPolicy([100n * E18, 11n * E18, 100]);
    await executor.write.createPolicy([150n * E18, 20n * E18, 100]);
    await stable.write.approve([pool.address, 50_000n * E6]);
    await pool.write.swap([stable.address, 50_000n * E6, 1n, owner.account.address]);
    const assetBefore = await asset.read.balanceOf([owner.account.address]);
    await executor.write.executePolicy([owner.account.address, 1n], { account: keeper.account });
    assert.equal(await asset.read.balanceOf([owner.account.address]), assetBefore - 100n * E18);
    assert.equal((await executor.read.policies([owner.account.address, 1n]))[3], false);
    assert.equal((await executor.read.policies([owner.account.address, 2n]))[3], true);
    assert.equal(await executor.read.activeAmount([owner.account.address]), 150n * E18);
  });
});
