// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface ISafeModuleAccount {
    function execTransactionFromModuleReturnData(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        returns (bool success, bytes memory returnData);
}

interface ISafeModulePool {
    function token0() external view returns (IERC20);
    function token1() external view returns (IERC20);
    function getReserves() external view returns (uint256, uint256);
    function getAmountOut(IERC20 tokenIn, uint256 amountIn) external view returns (uint256);
    function swap(IERC20 tokenIn, uint256 amountIn, uint256 minAmountOut, address recipient) external returns (uint256);
}

/// @notice Non-custodial Take Profit automation module for a Safe account.
/// @dev Tokens always remain in the Safe. The Safe must explicitly enable this module.
contract SafeTakeProfitModule {
    uint256 public constant BPS_DENOMINATOR = 10_000;

    ISafeModulePool public immutable pool;
    IERC20 public immutable asset;
    IERC20 public immutable stable;
    uint256 public immutable assetScale;
    uint256 public immutable stableScale;
    address public immutable keeper;

    struct Policy {
        uint256 amount;
        uint256 targetPriceE18;
        uint16 maxSlippageBps;
        bool active;
    }

    mapping(address safe => Policy) public policies;

    error UnauthorizedKeeper();
    error InvalidConfiguration();
    error PolicyInactive();
    error ThresholdNotReached(uint256 spotPriceE18, uint256 targetPriceE18);
    error InsufficientSafeBalance(uint256 available, uint256 required);
    error SafeModuleCallFailed();

    event PolicyConfigured(address indexed safe, uint256 amount, uint256 targetPriceE18, uint16 maxSlippageBps);
    event PolicyCancelled(address indexed safe);
    event PolicyExecuted(address indexed safe, uint256 spotPriceE18, uint256 amountIn, uint256 amountOut);

    constructor(IERC20 asset_, IERC20 stable_, ISafeModulePool pool_, address keeper_) {
        if (address(asset_) == address(0) || address(stable_) == address(0) || address(pool_) == address(0) || keeper_ == address(0)) revert InvalidConfiguration();
        if (pool_.token0() != asset_ || pool_.token1() != stable_) revert InvalidConfiguration();
        uint8 assetDecimals = IERC20Metadata(address(asset_)).decimals();
        uint8 stableDecimals = IERC20Metadata(address(stable_)).decimals();
        if (assetDecimals > 18 || stableDecimals > 18) revert InvalidConfiguration();
        asset = asset_;
        stable = stable_;
        pool = pool_;
        assetScale = 10 ** assetDecimals;
        stableScale = 10 ** stableDecimals;
        keeper = keeper_;
    }

    /// @notice Called by the Safe itself through a signed Safe transaction.
    function configurePolicy(uint256 amount, uint256 targetPriceE18, uint16 maxSlippageBps) external {
        if (amount == 0 || targetPriceE18 == 0 || maxSlippageBps > 1_000) revert InvalidConfiguration();
        policies[msg.sender] = Policy({ amount: amount, targetPriceE18: targetPriceE18, maxSlippageBps: maxSlippageBps, active: true });
        emit PolicyConfigured(msg.sender, amount, targetPriceE18, maxSlippageBps);
    }

    /// @notice Called by the Safe itself; stopping a rule never moves Safe assets.
    function cancelPolicy() external {
        Policy storage policy = policies[msg.sender];
        if (!policy.active) revert PolicyInactive();
        policy.active = false;
        emit PolicyCancelled(msg.sender);
    }

    /// @notice Keeper-only execution after price verification. Funds are spent and received by the Safe.
    function executePolicy(address safe) external returns (uint256 amountOut) {
        if (msg.sender != keeper) revert UnauthorizedKeeper();
        Policy memory policy = policies[safe];
        if (!policy.active) revert PolicyInactive();
        uint256 price = spotPriceE18();
        if (price < policy.targetPriceE18) revert ThresholdNotReached(price, policy.targetPriceE18);
        uint256 available = asset.balanceOf(safe);
        if (available < policy.amount) revert InsufficientSafeBalance(available, policy.amount);

        _safeCall(safe, address(asset), abi.encodeCall(IERC20.approve, (address(pool), policy.amount)));
        uint256 quote = pool.getAmountOut(asset, policy.amount);
        uint256 minimum = quote * (BPS_DENOMINATOR - policy.maxSlippageBps) / BPS_DENOMINATOR;
        bytes memory data = abi.encodeCall(ISafeModulePool.swap, (asset, policy.amount, minimum, safe));
        bytes memory result = _safeCall(safe, address(pool), data);
        amountOut = abi.decode(result, (uint256));
        _safeCall(safe, address(asset), abi.encodeCall(IERC20.approve, (address(pool), 0)));

        policies[safe].active = false;
        emit PolicyExecuted(safe, price, policy.amount, amountOut);
    }

    function spotPriceE18() public view returns (uint256) {
        (uint256 assetReserve, uint256 stableReserve) = pool.getReserves();
        if (assetReserve == 0 || stableReserve == 0) revert InvalidConfiguration();
        return Math.mulDiv(stableReserve, assetScale * 1e18, assetReserve * stableScale);
    }

    function _safeCall(address safe, address to, bytes memory data) private returns (bytes memory result) {
        (bool success, bytes memory returnData) = ISafeModuleAccount(safe).execTransactionFromModuleReturnData(to, 0, data, 0);
        if (!success) revert SafeModuleCallFailed();
        return returnData;
    }
}
