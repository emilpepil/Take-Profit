// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IEoaTakeProfitPool {
    function token0() external view returns (IERC20);
    function token1() external view returns (IERC20);
    function getReserves() external view returns (uint256, uint256);
    function getAmountOut(IERC20 tokenIn, uint256 amountIn) external view returns (uint256);
    function swap(IERC20 tokenIn, uint256 amountIn, uint256 minAmountOut, address recipient) external returns (uint256);
}

/// @notice Testnet EOA take-profit executor. It never accepts deposits or retains user funds.
/// @dev A user gives an exact ERC-20 allowance, then configures the amount/price limits for their own address.
contract EoaTakeProfitExecutor is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;

    IEoaTakeProfitPool public immutable pool;
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

    mapping(address owner => Policy) public policies;

    error UnauthorizedKeeper();
    error InvalidConfiguration();
    error PolicyInactive();
    error ThresholdNotReached(uint256 spotPriceE18, uint256 targetPriceE18);
    error InsufficientWalletBalance(uint256 available, uint256 required);
    error InsufficientAllowance(uint256 available, uint256 required);

    event PolicyConfigured(address indexed owner, uint256 amount, uint256 targetPriceE18, uint16 maxSlippageBps);
    event PolicyCancelled(address indexed owner);
    event PolicyExecuted(address indexed owner, uint256 spotPriceE18, uint256 amountIn, uint256 amountOut);

    constructor(IERC20 asset_, IERC20 stable_, IEoaTakeProfitPool pool_, address keeper_) {
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

    /// @notice Creates or replaces the caller's rule. The caller keeps the tokens in their wallet.
    function configurePolicy(uint256 amount, uint256 targetPriceE18, uint16 maxSlippageBps) external {
        if (amount == 0 || targetPriceE18 == 0 || maxSlippageBps > 1_000) revert InvalidConfiguration();
        policies[msg.sender] = Policy({amount: amount, targetPriceE18: targetPriceE18, maxSlippageBps: maxSlippageBps, active: true});
        emit PolicyConfigured(msg.sender, amount, targetPriceE18, maxSlippageBps);
    }

    /// @notice Stops the caller's rule. It never transfers the caller's tokens.
    function cancelPolicy() external {
        Policy storage policy = policies[msg.sender];
        if (!policy.active) revert PolicyInactive();
        policy.active = false;
        emit PolicyCancelled(msg.sender);
    }

    /// @notice Keeper-only execution after the target price is met.
    /// @dev The exact configured amount is pulled from the owner and swap proceeds are sent directly back to that owner.
    function executePolicy(address owner) external nonReentrant returns (uint256 amountOut) {
        if (msg.sender != keeper) revert UnauthorizedKeeper();
        Policy memory policy = policies[owner];
        if (!policy.active) revert PolicyInactive();
        uint256 price = spotPriceE18();
        if (price < policy.targetPriceE18) revert ThresholdNotReached(price, policy.targetPriceE18);
        uint256 available = asset.balanceOf(owner);
        if (available < policy.amount) revert InsufficientWalletBalance(available, policy.amount);
        uint256 allowed = asset.allowance(owner, address(this));
        if (allowed < policy.amount) revert InsufficientAllowance(allowed, policy.amount);

        asset.safeTransferFrom(owner, address(this), policy.amount);
        uint256 quote = pool.getAmountOut(asset, policy.amount);
        uint256 minimum = quote * (BPS_DENOMINATOR - policy.maxSlippageBps) / BPS_DENOMINATOR;
        asset.forceApprove(address(pool), policy.amount);
        amountOut = pool.swap(asset, policy.amount, minimum, owner);
        asset.forceApprove(address(pool), 0);

        policies[owner].active = false;
        emit PolicyExecuted(owner, price, policy.amount, amountOut);
    }

    function spotPriceE18() public view returns (uint256) {
        (uint256 assetReserve, uint256 stableReserve) = pool.getReserves();
        if (assetReserve == 0 || stableReserve == 0) revert InvalidConfiguration();
        return Math.mulDiv(stableReserve, assetScale * 1e18, assetReserve * stableScale);
    }
}
