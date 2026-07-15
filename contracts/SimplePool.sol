// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SimplePool
/// @notice A deliberately small constant-product AMM for the Take Profit testnet demo.
/// @dev This contract is not yet a general-purpose production DEX: it has no LP shares,
///      protocol fees, or support for fee-on-transfer/rebasing tokens.
contract SimplePool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant FEE_BPS = 30;
    uint256 private constant BPS_DENOMINATOR = 10_000;

    IERC20 public immutable token0;
    IERC20 public immutable token1;

    uint256 private reserve0;
    uint256 private reserve1;

    error InvalidToken();
    error InvalidAmount();
    error InvalidRecipient();
    error InsufficientLiquidity();
    error SlippageExceeded(uint256 minimumAmountOut, uint256 actualAmountOut);

    event LiquidityAdded(address indexed provider, uint256 amount0, uint256 amount1);
    event Swap(
        address indexed sender,
        address indexed tokenIn,
        uint256 amountIn,
        uint256 amountOut,
        address recipient
    );

    constructor(IERC20 token0_, IERC20 token1_) {
        if (address(token0_) == address(0) || address(token1_) == address(0) || token0_ == token1_) {
            revert InvalidToken();
        }

        token0 = token0_;
        token1 = token1_;
    }

    /// @notice Supplies both assets to seed or deepen the demo pool.
    /// @dev The credited amounts are measured from balances after transfer.
    function addLiquidity(uint256 amount0Desired, uint256 amount1Desired) external nonReentrant {
        if (amount0Desired == 0 || amount1Desired == 0) revert InvalidAmount();

        token0.safeTransferFrom(msg.sender, address(this), amount0Desired);
        token1.safeTransferFrom(msg.sender, address(this), amount1Desired);

        uint256 balance0 = token0.balanceOf(address(this));
        uint256 balance1 = token1.balanceOf(address(this));
        uint256 amount0 = balance0 - reserve0;
        uint256 amount1 = balance1 - reserve1;

        if (amount0 == 0 || amount1 == 0) revert InvalidAmount();

        _updateReserves(balance0, balance1);
        emit LiquidityAdded(msg.sender, amount0, amount1);
    }

    /// @notice Returns the current stored reserves in token0/token1 order.
    function getReserves() external view returns (uint256, uint256) {
        return (reserve0, reserve1);
    }

    /// @notice Quotes output after the pool's 0.30% fee using the current reserves.
    function getAmountOut(IERC20 tokenIn, uint256 amountIn) public view returns (uint256 amountOut) {
        if (amountIn == 0) revert InvalidAmount();

        (uint256 reserveIn, uint256 reserveOut) = _reservesFor(tokenIn);
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();

        uint256 amountInWithFee = amountIn * (BPS_DENOMINATOR - FEE_BPS);
        amountOut = (reserveOut * amountInWithFee) / (reserveIn * BPS_DENOMINATOR + amountInWithFee);
    }

    /// @notice Swaps an exact input amount for the other pool asset.
    /// @param minAmountOut User protection against price movement.
    function swap(IERC20 tokenIn, uint256 amountIn, uint256 minAmountOut, address recipient)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert InvalidAmount();
        if (recipient == address(0)) revert InvalidRecipient();

        (uint256 reserveIn, uint256 reserveOut) = _reservesFor(tokenIn);
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();

        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 actualAmountIn = tokenIn.balanceOf(address(this)) - reserveIn;
        amountOut = _amountOut(actualAmountIn, reserveIn, reserveOut);

        if (amountOut < minAmountOut) revert SlippageExceeded(minAmountOut, amountOut);

        IERC20 tokenOut = tokenIn == token0 ? token1 : token0;
        tokenOut.safeTransfer(recipient, amountOut);

        _updateReserves(token0.balanceOf(address(this)), token1.balanceOf(address(this)));
        emit Swap(msg.sender, address(tokenIn), actualAmountIn, amountOut, recipient);
    }

    function _amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        private
        pure
        returns (uint256)
    {
        uint256 amountInWithFee = amountIn * (BPS_DENOMINATOR - FEE_BPS);
        return (reserveOut * amountInWithFee) / (reserveIn * BPS_DENOMINATOR + amountInWithFee);
    }

    function _reservesFor(IERC20 tokenIn) private view returns (uint256 reserveIn, uint256 reserveOut) {
        if (tokenIn == token0) return (reserve0, reserve1);
        if (tokenIn == token1) return (reserve1, reserve0);
        revert InvalidToken();
    }

    function _updateReserves(uint256 balance0, uint256 balance1) private {
        reserve0 = balance0;
        reserve1 = balance1;
    }
}

