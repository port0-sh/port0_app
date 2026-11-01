# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-10-31

### Added

- The ASCII ship loader: the frame composed by the program, injected as document
  markup by a Vite plugin, animated from an inline bootstrap, and adopted by the
  module, so the table area is never empty and never still.
- The pool page's activity table: one indexer request, transaction rows only,
  the price from each row's amounts, the exact block, the UTC time, the explorer
  link, and the count of transactions not listed.
- Refund detection: the pool's refund note is recognised on the pool page (the
  status line and a toast) and in the multihop (the hop ends as refunded and the
  retry resumes at its submit stage), with the notes held before the submission
  excluded.
- The action gate: one module decides the swap, add, and remove state and copy,
  including the seed-only gate, the unverified listing, and a held transaction.
- Registry listing read by account proof, and faucet metadata read from
  `token_config`.
- The debug page and harness, the header check script, the SDK provenance file,
  and the launch sponsorship's reclaim height.
- Refund-selection tests.

### Changed

- The pool table: sortable columns, token and id filter, page size, and the
  loader only while the table is empty; the 24-hour volume is valued at par in
  the fee asset from the stats module.
- The history chart's price helper and the window caption beside the resolution
  chips.
- The legacy pools come from the indexer's `/legacy` and are shown by default.
- The pool page's history panel and table, the forms' gating and notices, and
  the token picker's LP tokens.
- The remove form's slippage default is 0.5 on every network and 99 on a
  mainnet build.
- `sendViaWallet` states the note script: a required `recall` option, P2IDE for
  a wallet send and P2ID for a network recipient.
- The mainnet build omits the debug page; the testnet build carries it.

### Fixed

- The listing state distinguishes unverified from not listed; the table's units
  print smaller than their amounts; the time column carries the date and UTC.
- The legacy pool page renders the pool and token links and reads the LP
  balance; it had returned from boot before the wallet wiring ran.
- A submit whose wallet read failed did nothing: the read sat outside the
  flow's error handling in the swap, add, and remove forms. It now runs inside
  and reports.

### Removed

- The observation rows; the client-side fallback for the old indexer payload;
  `DEFAULT_DECIMALS`; three CSS classes from the retired wallet menu.

## [0.3.4] - 2026-10-30

Initial release.

### Added

- A six-page static site with no framework and no client-side router: Pools,
  Pool, Launch, Utils, About, and Media.
- The pools page: the swap card, the protocol stats, and the pool table with
  symbol, pair, and id filtering, column sorting, and 10, 25, or 50 rows per
  page, remembered across visits.
- Route enumeration over the indexed reserves for up to three hops, and
  hop-by-hop execution through the wallet with a per-hop receipt, a price
  impact, and a completion bell.
- The pool page: pool state, the price chart, and the swap, add, and remove
  actions with quotes, the LP token picker, and the impermanent-loss notice.
- The launch page: token selection, the LP fee tier, pool creation, funding, and
  the register note.
- The utils page: the fixed-supply token launch, the registry fee, and a public
  note.
- The Bread wallet adapter: connect, the stored session, a bounded handshake,
  and every write handed to the wallet as a `TransactionRequest`, never signed
  in the page.
- Pool discovery through the indexer's registry poll: the app holds no local
  pool list, and a pool appears once the registry has accepted it.
- The mainnet risk gate, the network configuration for testnet, devnet,
  localnet, and mainnet, and build-time environment selection.
- The SDK and the Miden client loaded on demand, so the pages paint and the pool
  list renders without the WASM stack.
- `README.md` and `.env.example`.
