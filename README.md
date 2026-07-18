# Take Profit — autonomous exits on Monad Testnet

**Set price targets once. Keep tokens in your MetaMask wallet until execution.**

Take Profit is a Monad Testnet MVP for creating several independent take-profit levels for an ERC-20 asset. When the pool price reaches a target, a 24/7 keeper executes the matching level, swaps the selected token into USDm, records the settlement, and sends a Telegram notification.

> Hackathon build for [@buildanythingso](https://x.com/buildanythingso) Spark Hackathon. Testnet only — not audited and not production financial software.

## Why it exists

Taking profit is often manual: users need to watch the market, calculate a safe sell price, and react quickly. Take Profit turns that into explicit, independently cancellable levels.

Example: create three JAMES rules at 14.5, 15 and 16 USDm. If price jumps directly to 18 USDm, the keeper can execute all eligible active levels in the same monitoring cycle.

## What works in the MVP

- Connect MetaMask to **Monad Testnet**.
- Read live wallet balances and pool prices for MON, JAMES, EMO, CHOG and USDm.
- Create up to **100 active take-profit levels** per owner on the V3 executor.
- Set target price, exact sell amount and slippage.
- See calculated **Minimum sell price**: `target price × (1 − slippage / 100)`.
- Keep the sell tokens in the user wallet until the rule executes; the executor has only the ERC-20 allowance needed for active levels.
- Cancel one level without cancelling the other levels.
- Filter rules: All, Active, Cancelled and Completed.
- Run a VM-hosted keeper every 10 seconds, with Telegram notifications and execution history.
- Let demo users claim a limited bundle of test USDm, JAMES, EMO, and CHOG once every four hours; MON remains available only through the official Monad Faucet.
- Use automatic gas tiers: `500k → 1m → 2m → 3m → 4m`. The keeper selects the smallest tier that covers a pre-flight estimate, because Monad charges the submitted gas limit.

## How a rule works

1. The user chooses an asset, target price, amount to sell and slippage.
2. MetaMask approves the executor for the aggregate amount reserved by active rules.
3. MetaMask creates the rule on-chain. The rule stores the amount, target price and slippage.
4. The keeper monitors the on-chain price. It simulates before broadcasting.
5. Once the target is reached, the executor transfers only that rule's amount from the wallet, swaps it through the configured pool, and sends USDm back to the wallet.
6. The UI moves the level to **Completed**, adds a settlement record and links to MonadVision. Telegram receives the same settlement details.

The keeper never blindly resubmits a transaction after broadcast: the first transaction may already be pending or mined.

## Safety model and limitations

- This is **Monad Testnet only**. Do not use real funds.
- The contract is not audited.
- Slippage is enforced in the executor when it calculates the pool's minimum output. A price can move between a keeper check and settlement; the swap reverts instead of accepting output below the configured minimum.
- On Monad, the submitted gas limit is charged. The keeper uses a bounded tier rather than always sending the maximum.
- If a pre-flight gas estimate exceeds 4,000,000, the keeper does not send a transaction and reports the issue once in Telegram.
- The keeper key is stored only in the ignored server `.env` file. Never commit or share it.

## Monad Testnet deployment and proof

| Item | Value |
| --- | --- |
| Network | Monad Testnet (`10143`) |
| V3 JAMES executor | [`0x7f70a1640cf8b6436b219c52c8492e8798031167`](https://testnet.monadvision.com/address/0x7f70a1640cf8b6436b219c52c8492e8798031167) |
| JAMES token | `0x8f32e211244706c9b0902a9bd823e1c768a032c2` |
| USDm token | `0x0f1471d41e25e7880a3c3021dfcb5efb29079f71` |

Confirmed keeper executions:

- [JAMES V3 #1 — sold 3 JAMES](https://testnet.monadvision.com/tx/0x80840846df266e82e51d940db7de22f51783f9c9acc1370eaa7941bf2ce21315)
- [JAMES V3 #2 — sold 5 JAMES](https://testnet.monadvision.com/tx/0x9cda3c16caeb3c2ed90d1c40acae930408e6f42346c2222754a9a172bfb8981d)

## Local setup

Requirements: Node.js 22+, MetaMask configured for Monad Testnet, and a funded test wallet.

```bash
npm install
npm run deploy:ui
```

Open `http://localhost:5173`.

To build the static UI:

```bash
npm run build:deploy-ui
```

For the public hackathon deployment (Cloudflare Pages frontend + existing
Google Cloud keeper/faucet VM), follow
[the Cloudflare Pages deployment guide](docs/CLOUDFLARE_PAGES_DEPLOY.md).

## Keeper operations

The keeper is designed to run on an Ubuntu VM through `systemd`, not on the user's computer. Its health endpoint can be exposed through HTTPS for UI status checks.

Useful commands during local development:

```bash
npm run keeper:dry-run
npm run keeper:watch
npm run keeper:telegram-test
```

See [keeper/README.md](keeper/README.md) for the operational environment variables and service notes. Keep `.env` private.

## Repository map

- [contracts/EoaTakeProfitExecutorV3.sol](contracts/EoaTakeProfitExecutorV3.sol) — multi-level executor with a 100-active-rule limit.
- [web/src/main.ts](web/src/main.ts) — Vite frontend, wallet flow, rule management and execution history.
- [keeper/index.mjs](keeper/index.mjs) — monitoring, bounded gas selection, settlement recording and Telegram messages.
- [keeper/health-server.mjs](keeper/health-server.mjs) — HTTPS health/status service.

## Demo checklist

1. Connect MetaMask on Monad Testnet.
2. Create two or three small JAMES levels above the current price.
3. Use Demo market controls to move the price above all targets.
4. Wait for the keeper cycle.
5. Open **Completed**, **Execution history** and Telegram to verify settlement details and MonadVision links.

## Submission links

- Live demo: **add public HTTPS URL before submitting**
- Demo video: **add link before submitting**
- Repository: this repository
