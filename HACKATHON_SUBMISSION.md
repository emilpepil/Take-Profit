# Spark Hackathon submission copy

Replace only the two bracketed links before submitting.

## Project name

Take Profit

## Tagline

Autonomous, multi-level take-profit exits on Monad Testnet — with tokens remaining in the user's wallet until execution.

## Short description

Take Profit lets a user create several independent sell levels for an asset. A VM-hosted keeper monitors Monad Testnet, executes every reached level, swaps into USDm with slippage protection, records settlement history and sends Telegram confirmations.

## Full project description

Take Profit is a Monad Testnet automation MVP for the moment when users want to lock in gains without watching a chart all day.

Users connect MetaMask, choose a token, define an exact amount to sell, a target price and a slippage tolerance. The app calculates the minimum sell price automatically. Each level is independent: users can create up to 100 active levels, cancel a single level without affecting others, and inspect Active, Cancelled and Completed rules separately.

Tokens stay in the user's MetaMask wallet while a rule waits. The V3 executor receives only the ERC-20 allowance required for all active levels. When the target is reached, the keeper performs a pre-flight simulation, chooses the smallest safe Monad gas tier, calls the executor, and the executor swaps the selected amount into USDm. The execution history shows time, sold amount, average sale price, USDm received and a MonadVision transaction link. Telegram sends the same settlement information.

The keeper is deployed independently on a Google Cloud VM, so automation does not depend on the user's browser or computer remaining open.

This submission is intentionally testnet-only and not audited.

## Why Monad

Take-profit automation benefits from fast, low-latency execution and a simple EVM-compatible wallet flow. Monad Testnet let us build an on-chain multi-level executor, a keeper-driven execution loop and a real-time user experience using MetaMask and standard EVM tooling.

Monad also makes gas-limit discipline important: the submitted gas limit is charged. Our keeper therefore estimates before broadcast and chooses the first adequate tier from 500k, 1m, 2m, 3m and 4m, rather than always using the maximum.

## Key features

- Multi-level take-profit: up to 100 active levels per wallet.
- Exact sell amount and target price for each level.
- On-chain slippage protection and calculated minimum sell price.
- One-level cancellation; completed and cancelled rules free active slots.
- Autonomous VM keeper with pre-flight simulation.
- Bounded automatic gas tiers and one-time Telegram alerts for failures.
- Completed-rule history with average sale price, USDm received, UTC time and MonadVision link.
- Real confirmed Monad Testnet executions.

## Architecture

- Frontend: Vite + TypeScript + viem + MetaMask.
- Smart contracts: Solidity 0.8.28, OpenZeppelin SafeERC20 and ReentrancyGuard.
- Keeper: Node.js process managed by systemd on Google Cloud VM.
- Notifications: Telegram Bot API.
- Network: Monad Testnet, chain ID 10143.

## Evidence of working execution

- V3 executor: [`0x7f70a1640cf8b6436b219c52c8492e8798031167`](https://testnet.monadvision.com/address/0x7f70a1640cf8b6436b219c52c8492e8798031167)
- [Rule #1 execution — 3 JAMES](https://testnet.monadvision.com/tx/0x80840846df266e82e51d940db7de22f51783f9c9acc1370eaa7941bf2ce21315)
- [Rule #2 execution — 5 JAMES](https://testnet.monadvision.com/tx/0x9cda3c16caeb3c2ed90d1c40acae930408e6f42346c2222754a9a172bfb8981d)

## Links to submit

- Live demo: `[PUBLIC_DEMO_URL]`
- Demo video: `[DEMO_VIDEO_URL]`
- Source code: `[GITHUB_REPOSITORY_URL]`

## Suggested demo video script (90 seconds)

1. **0–15 sec:** “Take Profit automates multi-level exits on Monad Testnet while tokens stay in the user's wallet until a rule executes.”
2. **15–35 sec:** Connect MetaMask, show live balances and create two small JAMES rules with different targets.
3. **35–50 sec:** Open Rule settings. Show slippage and the calculated minimum sell price.
4. **50–65 sec:** Move the demo market price above both targets.
5. **65–80 sec:** Show the keeper status changing to Completed and the execution history with average price, received USDm and MonadVision links.
6. **80–90 sec:** Show Telegram confirmations and finish with the executor address / testnet disclaimer.

## Optional X post

Building **Take Profit** for @buildanythingso Spark Hackathon ⚡

Multi-level take-profit automation on Monad Testnet: create independent sell levels, keep tokens in MetaMask until execution, let a VM keeper monitor price targets, and receive USDm settlement + Telegram confirmations.

Real Testnet executions, execution history, slippage protection, and a bounded gas strategy. More soon.
