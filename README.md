# Miden XYK App

Static web application for the MidenXYK constant-product AMM on Miden. Users
browse pools, swap, deposit and withdraw liquidity, and create pools. There is
no application framework and no client-side router: each page is a real HTML
document with its own metadata, its own module entry, and a minimal amount of
TypeScript.

## Pages

| Route                    | File           | Purpose                                                       |
| ------------------------ | -------------- | ------------------------------------------------------------- |
| `/`                      | `index.html`   | Browse the local pool registry, import pools by account id    |
| `/pool.html?id=<poolid>` | `pool.html`    | Pool state, swap, add liquidity, remove liquidity             |
| `/create.html`           | `create.html`  | Launch a token, create and deploy a pool, send the admin configuration note |

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

The build output is plain static files (`dist/`): three HTML documents, one
CSS file, one small JS bundle per page, and a shared lazy chunk containing the
Miden SDK. Deploy `dist/` to any static file host.

## Configuration

Environment variables are read at build time (`import.meta.env`):

| Variable                       | Default                        | Meaning                                    |
| ------------------------------ | ------------------------------ | ------------------------------------------ |
| `VITE_MIDEN_RPC_URL`           | `https://rpc.testnet.miden.io` | Miden node RPC for on-chain reads          |
| `VITE_CHAIN_FEE_FAUCET_ID`     | `0x4cbdcaffe75f0a317482224dae6436` | Faucet of the chain's fee asset (0.17 testnet protocol configuration) |
| `VITE_PROTOCOL_FEE_RECIPIENT`  | (empty)                        | Platform fee recipient; pool creation fails when unset |
| `VITE_PARA_API_KEY`            | (empty)                        | Para API key; empty keeps the Para option disabled |
| `VITE_PARA_ENVIRONMENT`        | `BETA`                         | Para environment; `PRODUCTION` for production builds |

`VITE_PROTOCOL_FEE_RECIPIENT` accepts a hex account id or a bech32 address.
It is displayed on the create page and never editable by users.

In development the RPC is reached through a same-origin proxy (`/rpc.Api`,
configured in `vite.config.ts`) so the browser never sends cross-origin
gRPC-web requests. Production builds talk to the RPC directly. The app targets
the 0.16 testnet only.

## Architecture

```
index.html  pool.html  create.html     one real HTML entry per page
src/styles/global.css                  hand-written stylesheet, PICO-8 palette
src/lib/
  config.ts     resolved runtime configuration
  client.ts     lazy MidenClient/XykClient singletons (SDK loads on first use)
  registry.ts   localStorage-persisted pool registry with per-record validation
  format.ts     bigint-exact amount parsing/formatting, id shortening, bps
  state.ts      ~30-line pub/sub store; the entire state layer
  dom.ts        el()/qs()/clear() DOM helpers
src/ui/
  toast.ts      notification stack
  modal.ts      native <dialog> wrapper
src/wallet/
  wallet.ts     unified wallet facade (Bread wired; Para gated)
  ui.ts         header connect button, wallet picker, address chip
src/pages/
  home.ts       registry table, import, on-demand state refresh
  pool.ts       state summary, quotes, swap/add/remove submission
  create.ts     create pool wizard (three steps)
```

The home page never loads the SDK: the registry table renders from
localStorage, and on-chain state is fetched only when the user clicks
*Refresh on-chain state*. On every page the Login button is plain HTML plus
a light module; the wallet adapter (and the WASM stack behind it) loads only
on first connect. `pool.html` and `create.html` load the SDK lazily on first
use, so every page shell renders without WASM on the critical path.

## Pool registry

The node RPC has no account-listing-by-code-root endpoint, so chain-wide
discovery belongs to an indexer. The app persists a local registry
(`localStorage`, key `miden-xyk-app:pool-registry:v1`) of:

| Field          | Type              | Meaning                                             |
| -------------- | ----------------- | --------------------------------------------------- |
| `poolId`       | hex string        | Pool account id                                     |
| `feeFaucetId`  | hex string, null  | Network note-fee faucet; null = read-only import    |
| `noteFees`     | map kind → string | Per-note-kind consumption fee, decimal string       |
| `token0FaucetId`, `token1FaucetId` | hex | Pair faucets                          |
| `token0Symbol`, `token1Symbol` | string | Display symbols                          |
| `token0Decimals`, `token1Decimals` | integer 0–18 | Display/parse units           |
| `addedAt`      | epoch ms          | Sort key                                            |

The fee faucet id and fee schedule are fixed at pool creation and are not
readable from the public account API, so records store them. Every load
validates each entry and drops malformed ones. Pools imported by bare account
id become read-only records (`feeFaucetId: null`): their state is browsable,
but trading is disabled because the fee configuration cannot be recovered.

## Pool operations

All pool actions are notes to the pool account. The app builds the note and
its FEE_SPONSORSHIP note through the XYK SDK with `submit: false`, then hands
the resulting `TransactionRequest` to the connected wallet, which signs,
submits, and reports confirmation.

Quoting is local and exact: the SDK's contract math (`amountOut`, `quoteMint`,
`quoteBurn`) runs against the latest fetched pool state. Slippage is a basis
point bound in `[0, 9999]`; the quote is floored or capped by it. Deadlines
are the maximum of the wall clock and the pool's last-seen block timestamp,
plus one hour (`DEADLINE_MARGIN_SECONDS` in `src/pages/pool.ts`).

The deploy step of pool creation is an exception: the pool is a network
account without a key, and its scriptless deploy transaction can be submitted
by anyone, so the app's own client submits it directly.

## Launchpad

The create page can mint a fixed-supply token before pool creation: the
faucet is created with `maxSupply` equal to the initial supply and the whole
supply is minted to the creator's wallet. The faucet uses Falcon keyed auth,
so nobody can mint more. The launched faucet id can fill either token field
of the pool form with one click.

Funding: a fresh faucet has an empty vault and cannot pay the fee of its own
first transaction, so the connected wallet sends 0.000420 USDCX (the chain
fee asset) to the new faucet: exactly the two transaction fees it will pay
(consume + mint, 2 × 210 base units at the testnet's per-transaction
maximum). The faucet's first transaction consumes that note, which creates
the faucet on-chain and pays its fee out of the received funds (the
protocol's account-funding model). The supply mint follows as the second
transaction.

Validation (see `src/lib/token.ts`): symbol 3-6 uppercase ASCII letters (the
0.17 protocol rejects digits), decimals integer 0-8, initial supply entered
in tokens and bounded by the XYK contract's `MAX_AMOUNT` (2^57 base units;
amounts are u64 with u128 intermediates and 10_000 bps fee headroom).

## Fee model

LP fees follow Uniswap's three tiers: 0.05%, 0.30%, and 1.00%. The protocol
fee is a fixed value per tier: 1 bps at 0.05%, 2 bps at 0.30%, 5 bps at
1.00%. It always goes to `VITE_PROTOCOL_FEE_RECIPIENT`; the create page
displays the value and does not let users change it.

Network note fees are denominated in the chain's fee asset, paid to the
chain's own fee faucet (`VITE_CHAIN_FEE_FAUCET_ID`). This is not a choice:
since 0.17 the node never runs network transactions for an account whose fee
asset differs from the chain's protocol configuration, so the app reads the
faucet from the client instead of asking the user. The creator's wallet must
hold the chain fee asset to send the admin note and to act on the pool
afterwards.

## Wallets

Bread Wallet is wired through `@miden-sdk/miden-wallet-adapter-miden`; the
wallet picker shows its detection state and opens the install page when the
extension is missing. Para Wallet's 0.17 packages are installed but the login
flow is gated behind `VITE_PARA_API_KEY`: without a configured key the picker
explains the dependency instead of failing later.

The pinned version matrix:

| Package                                    | Version |
| ------------------------------------------ | ------- |
| `@miden-sdk/miden-sdk`                     | 0.17.0  |
| `@miden-sdk/miden-wallet-adapter-base`     | 0.17.0  |
| `@miden-sdk/miden-wallet-adapter-miden`    | 0.17.0  |
| `@miden-sdk/para`                          | 0.17.0  |
| `@getpara/web-sdk`                         | 3.18.0  |
| `miden-xyk-sdk`                            | `file:../miden_xyk_sdk_ts` (linked during SDK development) |

## Known limitations

- Testnet only. The 0.16 testnet is the only network this app targets.
- No indexer integration. Browsing shows the local registry; pools created
  elsewhere must be imported by id.
- Imported pools are read-only. Trading requires the fee faucet id and fee
  schedule that only the creator knows.
- Network note fees use the chain's own fee asset and faucet (0.17 protocol
  rule); the creator's wallet must hold the chain fee asset.
