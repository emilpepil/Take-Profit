# Keeper dry-run and watch

Run `npm run keeper:dry-run` from the project root. It reads the configured Monad Testnet vaults and reports whether a take-profit or rebalance action is currently ready.

The script only uses a public RPC client. It never creates, signs, or broadcasts a transaction. The keeper key is checked only to make sure it belongs to the assigned test keeper address.

It refuses any chain other than Monad Testnet (10143). Keep `KEEPER_PRIVATE_KEY` in the ignored `.env` file only.

To keep checking locally, run `npm run keeper:watch`. The default interval is 30 seconds. Set `KEEPER_POLL_INTERVAL_SECONDS` in `.env` to a whole number of seconds no lower than 10. Stop the monitor with `Ctrl+C`.
