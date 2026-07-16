// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ISerialSimplePool {
    function token0() external view returns (IERC20);
    function token1() external view returns (IERC20);
    function getReserves() external view returns (uint256, uint256);
    function getAmountOut(IERC20 tokenIn, uint256 amountIn) external view returns (uint256);
    function swap(IERC20 tokenIn, uint256 amountIn, uint256 minAmountOut, address recipient) external returns (uint256);
}

/// @notice Safe-owned vault with a separately constrained keeper automation path.
/// @dev Deploy only with a Safe as owner. Existing PolicyVault deployments are not upgradeable.
contract SerialPolicyVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;

    enum Action { TakeProfit, Rebalance }

    IERC20 public immutable asset;
    IERC20 public immutable stable;
    ISerialSimplePool public immutable pool;
    uint256 public immutable assetScale;
    uint256 public immutable stableScale;

    address public keeper;
    uint256 public takeProfitPriceE18;
    uint256 public rebalancePriceE18;
    uint16 public tradeBps;
    uint16 public maxSlippageBps;

    bool public automationEnabled;
    uint16 public maxExecutionsPerDay;
    uint48 public cooldownSeconds;
    uint48 public lastAutomationExecutionAt;
    mapping(uint256 day => uint16 executions) public automationExecutionsByDay;

    error Unauthorized();
    error InvalidPool();
    error InvalidPolicy();
    error InvalidTokenDecimals();
    error InvalidAmount();
    error PolicyNotActionable(uint256 spotPriceE18);
    error AutomationDisabled();
    error CooldownActive(uint256 nextExecutionAt);
    error DailyExecutionLimitReached(uint256 day, uint16 limit);

    event Funded(address indexed owner, uint256 assetAmount, uint256 stableAmount);
    event PolicyExecuted(Action indexed action, uint256 spotPriceE18, uint256 amountIn, uint256 amountOut);
    event PolicyUpdated(uint256 takeProfitPriceE18, uint256 rebalancePriceE18, uint16 tradeBps, uint16 maxSlippageBps);
    event KeeperUpdated(address indexed keeper);
    event AutomationConfigUpdated(bool enabled, uint16 maxExecutionsPerDay, uint48 cooldownSeconds);
    event AutomationExecuted(uint256 indexed day, uint16 executionNumber, Action indexed action, uint256 amountOut);

    constructor(
        IERC20 asset_, IERC20 stable_, ISerialSimplePool pool_, address owner_, address keeper_,
        uint256 takeProfitPriceE18_, uint256 rebalancePriceE18_, uint16 tradeBps_, uint16 maxSlippageBps_
    ) Ownable(owner_) {
        if (address(asset_) == address(0) || address(stable_) == address(0) || address(pool_) == address(0) || owner_ == address(0)) revert InvalidPolicy();
        if (pool_.token0() != asset_ || pool_.token1() != stable_) revert InvalidPool();
        uint8 assetDecimals = IERC20Metadata(address(asset_)).decimals();
        uint8 stableDecimals = IERC20Metadata(address(stable_)).decimals();
        if (assetDecimals > 18 || stableDecimals > 18) revert InvalidTokenDecimals();
        asset = asset_;
        stable = stable_;
        pool = pool_;
        assetScale = 10 ** assetDecimals;
        stableScale = 10 ** stableDecimals;
        keeper = keeper_;
        _setPolicy(takeProfitPriceE18_, rebalancePriceE18_, tradeBps_, maxSlippageBps_);
    }

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert Unauthorized();
        _;
    }

    function fund(uint256 assetAmount, uint256 stableAmount) external onlyOwner nonReentrant {
        if (assetAmount == 0 && stableAmount == 0) revert InvalidAmount();
        if (assetAmount != 0) asset.safeTransferFrom(msg.sender, address(this), assetAmount);
        if (stableAmount != 0) stable.safeTransferFrom(msg.sender, address(this), stableAmount);
        emit Funded(msg.sender, assetAmount, stableAmount);
    }

    /// @notice Safe-only manual route. It never bypasses the Safe.
    function executePolicy() external onlyOwner nonReentrant returns (Action action, uint256 amountOut) {
        return _executePolicy();
    }

    /// @notice Keeper-only route. It is usable only after a Safe-approved configuration transaction.
    function executeAutomation() external onlyKeeper nonReentrant returns (Action action, uint256 amountOut) {
        if (!automationEnabled) revert AutomationDisabled();
        if (block.timestamp < uint256(lastAutomationExecutionAt) + cooldownSeconds) {
            revert CooldownActive(uint256(lastAutomationExecutionAt) + cooldownSeconds);
        }
        uint256 day = block.timestamp / 1 days;
        uint16 executions = automationExecutionsByDay[day];
        if (executions >= maxExecutionsPerDay) revert DailyExecutionLimitReached(day, maxExecutionsPerDay);

        (action, amountOut) = _executePolicy();
        uint16 executionNumber = executions + 1;
        automationExecutionsByDay[day] = executionNumber;
        lastAutomationExecutionAt = uint48(block.timestamp);
        emit AutomationExecuted(day, executionNumber, action, amountOut);
    }

    /// @notice Must be called by the Safe owner, which is the explicit on-chain approval for serial automation.
    function setAutomationConfig(bool enabled, uint16 maxExecutionsPerDay_, uint48 cooldownSeconds_) external onlyOwner {
        if (enabled && (maxExecutionsPerDay_ == 0 || maxExecutionsPerDay_ > 24 || cooldownSeconds_ < 30 || cooldownSeconds_ > 1 days)) revert InvalidPolicy();
        automationEnabled = enabled;
        maxExecutionsPerDay = maxExecutionsPerDay_;
        cooldownSeconds = cooldownSeconds_;
        emit AutomationConfigUpdated(enabled, maxExecutionsPerDay_, cooldownSeconds_);
    }

    function spotPriceE18() public view returns (uint256) {
        (uint256 assetReserve, uint256 stableReserve) = pool.getReserves();
        if (assetReserve == 0 || stableReserve == 0) revert InvalidAmount();
        return Math.mulDiv(stableReserve, assetScale * 1e18, assetReserve * stableScale);
    }

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit KeeperUpdated(keeper_);
    }

    function setPolicy(uint256 takeProfitPriceE18_, uint256 rebalancePriceE18_, uint16 tradeBps_, uint16 maxSlippageBps_) external onlyOwner {
        _setPolicy(takeProfitPriceE18_, rebalancePriceE18_, tradeBps_, maxSlippageBps_);
    }

    function withdraw(IERC20 token, uint256 amount, address recipient) external onlyOwner nonReentrant {
        if (recipient == address(0) || amount == 0) revert InvalidAmount();
        token.safeTransfer(recipient, amount);
    }

    function _executePolicy() private returns (Action action, uint256 amountOut) {
        uint256 price = spotPriceE18();
        IERC20 tokenIn;
        uint256 amountIn;
        if (price >= takeProfitPriceE18) {
            action = Action.TakeProfit;
            tokenIn = asset;
            amountIn = asset.balanceOf(address(this)) * tradeBps / BPS_DENOMINATOR;
        } else if (price <= rebalancePriceE18) {
            action = Action.Rebalance;
            tokenIn = stable;
            amountIn = stable.balanceOf(address(this)) * tradeBps / BPS_DENOMINATOR;
        } else {
            revert PolicyNotActionable(price);
        }
        if (amountIn == 0) revert InvalidAmount();
        uint256 quote = pool.getAmountOut(tokenIn, amountIn);
        uint256 minAmountOut = quote * (BPS_DENOMINATOR - maxSlippageBps) / BPS_DENOMINATOR;
        tokenIn.forceApprove(address(pool), amountIn);
        amountOut = pool.swap(tokenIn, amountIn, minAmountOut, address(this));
        tokenIn.forceApprove(address(pool), 0);
        emit PolicyExecuted(action, price, amountIn, amountOut);
    }

    function _setPolicy(uint256 takeProfitPriceE18_, uint256 rebalancePriceE18_, uint16 tradeBps_, uint16 maxSlippageBps_) private {
        if (takeProfitPriceE18_ <= rebalancePriceE18_ || rebalancePriceE18_ == 0 || tradeBps_ == 0 || tradeBps_ > BPS_DENOMINATOR || maxSlippageBps_ > 1_000) revert InvalidPolicy();
        takeProfitPriceE18 = takeProfitPriceE18_;
        rebalancePriceE18 = rebalancePriceE18_;
        tradeBps = tradeBps_;
        maxSlippageBps = maxSlippageBps_;
        emit PolicyUpdated(takeProfitPriceE18_, rebalancePriceE18_, tradeBps_, maxSlippageBps_);
    }
}
