// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IEoaTakeProfitPoolV3 {
    function token0() external view returns (IERC20);
    function token1() external view returns (IERC20);
    function getReserves() external view returns (uint256, uint256);
    function getAmountOut(IERC20 tokenIn, uint256 amountIn) external view returns (uint256);
    function swap(IERC20 tokenIn, uint256 amountIn, uint256 minAmountOut, address recipient) external returns (uint256);
}

/// @notice EOA take-profit executor with up to 100 simultaneous active levels.
/// @dev Cancelled and executed levels remain addressable for history but no longer consume an active slot.
contract EoaTakeProfitExecutorV3 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_ACTIVE_POLICIES_PER_OWNER = 100;

    IEoaTakeProfitPoolV3 public immutable pool;
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

    /// @notice Historical policy count. It only increases so each policy keeps a stable ID.
    mapping(address owner => uint256) public policyCount;
    /// @notice Number of currently executable levels; this is the 100-rule limit.
    mapping(address owner => uint256) public activePolicyCount;
    mapping(address owner => uint256) public activeAmount;
    mapping(address owner => mapping(uint256 policyId => Policy)) public policies;

    error UnauthorizedKeeper();
    error InvalidConfiguration();
    error PolicyInactive();
    error PolicyNotFound();
    error TooManyPolicies();
    error ThresholdNotReached(uint256 spotPriceE18, uint256 targetPriceE18);
    error InsufficientWalletBalance(uint256 available, uint256 required);
    error InsufficientAllowance(uint256 available, uint256 required);

    event PolicyCreated(address indexed owner, uint256 indexed policyId, uint256 amount, uint256 targetPriceE18, uint16 maxSlippageBps);
    event PolicyCancelled(address indexed owner, uint256 indexed policyId);
    event PolicyExecuted(address indexed owner, uint256 indexed policyId, uint256 spotPriceE18, uint256 amountIn, uint256 amountOut);

    constructor(IERC20 asset_, IERC20 stable_, IEoaTakeProfitPoolV3 pool_, address keeper_) {
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

    function createPolicy(uint256 amount, uint256 targetPriceE18, uint16 maxSlippageBps) external returns (uint256 policyId) {
        if (amount == 0 || targetPriceE18 == 0 || maxSlippageBps > 1_000) revert InvalidConfiguration();
        if (activePolicyCount[msg.sender] >= MAX_ACTIVE_POLICIES_PER_OWNER) revert TooManyPolicies();
        uint256 required = activeAmount[msg.sender] + amount;
        uint256 available = asset.balanceOf(msg.sender);
        if (available < required) revert InsufficientWalletBalance(available, required);
        uint256 allowed = asset.allowance(msg.sender, address(this));
        if (allowed < required) revert InsufficientAllowance(allowed, required);

        policyId = ++policyCount[msg.sender];
        policies[msg.sender][policyId] = Policy({amount: amount, targetPriceE18: targetPriceE18, maxSlippageBps: maxSlippageBps, active: true});
        activePolicyCount[msg.sender] += 1;
        activeAmount[msg.sender] = required;
        emit PolicyCreated(msg.sender, policyId, amount, targetPriceE18, maxSlippageBps);
    }

    /// @notice Stops just the selected level and never transfers caller tokens.
    function cancelPolicy(uint256 policyId) external {
        Policy storage policy = policies[msg.sender][policyId];
        if (policy.amount == 0) revert PolicyNotFound();
        if (!policy.active) revert PolicyInactive();
        policy.active = false;
        activePolicyCount[msg.sender] -= 1;
        activeAmount[msg.sender] -= policy.amount;
        emit PolicyCancelled(msg.sender, policyId);
    }

    function executePolicy(address owner, uint256 policyId) external nonReentrant returns (uint256 amountOut) {
        if (msg.sender != keeper) revert UnauthorizedKeeper();
        Policy storage stored = policies[owner][policyId];
        if (stored.amount == 0) revert PolicyNotFound();
        if (!stored.active) revert PolicyInactive();
        Policy memory policy = stored;
        uint256 price = spotPriceE18();
        if (price < policy.targetPriceE18) revert ThresholdNotReached(price, policy.targetPriceE18);
        uint256 available = asset.balanceOf(owner);
        if (available < policy.amount) revert InsufficientWalletBalance(available, policy.amount);
        uint256 allowed = asset.allowance(owner, address(this));
        if (allowed < policy.amount) revert InsufficientAllowance(allowed, policy.amount);

        stored.active = false;
        activePolicyCount[owner] -= 1;
        activeAmount[owner] -= policy.amount;
        asset.safeTransferFrom(owner, address(this), policy.amount);
        uint256 quote = pool.getAmountOut(asset, policy.amount);
        uint256 minimum = quote * (BPS_DENOMINATOR - policy.maxSlippageBps) / BPS_DENOMINATOR;
        asset.forceApprove(address(pool), policy.amount);
        amountOut = pool.swap(asset, policy.amount, minimum, owner);
        asset.forceApprove(address(pool), 0);
        emit PolicyExecuted(owner, policyId, price, policy.amount, amountOut);
    }

    function spotPriceE18() public view returns (uint256) {
        (uint256 assetReserve, uint256 stableReserve) = pool.getReserves();
        if (assetReserve == 0 || stableReserve == 0) revert InvalidConfiguration();
        return Math.mulDiv(stableReserve, assetScale * 1e18, assetReserve * stableScale);
    }
}
