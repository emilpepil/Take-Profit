# Publish Take Profit with Cloudflare Pages

This document publishes only the static Vite interface. The autonomous keeper,
Demo Faucet, Telegram link service, private keys, and bot token remain on the
Google Cloud VM.

## 1. Check the public build locally

From the repository root:

```powershell
npm.cmd run build:deploy-ui
```

The publish directory must be `web/dist`.

## 2. Create the Pages project

1. Open [Cloudflare Pages](https://dash.cloudflare.com/).
2. Choose **Workers & Pages** -> **Create** -> **Pages** -> **Connect to Git**.
3. Authorize GitHub, then select the Take Profit repository.
4. Use these build settings:

   | Setting | Value |
   | --- | --- |
   | Production branch | `main` |
   | Root directory | leave empty (repository root) |
   | Build command | `npm run build:deploy-ui` |
   | Build output directory | `web/dist` |
   | Node.js version | `22` |

5. Do not add any private key, Telegram bot token, seed phrase, or server `.env`
   value to Cloudflare Pages.

Cloudflare will give the project a URL such as
`https://take-profit.pages.dev`. Keep this exact URL for the next step.

## 3. Add the public frontend variables

In **Settings** -> **Environment variables** -> **Production**, add exactly:

| Name | Current value |
| --- | --- |
| `VITE_KEEPER_HEALTH_URL` | `https://34.55.12.195.nip.io/health` |
| `VITE_DEMO_FAUCET_URL` | `https://34.55.12.195.nip.io/faucet` |
| `VITE_TELEGRAM_LINK_URL` | `https://34.55.12.195.nip.io/telegram` |

These values are intentionally public: a browser must call these HTTPS API
routes. They are not credentials. The committed reference is
[`web/.env.production.example`](../web/.env.production.example).

Add the same variables to **Preview** only if you plan to test pull-request
preview URLs. Each preview URL must also be explicitly allowed by the VM CORS
configuration.

## 4. Allow the published site on the VM (CORS)

The server already rejects unapproved browser origins. Add the exact Pages URL
to the comma-separated `DEMO_FAUCET_ALLOWED_ORIGINS` value in the VM's existing
faucet environment file. Keep localhost entries while local development is
still useful.

Example only -- replace the Pages URL with your real project URL:

```env
DEMO_FAUCET_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,https://take-profit.pages.dev
```

On the VM:

```bash
sudo nano /home/mongangstudio/take-profit-faucet.env
sudo systemctl restart take-profit-keeper-health
sudo systemctl is-active take-profit-keeper-health
```

The final command must return `active`.

Do not paste the environment file into chat and do not change any private-key
or Telegram values while making this edit.

## 5. Deploy and test

Click **Save and Deploy** in Pages. After it finishes, open the public
`https://...pages.dev` address in a fresh browser tab and test this sequence:

1. Connect MetaMask and switch it to Monad Testnet.
2. Open **Start demo**, then obtain test MON from the official Monad Faucet.
3. Claim a Demo Faucet bundle and add demo tokens to MetaMask.
4. Connect Telegram from the Demo Faucet block and press **Start** in the bot.
5. Create a small take-profit rule.
6. Use Demo market controls to move the price through the target.
7. Wait for keeper monitoring, then verify **Completed**, execution history,
   USDm returned to MetaMask, the MonadVision link, and the Telegram message.

If a browser call fails with a CORS error, verify that the Pages URL in the
browser matches the origin added to `DEMO_FAUCET_ALLOWED_ORIGINS`, including
`https://` and no trailing slash.

## 6. Recommended next hardening

- Keep frontend on Cloudflare Pages and the autonomous keeper on the existing
  VM for this hackathon.
- Use a custom domain later (`app.example.xyz` for Pages and
  `api.example.xyz` for the VM) when the demo needs a stable branded URL.
- Move VM secrets to Google Secret Manager before any production deployment.
- Configure a second Monad RPC endpoint for the keeper, since public testnet
  RPC rate limits can temporarily delay checks.
- Use Git-based Pages deployment: every push to `main` creates a new live
  frontend deployment; use preview deployments before merging changes.
