# Keeper dry-run and watch

Run `npm run keeper:dry-run` from the project root. It reads the configured Monad Testnet vaults and reports whether a take-profit or rebalance action is currently ready.

The script only uses a public RPC client. It never creates, signs, or broadcasts a transaction. The keeper key is checked only to make sure it belongs to the assigned test keeper address.

It refuses any chain other than Monad Testnet (10143). Keep `KEEPER_PRIVATE_KEY` in the ignored `.env` file only.

To keep checking locally, run `npm run keeper:watch`. The default interval is 30 seconds. Set `KEEPER_POLL_INTERVAL_SECONDS` in `.env` to a whole number of seconds no lower than 10. Stop the monitor with `Ctrl+C`.

## Optional Telegram alerts

The monitor can send one Telegram alert when a vault first reaches a ready take-profit or rebalance state. It does not repeat that alert on every polling cycle. When the vault returns to `no action`, the alert is armed again for the next threshold crossing.

Create a bot with `@BotFather`, open a private chat with that bot and send it `/start`. Then add these values to the ignored `.env` file:

```env
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_private_chat_id
KEEPER_TELEGRAM_ENABLED=true
```

Telegram requires that a user contacts a bot before the bot can message that private user. The Bot API `sendMessage` method uses the chat ID and message text configured above. See the official [Telegram bot tutorial](https://core.telegram.org/bots/tutorial) and [Bot API](https://core.telegram.org/bots/api#sendmessage).

`keeper/state.json` is created locally to prevent duplicate alerts and is ignored by Git. Alerts remain read-only: this service never creates, signs, or broadcasts a trade.

Verify the Telegram connection without querying Monad or using a wallet:

```bash
npm run keeper:telegram-test
```

## Independent Windows launch

`keeper/run-local.cmd` starts the read-only watcher outside Codex. It loads secrets only from the local ignored `.env` file and writes operational output to the ignored `keeper/watch.log` file.

To run it manually, double-click `keeper/run-local.cmd`, or run it from a terminal. To keep it available after restarting the computer, create a Windows Task Scheduler task that runs this file at logon. The task must run under your Windows account because that account has access to the project folder and its `.env` file.

The scheduled watcher still does not send blockchain transactions. It only calls the public Monad Testnet RPC and Telegram Bot API when an alert condition is reached.

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
