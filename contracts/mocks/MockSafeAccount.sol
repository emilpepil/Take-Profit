// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Test double for the Safe module interface. Production uses a real Safe account.
contract MockSafeAccount {
    address public immutable owner;
    mapping(address module => bool enabled) public modules;

    error Unauthorized();
    error ModuleNotEnabled();

    constructor(address owner_) { owner = owner_; }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    function enableModule(address module) external onlyOwner { modules[module] = true; }

    function execute(address to, bytes calldata data) external onlyOwner returns (bytes memory result) {
        (bool success, bytes memory returnData) = to.call(data);
        if (!success) assembly { revert(add(returnData, 0x20), mload(returnData)) }
        return returnData;
    }

    function execTransactionFromModuleReturnData(address to, uint256 value, bytes calldata data, uint8)
        external
        returns (bool success, bytes memory returnData)
    {
        if (!modules[msg.sender]) revert ModuleNotEnabled();
        return to.call{value: value}(data);
    }
}
