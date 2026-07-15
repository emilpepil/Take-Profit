import { defineConfig } from "hardhat/config";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";
import hardhatNodeTestRunner from "@nomicfoundation/hardhat-node-test-runner";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import hardhatViemAssertions from "@nomicfoundation/hardhat-viem-assertions";

/**
 * Safety rule: this repository is configured only for Monad Testnet.
 * The account source is deliberately "remote" until a separately approved
 * deployment step provides a testnet-only signer.
 */
export default defineConfig({
  plugins: [
    hardhatViem,
    hardhatViemAssertions,
    hardhatNodeTestRunner,
    hardhatNetworkHelpers
  ],
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  },
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  networks: {
    monadTestnet: {
      type: "http",
      chainType: "generic",
      url: "https://testnet-rpc.monad.xyz",
      chainId: 10143,
      accounts: "remote",
      gas: "auto",
      gasMultiplier: 1
    }
  }
});
