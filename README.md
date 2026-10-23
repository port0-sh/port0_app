# port0.sh app

Static web application for the port0.sh constant-product AMM on Miden. Users
browse pools, swap, deposit and withdraw liquidity, and create pools. There is
no application framework and no client-side router: each page is a real HTML
document with its own metadata, its own module entry, and a minimal amount of
TypeScript.

## Pages

| Route                    | File           | Purpose                                                       |
| ------------------------ | -------------- | ------------------------------------------------------------- |
| `/`                      | `index.html`   | Browse every registered pool from the indexer                 |
| `/pool.html?id=<poolid>` | `pool.html`    | Pool state, swap, add liquidity, remove liquidity             |
| `/create.html`           | `create.html`  | Deploy a pool and register it                                 |
| `/about.html`            | `about.html`   | What port0 is, and the risk notice                            |
| `/utils.html`            | `utils.html`   | One-time mint and send public note                            |
| `/media.html`            | `media.html`   | Mark, wordmark, colors, type, and the unfurl image            |

Every page carries the same parts: the alpha notice as a strip above the
header, the footer with the copyright year and the social links, and the chart
attribution. The strip shows the text of the selected network. On testnet it is
dismissible, remembered under `port0-app:alpha-risk:v1:testnet`. On mainnet the
strip is permanent and the first visit is gated by a modal that records
acceptance under `port0-app:alpha-risk:v1:mainnet`. The index
adds the hero drawing, the brand heading under it, a link to the launch page, and
the slogan.

Pool ids are canonical account-id hex strings (`AccountId.toString()`), with
or without a `0x` prefix.

## Development

```sh
npm install
npm run dev        # dev server with same-origin gRPC-web RPC proxy
npm test           # vitest, pure-logic unit tests
npm run typecheck  # tsc --noEmit
npm run lint       # oxlint
npm run build      # tsc -b && vite build → dist/
npm run preview    # serve dist/ locally
```

The build output is plain static files (`dist/`): four HTML documents, one
CSS file, one small JS bundle per page, and a shared lazy chunk containing the
Miden SDK. Deploy `dist/` to any static file host.

## Running the stack

See the [runbook](https://docs.port0.sh/operations/runbook.html). It covers the
one-time operator setup (contracts, SDK artifacts, pool code commitment,
registry, indexer, app), deploying a pool through the app, deploying a pool
programmatically, and the failure conditions.

In short, from a fresh checkout: build the contracts, build the SDK and run
`npm run pool:commitment`, run `npm run registry:deploy` (fund the operator
address it prints, then run again), start the indexer with
`PORT0_REGISTRY_ID` set, then start the app with `VITE_REGISTRY_ID` and
`VITE_INDEXER_URL` set. The browser fetches the indexer cross-origin in
development, so the indexer's `INDEXER_ALLOWED_ORIGINS` must list the dev app
origin; the indexer's `.env.example` already lists the Vite ports.

## Configuration

Environment variables are read at build time (`import.meta.env`):

| Variable                       | Default                        | Meaning                                    |
| ------------------------------ | ------------------------------ | ------------------------------------------ |
| `VITE_NETWORK`                 | `testnet`                      | `testnet` or `mainnet`; selects the per-network defaults below |
| `VITE_MIDEN_RPC_URL`           | per network                    | Miden node RPC for on-chain reads          |
| `VITE_CHAIN_FEE_FAUCET_ID`     | per network                    | Faucet of the chain's fee asset            |
| `VITE_PROVER_URL`              | per network                    | `local`, `testnet`, `devnet`, or a remote prover URL |
| `VITE_NOTE_TRANSPORT_URL`      | per network                    | `testnet`, `devnet`, or a remote transport URL, for private notes |
| `VITE_EXPLORER_URL`            | per network                    | Block explorer base; account ids are appended |
| `VITE_PROTOCOL_FEE_RECIPIENT`  | (empty)                        | Platform fee recipient, displayed and required for creation; the on-chain destination lives in the registry |
| `VITE_REGISTRY_ID`             | (empty)                        | On-chain pool registry account; empty skips registration |
| `VITE_REGISTRY_REGISTER_FEE`   | `0`                            | Register note consumption fee, in the registry's fee asset; must match the registry's note fee schedule |
| `VITE_INDEXER_URL`             | (empty)                        | Indexer base URL; empty disables browsing and the pool page |
| `VITE_PARA_API_KEY`            | (empty)                        | Para API key; empty keeps the Para option disabled |
| `VITE_PARA_ENVIRONMENT`        | `BETA`                         | Para environment; `PRODUCTION` for production builds |

`VITE_PROTOCOL_FEE_RECIPIENT` accepts a hex account id or a bech32 address.
It gates pool creation on the create page. The pool's actual protocol fee
destination is `protocol_fee_to` in the registry; the create page reads the
registry's fee policy and builds the pool with the registry's rate.

`VITE_REGISTRY_ID` accepts a hex account id or a bech32 address. When set,
the create flow emits a register note after the pool is deployed. The
register note is a network note consumed by the registry account; registration
is asynchronous, the wallet confirms emission and the node's transaction
builder consumes the note in a later block. `VITE_REGISTRY_REGISTER_FEE` must
match the registry's note fee schedule.

`VITE_INDEXER_URL` is the application's pool source. The home page lists every
pool the indexer serves, and the pool page loads its state and configuration
from it. The indexer reads the on-chain registry for the pool set and each
pool account for reserves, token metadata, and the network note fee schedule.
An empty value disables browsing and the pool page.

## Networks

| Value          | testnet                            | mainnet                                |
| -------------- | ---------------------------------- | -------------------------------------- |
| RPC            | `https://rpc.testnet.miden.io`     | `https://rpc.cedar.miden.io`           |
| Fee faucet     | `0x4cbdcaffe75f0a317482224dae6436` | `0xe69e6ca6e39df1b10c1e5399399feb`     |
| Prover         | `testnet`                          | `https://tx-prover.cedar.miden.io`     |
| Note transport | `testnet`                          | `https://transport.cedar.miden.io`     |
| Explorer       | `https://testnet.midenscan.com/account` | `https://explorer.cedar.miden.io/account` |

The node sends the CORS headers a browser needs, so development and builds talk
to the RPC directly; no proxy is involved. The registry id, the pool code
commitment, and the protocol fee recipient are deployed per network and are not
defaults. The mainnet endpoints were read from the partner network on
2026-10-22.

## Architecture

```
index.html  pool.html  create.html  about.html   one real HTML entry per page
src/styles/global.css                            hand-written stylesheet
src/assets/branding/                             hero.html and logo.html drawings
src/lib/
  brand.ts      branding env values
  client.ts     lazy MidenClient/XykClient singletons (SDK loads on first use)
  config.ts     resolved runtime configuration
  chart.ts      TradingView lightweight-charts candlesticks, imported on demand
  dom.ts        el()/qs()/clear() DOM helpers
  fees.ts       LP fee tiers
  format.ts     bigint-exact amount parsing/formatting, id shortening, bps
  history.ts    exact price ratios and chart series (tested)
  indexer.ts    pool source: indexer fetch plus fee-schedule root mapping
  site.ts       footer year, the alpha notice, and the mainnet gate
  state.ts      ~30-line pub/sub store; the entire state layer
  token.ts      fixed-supply token validation
src/features/
  oneTimeMint.ts    fixed-supply faucet launcher
  sendPublicNote.ts public-note sender
  tokenPicker.ts    wallet-token picker with a manual fallback
src/ui/
  toast.ts      notification stack
  modal.ts      native <dialog> wrapper
src/wallet/
  wallet.ts     unified wallet facade (Bread wired; Para gated)
  ui.ts         header connect button, wallet picker, address chip
src/pages/
  home.ts       pool table from the indexer, 15 s refresh while visible
  pool.ts       state summary, quotes, swap/add/remove, history chart
  create.ts     pool deployment and registration
  about.ts      static page; mounts the wallet control and footer
  media.ts      static page; mounts the wallet control and footer
  utils.ts      one-time mint and send public note
```

The home page never loads the SDK: the table renders from the indexer, and
`toPoolView` is called without note-fee mapping. The Login button is plain HTML plus
a light module; the wallet adapter and the WASM stack behind it load on first
connect. `pool.html` and `create.html` load the SDK lazily on first use, so
every page shell renders without WASM on the critical path.

## Pool registry

Pools come from the on-chain registry. The registry account holds three
storage maps: the accepted pool code commitments, the pool set, and the
ordered asset pair index. A pool is registered by a register note emitted by
the creator after the pool is deployed; the node's transaction builder
consumes it against the registry, and the registry verifies the pool code
commitment and the pool's registry identity by foreign procedure invocation
against the pool's `CodeInspection` component and `get_registry_identity`
procedure.

The SDK performs registration (`registerPool`), and the indexer polls the
registry for the pool set. The app reads everything from the indexer: pool
ids, reserves, token metadata, and the network note fee schedule. There is no
local pool list and no manual import.

The indexer derives token metadata from each faucet's `token_config` slot and
the note fee schedule from the pool's network account: the `fee_asset_id`
value slot and the `basic_constant_fee` fee schedule map. The app maps the
schedule roots to note kinds through the SDK's compiled note scripts.

## Pool list

The home page lists the pools the indexer serves, 50 per page, polled every
15 s while the tab is visible. Each row carries the pair and its short pool id,
the price of one token0 in token1, both reserves, 24-hour volume in both
tokens, the LP fee, and the fee yield with the window it is annualised over.
Rows are ordered by pair name so a row keeps its place between refreshes; a
filter accepts a faucet id, and **Load more** walks the indexer's keyset cursor.
The page needs no chain read and no WASM: prices come from the indexer's
reserves through the same exact bigint arithmetic the pool page uses, and
`toPoolView` is called without note-fee mapping, which is the only reason that
module would import the SDK.

## Pool page

The pool page renders the state summary, the three action forms, and the
indexer's sampled history. A pool is absent from the indexer between its
registration transaction and the next registry poll, so the page waits instead
of failing: it shows a spinner banner, re-fetches every 5 s, and loads the pool
when it appears. After a minute it states that a pool which was never
registered will not appear. While the page is open, pool metadata and history
are re-read every 60 s.

A confirmed action does not change the visible state immediately. The wallet
confirms at its own block, the pool account changes in the next block, and the
indexer samples within 15 s. After a swap, deposit, or withdrawal, the page
therefore polls the chain state, wallet balances, the indexer record, and the
history every 5 s for up to 60 s, and stops as soon as reserves or LP supply
change.

History comes from `GET /pools/{id}/history` at 1m, 5m, 1h, 6h, or 1d
resolution and is drawn with TradingView's `lightweight-charts` as candlesticks with crosshair,
price line, and a last-value label. The picker offers 1m, 5m, 1h, 6h, and 1d,
which are the indexer's five retention tiers. The library is the largest dependency in
the app and only this page uses it, so `src/lib/chart.ts` imports it on demand.
Its attribution logo stays enabled: the licence requires an attribution notice
and a link to tradingview.com.

Each history bucket carries its opening state and its price extremes, so a
candle's body is the move within the bucket and its wicks are the extremes the
bucket touched. Prices are computed in bigint and scaled by 10^6 in
`src/lib/history.ts`: a ratio of two u64 reserves is not representable as a JSON
number even when each reserve is. `candles` orders the samples, drops a
backfilled one, and clamps the extremes around the body, which the chart library
requires. A sample whose `block_timestamp_last` is zero, which is what a pool
that has never been operated on holds, is placed at its poll time. A table below
the chart lists the 24 most recent samples.

The pool page leads with the current price of one token0 in token1, computed
by the contract's own formula against the chain state. Until the first chain
read returns, the headline is filled from the indexer's reserves with the same
ratio arithmetic, and the indexer never overrides a chain-derived price. The
summary also carries the pool's yield and the fees its liquidity providers
earned, both from the indexer's activity ring: the yield is the fees against the
reserves that earned them, annualised over 24 hours or the pool's age while it
is younger, and that window is shown next to the rate.

## Wallet menu

The header shows a Login button until a wallet connects. Afterwards it shows the
account id; pressing it opens a menu with one item, Disconnect.

## Utils page

The chain utilities live on their own page at `/utils.html`, in the top
navigation. Both act through a wallet, so their buttons stay disabled until one
connects.

| Utility | What it does |
| --- | --- |
| One-time mint | Creates a public faucet whose whole supply is minted to the wallet in one transaction, with `maxSupply` equal to that supply. Nothing can be minted afterwards and no auth component is installed |
| Send public note | Sends the chain fee asset through the wallet's own `requestSend` with a public note type, the only path that can target an account that does not exist on-chain yet |

Each builds its form in a modal.

## Branding

The name and slogan are configuration; the two drawings are files:

| Item | Effect |
| --- | --- |
| `VITE_BRAND_NAME` | Wordmark, page titles, `og:site_name`, footer |
| `VITE_BRAND_LOGO_TEXT` | Text mark beside the header logo; falls back to the name |
| `VITE_BRAND_SLOGAN` | One line under the home page name; empty hides it |
| `src/assets/branding/hero.html` | The home page hero |
| `src/assets/branding/logo.html` | The mark in the header of the other pages |

Both drawings are injected as they stand. Nothing in the application parses or
reassembles a drawing. A drawing may carry a `<style>` element, which is where
its own motion belongs. `.banner-source` in `src/styles/global.css` holds the
metrics a drawing needs to be legible at all, so no hero paints unstyled while
its block is on the way; a drawing that wants other metrics declares them in its
own block, which comes later and wins at equal specificity.

An empty hero falls back to the logo, and an empty file leaves the markup the page
shipped with. The defaults in `.env.example` are the brand's own: `port0.sh`, the
text mark `port0`, and the slogan `The free port of Miden`.

Artwork is rendered in the bundled `aahub_light` font, which is what gives
Japanese ASCII art the character widths its authors assumed; its licences
(monapo, SIL OFL 1.1; IPA Gothic, IPA Font License 1.0) travel with it in
`public/fonts/`.

## Pool operations

All pool actions are notes to the pool account. The app builds the note and
its FEE_SPONSORSHIP note through the port0 SDK with `submit: false`, then hands
the resulting `TransactionRequest` to the connected wallet, which signs,
submits, and reports confirmation.

Quoting is local and exact: the SDK's contract math (`amountOut`, `quoteMint`,
`quoteBurn`) runs against the latest fetched pool state. Slippage is a basis
point bound in `[0, 9999]`; the quote is floored or capped by it. Deadlines
are the maximum of the wall clock and the pool's last-seen block timestamp,
plus one hour (`DEADLINE_MARGIN_SECONDS` in `src/pages/pool.ts`).

The deploy step of pool creation is an exception: the pool is a network
account without a key. The wallet sends a small chain fee asset note to the
pool address, and the app's own client consumes that note as the pool's first
transaction, which commits the account and pays its first fee. There is no
scriptless deploy, because the 0.17 network auth rejects a transaction with no
effect.

## Token minting

The Utils page mints a fixed-supply token: the faucet is created with
`maxSupply` equal to the initial supply and the whole supply is minted to the
caller's wallet. Nothing remains to mint afterwards. The faucet id can fill
either token field of the create page's pool form.

Funding: a fresh faucet has an empty vault and cannot pay the fee of its own
first transaction, so the connected wallet sends 0.000266 USDCX (the chain
fee asset) to the new faucet: exactly the two transaction fees it will pay
(consume + mint, 2 × 133 base units at the measured testnet fee). The faucet's
first transaction consumes that note, which creates
the faucet on-chain and pays its fee out of the received funds (the
protocol's account-funding model). The supply mint follows as the second
transaction.

Validation (see `src/lib/token.ts`): symbol 3-6 uppercase ASCII letters (the
0.17 protocol rejects digits), decimals integer 0-8, initial supply entered
in tokens and bounded by the port0 contract's `MAX_AMOUNT` (2^57 base units;
amounts are u64 with u128 intermediates and 10_000 bps fee headroom).

## Fee model

LP fees follow Uniswap's three tiers: 0.05%, 0.30%, and 1.00%. The protocol's
cut is a share of the LP fee, not a per-tier surcharge: the pool is built with
`protocol_fee_share_bps` read from the registry, and the swapper pays the LP fee
tier and nothing more. The registry's `register` procedure rejects a pool built
with any other rate. `VITE_PROTOCOL_FEE_RECIPIENT` gates pool creation on the
create page; the destination the pools pay is `protocol_fee_to` in the registry.

Network note fees are denominated in the chain's fee asset, paid to the
chain's own fee faucet (`VITE_CHAIN_FEE_FAUCET_ID`). This is not a choice:
since 0.17 the node never runs network transactions for an account whose fee
asset differs from the chain's protocol configuration, so the app reads the
faucet from the client instead of asking the user. The creator's wallet must
hold the chain fee asset to pay network note fees when acting on a pool
afterwards.

## Wallets

Bread Wallet is wired through `@miden-sdk/miden-wallet-adapter-miden`; the
wallet picker shows its detection state and opens the install page when the
extension is missing. Para Wallet's packages are installed but the login
flow is gated behind `VITE_PARA_API_KEY`: without a configured key the picker
explains the dependency instead of failing later.

The package versions are pinned in `package.json` and `package-lock.json`. Keep
the `@miden-sdk/*` packages and `@port0.sh/sdk` on the versions the testnet
runs.

## Known limitations

- Closed alpha. The app builds for testnet by default and for the Miden partner
  mainnet with `VITE_NETWORK=mainnet`.
- The indexer is required. An empty `VITE_INDEXER_URL` disables browsing and
  the pool page.
- Network note fees use the chain's own fee asset and faucet (0.17 protocol
  rule); the creator's wallet must hold the chain fee asset.

## Source

Radicle is the canonical source. GitHub is the mirror.

| Source | Location |
| --- | --- |
| Radicle | https://radicle.network/nodes/iris.radicle.network/rad%3Az3fi1mouSisLs3PhaLxJiUZwhZnLd |
| GitHub | https://github.com/port0-sh/port0_app |
