// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DemoToken} from "./DemoToken.sol";
import {SimplePool} from "./SimplePool.sol";

/// @notice Deploys the complete four-token demo market in one MetaMask transaction.
contract DemoMarketFactory {
    uint256 private constant ASSET_SUPPLY = 1_000_000 ether;
    uint256 private constant USDM_SUPPLY = 10_000_000 * 1e6;

    event DemoMarketDeployed(address indexed owner, address james, address emo, address chog, address usdm, address jamesPool, address emoPool, address chogPool);

    function deployDemoMarket(address owner) external returns (DemoToken james, DemoToken emo, DemoToken chog, DemoToken usdm, SimplePool jamesPool, SimplePool emoPool, SimplePool chogPool) {
        require(owner != address(0), "owner is zero");
        james = new DemoToken("James", "JAMES", 18, owner, ASSET_SUPPLY);
        emo = new DemoToken("Emo", "EMO", 18, owner, ASSET_SUPPLY);
        chog = new DemoToken("Chog", "CHOG", 18, owner, ASSET_SUPPLY);
        usdm = new DemoToken("Monad Demo USD", "USDm", 6, owner, USDM_SUPPLY);
        jamesPool = new SimplePool(IERC20(address(james)), IERC20(address(usdm)));
        emoPool = new SimplePool(IERC20(address(emo)), IERC20(address(usdm)));
        chogPool = new SimplePool(IERC20(address(chog)), IERC20(address(usdm)));
        emit DemoMarketDeployed(owner, address(james), address(emo), address(chog), address(usdm), address(jamesPool), address(emoPool), address(chogPool));
    }
}
