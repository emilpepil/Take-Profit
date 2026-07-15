import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hre from "hardhat";

const { viem, networkHelpers } = await hre.network.create();
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;

describe("PolicyVault", () => {
  async function fixture() {
    const [owner, keeper, outsider] = await viem.getWalletClients();
    const asset = await viem.deployContract("MockERC20", ["James", "JAMES", 18]);
    const stable = await viem.deployContract("MockERC20", ["Demo USD", "USDm", 6]);
    const pool = await viem.deployContract("SimplePool", [asset.address, stable.address]);
    const vault = await viem.deployContract("PolicyVault", [asset.address, stable.address, pool.address, owner.account.address, keeper.account.address, 11n * E18, 9n * E18, 2_500, 100]);

    const liquidityAsset = 10_000n * E18;
    const liquidityStable = 100_000n * E6;
    await asset.write.mint([owner.account.address, liquidityAsset]);
    await stable.write.mint([owner.account.address, liquidityStable]);
    await asset.write.approve([pool.address, liquidityAsset]);
    await stable.write.approve([pool.address, liquidityStable]);
    await pool.write.addLiquidity([liquidityAsset, liquidityStable]);

    const vaultAsset = 1_000n * E18;
    const vaultStable = 10_000n * E6;
    await asset.write.mint([owner.account.address, vaultAsset]);
    await stable.write.mint([owner.account.address, vaultStable]);
    await asset.write.approve([vault.address, vaultAsset]);
    await stable.write.approve([vault.address, vaultStable]);
    await vault.write.fund([vaultAsset, vaultStable]);
    return { owner, keeper, outsider, asset, stable, pool, vault, vaultAsset, vaultStable };
  }

  it("sells a configured share of the asset after the take-profit price", async () => {
    const { owner, keeper, asset, stable, pool, vault, vaultAsset, vaultStable } = await networkHelpers.loadFixture(fixture);
    const pricePump = 50_000n * E6;
    await stable.write.mint([owner.account.address, pricePump]);
    await stable.write.approve([pool.address, pricePump]);
    await pool.write.swap([stable.address, pricePump, 1n, owner.account.address]);
    assert.ok(await vault.read.spotPriceE18() >= 11n * E18);

    await vault.write.executePolicy([], { account: keeper.account });
    assert.equal(await asset.read.balanceOf([vault.address]), vaultAsset * 7_500n / 10_000n);
    assert.ok(await stable.read.balanceOf([vault.address]) > vaultStable);
  });

  it("buys the asset after the rebalance price", async () => {
    const { owner, keeper, asset, stable, pool, vault, vaultAsset, vaultStable } = await networkHelpers.loadFixture(fixture);
    const priceDrop = 5_000n * E18;
    await asset.write.mint([owner.account.address, priceDrop]);
    await asset.write.approve([pool.address, priceDrop]);
    await pool.write.swap([asset.address, priceDrop, 1n, owner.account.address]);
    assert.ok(await vault.read.spotPriceE18() <= 9n * E18);

    await vault.write.executePolicy([], { account: keeper.account });
    assert.ok(await asset.read.balanceOf([vault.address]) > vaultAsset);
    assert.equal(await stable.read.balanceOf([vault.address]), vaultStable * 7_500n / 10_000n);
  });

  it("does not allow an unrelated account to execute the policy", async () => {
    const { outsider, vault } = await networkHelpers.loadFixture(fixture);
    await viem.assertions.revertWithCustomError(vault.write.executePolicy([], { account: outsider.account }), vault, "Unauthorized");
  });
});
