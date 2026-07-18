import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hre from "hardhat";

const { viem, networkHelpers } = await hre.network.create();
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;

describe("EoaTakeProfitExecutorV3", () => {
  async function fixture() {
    const [owner, keeper] = await viem.getWalletClients();
    const asset = await viem.deployContract("MockERC20", ["James", "JAMES", 18]);
    const stable = await viem.deployContract("MockERC20", ["Demo USD", "USDm", 6]);
    const pool = await viem.deployContract("SimplePool", [asset.address, stable.address]);
    const executor = await viem.deployContract("EoaTakeProfitExecutorV3", [asset.address, stable.address, pool.address, keeper.account.address]);
    await asset.write.mint([owner.account.address, 20_000n * E18]);
    await stable.write.mint([owner.account.address, 200_000n * E6]);
    await asset.write.approve([pool.address, 10_000n * E18]);
    await stable.write.approve([pool.address, 100_000n * E6]);
    await pool.write.addLiquidity([10_000n * E18, 100_000n * E6]);
    await asset.write.approve([executor.address, 10_000n * E18]);
    return { owner, executor };
  }

  it("releases an active slot after cancellation while preserving the history ID", async () => {
    const { owner, executor } = await networkHelpers.loadFixture(fixture);
    await executor.write.createPolicy([100n * E18, 11n * E18, 100]);
    assert.equal(await executor.read.activePolicyCount([owner.account.address]), 1n);
    await executor.write.cancelPolicy([1n]);
    assert.equal(await executor.read.activePolicyCount([owner.account.address]), 0n);
    await executor.write.createPolicy([150n * E18, 12n * E18, 100]);
    assert.equal(await executor.read.policyCount([owner.account.address]), 2n);
    assert.equal(await executor.read.activePolicyCount([owner.account.address]), 1n);
    assert.equal((await executor.read.policies([owner.account.address, 1n]))[3], false);
    assert.equal((await executor.read.policies([owner.account.address, 2n]))[3], true);
  });
});
