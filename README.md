# port0.sh app

Static web application for the port0.sh constant-product AMM on Miden: browse
pools, swap, provide liquidity, launch a pool, and launch a fixed-supply token.

A six-page MPA plus an unlinked debug page, no client-side router and no
framework. The Miden SDK and the `@port0.sh/sdk` load on demand, so the pages
paint and the pool list renders without the WASM stack.

Status: unaudited, closed alpha. Pools and their notes are public network accounts.

## Run

```sh
npm install
npm run dev        # Vite dev server on :5173
npm run build      # tsc -b && vite build into dist/
npm run preview
npm run typecheck
npm test
npm run lint
```

Node 20 or later. `VITE_NETWORK` selects the chain at build time, so one checkout
holds one deployment: to build for two chains, build twice into separate output
directories.

## Configuration

Every value is read from the environment at build time; `.env.example` lists them
with their defaults. The network name selects these defaults, and any of them can
be overridden individually.

| `VITE_NETWORK` | RPC | Fee faucet | Fees in real funds |
| --- | --- | --- | --- |
| `testnet` | `https://rpc.testnet.miden.io` | `0x4cbdcaff…6436` | no |
| `devnet` | `https://rpc.devnet.miden.io` | (none) | no |
| `localnet` | `http://localhost:57291` | (none) | no |
| `mainnet` | `https://rpc.cedar.miden.io` | `0xe69e6ca6…9feb` | yes, gated by the risk notice |

An unrecognised name fails the build. On a network with real funds the first visit
shows a blocking risk notice, accepted under `port0-app:alpha-risk:v1:<network>`.

`VITE_REGISTRY_ID` names the on-chain registry; the app reads its protocol fee
destination, share, allowed LP tiers, and register price from it. `VITE_INDEXER_URL`
names the pool source. Both are required for a usable deployment; the app degrades
to "no pools" without the indexer.

`VITE_LEGACY_REGISTRY_IDS` is a comma-separated list of earlier registries. Their
pools come from the indexer's `/legacy` and are appended to the same pool table,
tagged `Unsupported`, dimmed, excluded from the stats and the router, and
withdraw-only through the frozen SDK that produced their notes
(`@port0.sh/sdk-legacy`, pinned to the published version). The list must match the
indexer's legacy list. The rows are shown by default, and a switch in the table
hides them. When a registry is replaced, move its id from `VITE_REGISTRY_ID` into
this list on both sides.

`VITE_TRADING_ENABLED=1` enables every transaction the app builds; without it
the pages render and the actions stay disabled, so a defect in a note path can be
stopped by a configuration change. `VITE_TRUSTED_TOKENS` sets the assets counted
at par with the fee asset in the protocol totals, replacing the network's list.
`VITE_PINNED_POOLS` puts the named pool ids first in the table. `VITE_SITE_URL` is
the absolute site origin used by canonical and unfurl metadata.

`/debug.html` is an unlinked, noindex wallet edge-case page: sync and height,
send with recall, wallet notes, and faulty swaps, deposits and withdrawals that
the pool must refund. It is built on testnet, devnet and localnet, omitted from
the mainnet build, and linked from nowhere.

## Pages

| Page | Path | Contents |
| --- | --- | --- |
| Pools | `/` | Swap card, protocol stats, pool table |
| Pool | `/pool.html?id=<pool id>` | Pool state, chart, swap, add and remove liquidity |
| Launch | `/create.html` | Token selection, fee tier, pool creation and registration |
| Utils | `/utils.html` | Token launch, registry fee, public note |
| About | `/about.html` | |
| Media | `/media.html` | |
| Debug | `/debug.html` | Wallet edge cases (unlinked, noindex) |

## Architecture

| Module | Responsibility |
| --- | --- |
| `lib/config.ts` | Resolved configuration and the per-network defaults |
| `lib/network.ts` | Wallet network name and the chain's bech32 network id |
| `lib/client.ts` | Lazy `MidenClient` and `XykClient` singletons; SDK loads on first use |
| `lib/indexer.ts` | Pool list, history, status, fee-schedule root mapping |
| `lib/router.ts` | Route enumeration over the indexed reserves, pure `bigint` |
| `lib/multihop.ts` | Hop-by-hop execution through the wallet |
| `lib/refund.ts` | Recognises the pool's refund note and settles the row |
| `lib/gating.ts` | The swap, add, and remove action gate and its copy |
| `lib/stats.ts` | Protocol stats, the 24 h volume at par in the fee asset |
| `lib/registry.ts` | Registry reads by account proof: listing and faucet metadata |
| `lib/fees.ts` | LP fee tiers, the measured deploy fees, fee-to-APR |
| `lib/history.ts` | Price ratios, candles, and the window caption |
| `lib/brand.ts` | Brand slots and the drawings |
| `lib/chart.ts` | TradingView lightweight-charts, imported on demand |
| `lib/format.ts` | Exact `bigint` amounts, bps, id shortening |
| `lib/token.ts` | Fixed-supply token validation |
| `lib/state.ts` | The pub/sub store |
| `lib/dom.ts` | `el`, `qs`, `clear`, `setText` |
| `lib/site.ts` | Footer, alpha notice, risk gate, sound toggle |
| `lib/sound.ts` | Arrival bell |
| `wallet/wallet.ts` | Bread adapter facade: connect, submit, sync, reads |
| `wallet/ui.ts` | Login button, account menu, wallet picker |
| `ui/` | `modal`, `toast`, `spinner`, `tokenCombo` |
| `pages/` | One module per HTML entry, including the unlinked debug page |
| `features/` | Token launch, registry fee, public note, wallet token picker |

## Wallet

Login goes through the Bread adapter. The extension holds the authorization, so the
app stores only the authorized address under `port0-app:wallet-session:v1` and
re-drives the handshake on load. A handshake that never settles is bounded at 20 s,
its stuck state is cleared so a retry works, and wallet errors appear in the console
and in a toast that stays until dismissed.

The app cannot execute for a wallet account: it holds no key. Every write is a
`TransactionRequest` built by the SDK and handed to the wallet, which signs,
submits, and confirms.

## Pools

The pool list comes from the indexer, which polls the active registry and each of
its pools. The table shows pair, price, both reserves, 24 h volume, LP fee, and
fee APR; it filters on symbols, pair, and ids, sorts by column, and pages at 10,
25, or 50 rows. The page size is remembered under `port0-app:page-size`.

Pools of earlier registries come from the indexer's `/legacy`, filtered to the
app's legacy list, and are appended to the same table: tagged `Unsupported`,
dimmed, excluded from the stats and the router, and withdraw-only through the SDK
version that produced their notes. They are shown by default, and a switch hides
them.

A pool is registered by a register note the creator's wallet emits after the pool
is deployed. The registry verifies the pool on chain before listing it: its code
commitment, its identity, its six auth storage roots, and that its payout script is
the standard P2ID root. A pool whose allowlist, fee asset, fee policy, or payout
script differs from the registry's is rejected.

## Swap

`lib/router.ts` enumerates routes of up to three hops over distinct tokens and ranks
them by output, preferring the direct pool at equal output. A quote comes from the
indexer's last snapshot, so it is a quote, not a guarantee.

`lib/multihop.ts` executes one wallet transaction per hop: the pool consumes the swap
note and emits a P2ID note of the output token, which must reach the wallet before
the next hop can spend it, and the next hop's input is the amount actually received.
A failed hop reports its index and stage; a retry resumes there rather than
resubmitting earlier hops.

While a route runs, the status box shows the path with the hop the wallet is
prompting for in bold, and keeps a receipt afterwards: swapped amount, rate, LP fee,
price impact, per-hop amounts, transaction count, and the network fee. A completed
swap rings the bell in `public/bell.mp3`; the toggle sits beside the wallet control
and its state is `port0-app:sound:v1`.

## Pool page

Three actions against one pool: swap either direction, add liquidity at the current
ratio, and remove it. The page shows the pool's fee split, reserves, price, LP supply,
a price chart built from the indexer's history, and an activity table from
`/pools/{id}/activity`: the kind, the price from the row's own amounts, the block,
the UTC time, and an explorer link, with the count of unresolved transactions
stated beside it. LP amounts are shown with the LP token's own symbol, which the
pool account carries as its faucet metadata.

A rejected trade is refunded by the pool. The page recognises the refund note,
states it, and offers a retry that rebuilds the request at a fresh tip.

## Utils

| Tool | Effect |
| --- | --- |
| Token launch | Creates a network faucet and launches its whole supply to the wallet once. No invitation code, because the faucet is a network account; the owner is immutable |
| Registry fee | Reads the registry's admin and live register fee, refuses any other wallet, and emits the config note |
| Public note | Sends the chain fee asset with a public note carrying a recall height, the only form that can target an account that does not exist on chain yet, and reclaimable by the sender if never consumed |

## Fees

The LP fee tier is one of 0.05%, 0.30%, or 1.00%, from the registry's allowed set.
The protocol's share is carved out of that fee, not added to it, so the swapper pays
the tier and the output does not depend on the share.

Network note fees are denominated in the chain's fee asset and priced per note kind:
126 base units for the four pool notes and the two registry notes, 119 for a token
launch, 0 for the registry config note. A pool and the registry reserve that same
scheduled price out of the fee asset so a sweep can pay its own transaction.

## Limits

- A pool cannot be paused, upgraded, or reconfigured. Its parameters are initial
  storage.
- The app lists at most 1,000 pools, fetched in five pages; beyond that, filtering
  and paging belong to the indexer.
- Listing is permissionless and the registry vets no token: a creator can list a
  mintable token and drain the pool's other side. Check a faucet before depositing.

## Source

Radicle is canonical; GitHub is a mirror.

| Source | Location |
| --- | --- |
| Radicle | https://radicle.network/nodes/iris.radicle.network/rad%3Az3fi1mouSisLs3PhaLxJiUZwhZnLd |
| GitHub | https://github.com/port0-sh/port0_app |
