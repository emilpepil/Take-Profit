// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Testnet-only token for the Take Profit demonstration market.
contract DemoToken is ERC20, Ownable {
    uint8 private immutable tokenDecimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address owner_, uint256 initialSupply)
        ERC20(name_, symbol_)
        Ownable(owner_)
    {
        tokenDecimals = decimals_;
        _mint(owner_, initialSupply);
    }

    function decimals() public view override returns (uint8) { return tokenDecimals; }
    function mint(address to, uint256 amount) external onlyOwner { _mint(to, amount); }
}
