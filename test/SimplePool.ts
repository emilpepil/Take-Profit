import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hre from "hardhat";

const { viem, networkHelpers } = await hre.network.create();

describe("SimplePool", () => {
  async function deployPoolFixture() {
    const [owner, trader] = await viem.getWalletClients();
    const wmon = await viem.deployContract("MockERC20", ["Local Wrapped MON", "WMON", 18]);
    const usdc = await viem.deployContract("MockERC20", ["Local Test USDC", "USDC", 6]);
    const pool = await viem.deployContract("SimplePool", [wmon.address, usdc.address]);

    const initialWmon = 100n * 10n ** 18n;
    const initialUsdc = 100_000n * 10n ** 6n;

    await wmon.write.mint([owner.account.address, initialWmon]);
    await usdc.write.mint([owner.account.address, initialUsdc]);
    await wmon.write.approve([pool.address, initialWmon]);
    await usdc.write.approve([pool.address, initialUsdc]);
    await pool.write.addLiquidity([initialWmon, initialUsdc]);

    return { owner, trader, wmon, usdc, pool, initialWmon, initialUsdc };
  }

  it("records liquidity reserves", async () => {
    const { pool, initialWmon, initialUsdc } = await networkHelpers.loadFixture(deployPoolFixture);
    const [reserve0, reserve1] = await pool.read.getReserves();

    assert.equal(reserve0, initialWmon);
    assert.equal(reserve1, initialUsdc);
  });

  it("swaps WMON for USDC at the quoted constant-product price", async () => {
    const { trader, wmon, usdc, pool, initialWmon, initialUsdc } =
      await networkHelpers.loadFixture(deployPoolFixture);
    const amountIn = 1n * 10n ** 18n;

    await wmon.write.mint([trader.account.address, amountIn]);
    await wmon.write.approve([pool.address, amountIn], { account: trader.account });

    const expectedAmountOut = await pool.read.getAmountOut([wmon.address, amountIn]);
    await pool.write.swap([wmon.address, amountIn, expectedAmountOut, trader.account.address], {
      account: trader.account
    });

    assert.equal(await usdc.read.balanceOf([trader.account.address]), expectedAmountOut);

    const [reserve0, reserve1] = await pool.read.getReserves();
    assert.equal(reserve0, initialWmon + amountIn);
    assert.equal(reserve1, initialUsdc - expectedAmountOut);
  });

  it("refuses a swap when the caller's minimum output cannot be met", async () => {
    const { trader, wmon, pool } = await networkHelpers.loadFixture(deployPoolFixture);
    const amountIn = 1n * 10n ** 18n;

    await wmon.write.mint([trader.account.address, amountIn]);
    await wmon.write.approve([pool.address, amountIn], { account: trader.account });

    await viem.assertions.revertWithCustomError(
      pool.write.swap([wmon.address, amountIn, 1_000_000_000n, trader.account.address], {
        account: trader.account
      }),
      pool,
      "SlippageExceeded"
    );
  });
});
