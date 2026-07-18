# Keeper dry-run and watch

Run `npm run keeper:dry-run` from the project root. It reads the configured Monad Testnet vaults and reports whether a take-profit or rebalance action is currently ready.

The script only uses a public RPC client. It never creates, signs, or broadcasts a transaction. The keeper key is checked only to make sure it belongs to the assigned test keeper address.

It refuses any chain other than Monad Testnet (10143). Keep `KEEPER_PRIVATE_KEY` in the ignored `.env` file only.

To keep checking locally, run `npm run keeper:watch`. The default interval is 10 seconds. Set `KEEPER_POLL_INTERVAL_SECONDS` in `.env` to a whole number of seconds no lower than 10. Stop the monitor with `Ctrl+C`.

## Demo Faucet

The health API also exposes a testnet-only Demo Faucet. It transfers a fixed bundle of USDm, JAMES, EMO, and CHOG after the wallet signs a claim message; the signature is only proof of address ownership and never grants token spending approval. Claims are stored server-side and limited to one bundle per wallet every four hours. MON is deliberately excluded: users obtain it from the official Monad Faucet.

Configure a separately funded, testnet-only wallet by copying `take-profit-faucet.env.example` outside the repository to `/home/mongangstudio/take-profit-faucet.env`, set its key and `DEMO_FAUCET_ENABLED=true`, then restart `take-profit-keeper-health`. Do not reuse the keeper, deployer, or personal wallet key. The faucet wallet needs a small MON balance for transfer gas and the four demo-token balances.

## Optional Telegram alerts

The monitor can send one Telegram alert when a vault first reaches a ready take-profit or rebalance state. It does not repeat that alert on every polling cycle. When the vault returns to `no action`, the alert is armed again for the next threshold crossing.

Create a bot with `@BotFather`, open a private chat with that bot and send it `/start`. Then add these values to the ignored `.env` file:

```env
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_private_chat_id
KEEPER_TELEGRAM_ENABLED=true
```

Telegram requires that a user contacts a bot before the bot can message that private user. The Bot API `sendMessage` method uses the chat ID and message text configured above. See the official [Telegram bot tutorial](https://core.telegram.org/bots/tutorial) and [Bot API](https://core.telegram.org/bots/api#sendmessage).

`keeper/state.json` is created locally to prevent duplicate alerts and is ignored by Git. A local notification lock also prevents duplicate alerts if checks overlap. Alerts remain read-only: this service never creates, signs, or broadcasts a trade.

Verify the Telegram connection without querying Monad or using a wallet:

```bash
npm run keeper:telegram-test
```

## Independent Windows launch

`keeper/run-local.cmd` starts the read-only watcher outside Codex. It loads secrets only from the local ignored `.env` file and writes operational output to the ignored `keeper/watch.log` file.

To run it manually, double-click `keeper/run-local.cmd`, or run it from a terminal. To keep it available after restarting the computer, create a Windows Task Scheduler task that runs this file at logon. The task must run under your Windows account because that account has access to the project folder and its `.env` file.

The scheduled watcher still does not send blockchain transactions. It only calls the public Monad Testnet RPC and Telegram Bot API when an alert condition is reached.

## One-time automatic JAMES test (Monad Testnet only)

Automatic execution is deliberately disabled by default. To arm exactly one automatic JAMES execution, add all four values below to the ignored VPS `.env` file, then restart the service:

```env
AUTO_EXECUTE=true
AUTO_EXECUTE_CONFIRMATION=MONAD_TESTNET_JAMES_ONCE
AUTO_EXECUTE_SYMBOL=JAMES
AUTO_EXECUTE_MAX_GAS=300000
```

The keeper refuses every symbol other than JAMES, simulates `executePolicy()` before signing, estimates gas and adds only a 10% buffer. It refuses to broadcast if that limit exceeds `AUTO_EXECUTE_MAX_GAS`. On Monad the gas limit is the amount charged, so do not raise the cap casually.

## V2 rule execution safety

For a multi-level V2 rule, the keeper must be armed with one explicit policy ID, an exact maximum token amount, and a per-run gas cap. It retries only **RPC reads, simulation, and gas estimation** before a transaction is broadcast. It never blindly resubmits after broadcast because the first transaction may already be pending or mined.

When Telegram is enabled, the keeper sends short messages for these outcomes:

- RPC temporarily limited — no transaction was sent; the next safe check will retry;
- estimated gas above the configured rule cap — no transaction was sent;
- transaction confirmed — includes the MonadVision link and actual configured gas limit.

The on-chain V2 policy already stores its own `maxSlippageBps`; swaps revert if the received amount is below that policy's minimum. The current JAMES rules use 1% slippage. Each new rule can also save a `Max keeper gas` value through the local SSH tunnel: the owner signs that setting in MetaMask, the keeper accepts only owner-signed values between 21,000 and 500,000, and applies the lower of that per-rule cap and its server-side cap. Gas limits remain off-chain keeper safeguards: they do not change the swap price and cannot be raised after broadcast.

After one confirmed execution, `keeper/auto-execution-state.json` prevents any second automatic trade, including after a VPS restart. It is ignored by Git. Telegram receives the transaction link only after confirmation. To return to observation-only mode, remove or set `AUTO_EXECUTE=false` and restart the service.

## Planned serial automation: Safe approval required

`SerialPolicyVault.sol` is a separate, not-yet-deployed contract for the later serial mode. It is not an upgrade of the three existing vaults and cannot spend their funds. Its Safe owner must call `setAutomationConfig(...)` before a keeper can execute anything automatically. That on-chain Safe transaction defines all three limits: enabled/disabled, a maximum of 1–24 executions per UTC day, and a 30-second to 24-hour cooldown.

The Safe remains the only account permitted to execute a manual policy, change policy thresholds, change the keeper, change automation limits, or withdraw funds. The keeper gets only `executeAutomation()`, which checks the Safe-approved limits on-chain before each swap. Deploying or migrating to this contract is intentionally a later, separately approved step.

## Ubuntu VPS service

For an independent 24/7 Ubuntu VPS, install Node.js 22 and Git, clone this repository, then create the ignored `.env` file on the server with the same Monad Testnet, keeper, and Telegram settings used locally. Restrict it to the server account:

```bash
chmod 600 .env
```

Run the following installer from the project root:

```bash
bash scripts/install-keeper-service.sh
```

It installs a `systemd` service that starts at VPS boot and restarts the read-only watcher if it fails. Check it with:

```bash
sudo systemctl status take-profit-keeper
sudo journalctl -u take-profit-keeper -f
```

Stop it at any time with:

```bash
sudo systemctl disable --now take-profit-keeper
```
