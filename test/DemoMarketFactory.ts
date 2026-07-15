import { describe, it } from "node:test";
import hre from "hardhat";

const { viem } = await hre.network.create();
describe("DemoMarketFactory", () => {
  it("mints the demo basket to the user and deploys three USDm pools", async () => {
    const [owner] = await viem.getWalletClients();
    const factory = await viem.deployContract("DemoMarketFactory");
    await factory.write.deployDemoMarket([owner.account.address]);
  });
});
