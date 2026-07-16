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
