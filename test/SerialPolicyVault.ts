import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hre from "hardhat";

const { viem, networkHelpers } = await hre.network.create();
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;

describe("SerialPolicyVault", () => {
  async function fixture() {
    const [safeOwner, keeper, outsider] = await viem.getWalletClients();
    const asset = await viem.deployContract("MockERC20", ["James", "JAMES", 18]);
    const stable = await viem.deployContract("MockERC20", ["Demo USD", "USDm", 6]);
    const pool = await viem.deployContract("SimplePool", [asset.address, stable.address]);
    const vault = await viem.deployContract("SerialPolicyVault", [asset.address, stable.address, pool.address, safeOwner.account.address, keeper.account.address, 11n * E18, 9n * E18, 2_500, 100]);
    await asset.write.mint([safeOwner.account.address, 20_000n * E18]);
    await stable.write.mint([safeOwner.account.address, 200_000n * E6]);
    await asset.write.approve([pool.address, 10_000n * E18]);
    await stable.write.approve([pool.address, 100_000n * E6]);
    await pool.write.addLiquidity([10_000n * E18, 100_000n * E6]);
    await asset.write.approve([vault.address, 1_000n * E18]);
    await stable.write.approve([vault.address, 10_000n * E6]);
    await vault.write.fund([1_000n * E18, 10_000n * E6]);
    await stable.write.approve([pool.address, 50_000n * E6]);
    await pool.write.swap([stable.address, 50_000n * E6, 1n, safeOwner.account.address]);
    return { safeOwner, keeper, outsider, asset, vault };
  }

  it("requires the Safe owner to enable serial automation", async () => {
    const { keeper, outsider, vault } = await networkHelpers.loadFixture(fixture);
    await viem.assertions.revertWithCustomError(vault.write.executeAutomation([], { account: keeper.account }), vault, "AutomationDisabled");
    await viem.assertions.revertWithCustomError(vault.write.setAutomationConfig([true, 2, 60], { account: outsider.account }), vault, "OwnableUnauthorizedAccount");
  });

  it("enforces the Safe-approved cooldown and daily limit for the keeper", async () => {
    const { safeOwner, keeper, asset, vault } = await networkHelpers.loadFixture(fixture);
    await vault.write.setAutomationConfig([true, 1, 60], { account: safeOwner.account });
    await vault.write.executeAutomation([], { account: keeper.account });
    assert.equal(await asset.read.balanceOf([vault.address]), 750n * E18);
    await viem.assertions.revertWithCustomError(vault.write.executeAutomation([], { account: keeper.account }), vault, "CooldownActive");
    await networkHelpers.time.increase(61);
    await viem.assertions.revertWithCustomError(vault.write.executeAutomation([], { account: keeper.account }), vault, "DailyExecutionLimitReached");
  });

  it("keeps manual execution exclusively under the Safe owner", async () => {
    const { safeOwner, keeper, vault } = await networkHelpers.loadFixture(fixture);
    await viem.assertions.revertWithCustomError(vault.write.executePolicy([], { account: keeper.account }), vault, "OwnableUnauthorizedAccount");
    await vault.write.executePolicy([], { account: safeOwner.account });
  });
});
