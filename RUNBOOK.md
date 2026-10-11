# Runbook

How to stand up the stack and deploy a pool. Four repositories:

| Repository | Role |
| --- | --- |
| `miden_xyk` | Contracts: the pool component, the registry component, and the note scripts |
| `miden_xyk_sdk_ts` | TypeScript SDK: contract artifacts, the registry account builder, and the pool operations |
| `miden_xyk_indexer` | Rust indexer: reads the registry and pools over node RPC, serves HTTP |
| `miden_xyk_app` | Static web app: browse pools, trade, provide liquidity, create pools |

Testnet version: 0.17.1. Every `@miden-sdk/*` and `miden-node-proto` pin matches it.

## Part 1: one-time operator setup

### 1. Contracts

The SDK's artifact exporter builds the packages itself, so this step is only
needed to build the contracts seed of a fresh checkout.

```sh
cd miden_xyk
cargo miden build --manifest-path contracts/miden-xyk/Cargo.toml --release
```

### 2. SDK artifacts

```sh
cd miden_xyk_sdk_ts
npm install
npm run generate   # exports the compiled packages into src/generated
npm run build
```

### 3. Pool code commitment

```sh
npm run pool:commitment
```

Prints the accepted pool code commitment, for example
`0x522ed558f58b98584ee0ad2561ebb134adee52091f98d052686d966c907df5f7`. The value
covers the pool's full component set: the `miden-xyk` component,
`CodeInspection`, the network-account auth, and the fee-policy components. It
changes whenever any of those change, and the registry must be seeded with the
value the deployed pool produces.

### 4. Registry account

```sh
cp .env.example .env       # set MIDEN_XYK_FEE_FAUCET_ID and MIDEN_XYK_POOL_COMMITMENT
npm run registry:deploy
```

The tool is interactive. On first run it creates an operator wallet, prints
its bech32 address, and polls until the fee asset arrives. It consumes the
incoming note, then funds the registry with whatever the operator holds above
the transaction fee, capped at `MIDEN_XYK_FUND`. Send at least 134 base units
to proceed; `1000 + 133` funds the registry at the default. The tool then
builds the registry with `createRegistryAccount`, funds it, and deploys it,
printing the registry id. No re-run is needed. Wait timeout:
`MIDEN_XYK_WAIT_SECS` (default 600); on timeout it prints the address and
exits. Keys and store: `~/.miden/stores/<MIDEN_XYK_STORE>/`.

### 5. Indexer

```sh
cd ../miden_xyk_indexer
cp .env.example .env       # set MIDEN_XYC_REGISTRY_ID to the registry id from step 4
cargo run --release
```

Serves `http://0.0.0.0:8080`. `GET /status` reports the registry id, the last
registry block, and the known and fetched pool counts. Pools appear after the
registry poll (default 60 s) and the pool poll (default 15 s).

### 6. App

```sh
cd ../miden_xyk_app
cp .env.example .env       # set VITE_REGISTRY_ID and VITE_INDEXER_URL=http://localhost:8080
npm run dev
```

`VITE_REGISTRY_ID` enables registration during pool creation.
`VITE_INDEXER_URL` is the pool source for browsing and the pool page. An empty
value disables both.

## Part 2: deploy a pool through the app

Prerequisite: the connected wallet holds USDCX. The wallet pays the pool
funding note and the register note fee. The measured
per-transaction fee is 133 base units.

1. Open `/create.html` and connect the wallet.
2. Choose the token pair. Either launch a fixed-supply token, which creates a
   faucet and funds it with `2 × 133 = 266` base units of USDCX, or enter two
   existing faucet ids.
3. Choose the LP fee tier: 5, 30, or 100 basis points, whichever the registry
   lists. The protocol's cut is a share of that fee, read from the registry and
   carved out of it, so the swapper pays the LP fee tier and nothing more.
4. Submit. The page runs three on-chain steps and reports each.

| Step | What happens | Who pays |
| --- | --- | --- |
| Create pool account | Built locally, not yet on-chain. Fees, the P2ID root, and the registry pointer are initial storage; the LP token key is derived by the contract | Nothing |
| Deploy | The wallet sends 133 base units of USDCX to the pool; then the app consumes that note as the pool's first transaction | Wallet funds; the pool pays its first fee from the received funds |
| Register | Register note via the wallet, sponsored with the registry's register fee; the node's transaction builder consumes it against the registry, which verifies the pool code commitment, the registry pointer, the token pair, and the fee values by foreign procedure invocation | Wallet |

5. The page redirects to `/pool.html?id=<poolid>`. The pool appears on the home
   page once the indexer has polled the registry and fetched the pool. Until
   then the pool page shows a spinner and re-checks the indexer every 5 s, so
   the redirect lands on a page that fills itself in rather than an error.

If a stage fails, the page keeps the flow state and shows **Retry <stage>** and
**Restart flow**. Retry resumes at the failed stage; it does not recreate the
pool, and the deploy stage reuses an existing funding note instead of sending a
second one. Restart clears the state and starts from the pool account.

## Part 3: deploy a pool programmatically

The same four steps without the UI. The wallet-signed steps can be submitted by
the client directly when the account's key is in the client keystore.

```ts
import { MidenClient } from "@miden-sdk/miden-sdk";
import { XykClient } from "miden-xyk-sdk";

const client = await MidenClient.create({
  rpcUrl,
  feeFaucetId,
  proverUrl: "testnet",
  autoSync: true,
});
const xyk = XykClient.from(client);

// 1. Build the pool account locally.
const account = await xyk.createPoolAccount({
  token0Key,
  token1Key,
  admin,
  feeFaucetId,
  noteFees,
});
const poolId = account.id();

// 2. Fund it, then 3. deploy by consuming the funding note.
const { txId: fundTx } = await client.transactions.send({
  account: admin.toString(),
  to: poolId.toString(),
  token: feeFaucetId,
  amount: 133n,
  type: "public",
  waitForConfirmation: true,
});
await client.sync();
const consumable = await client.notes.listAvailable({ account: poolId.toString() });
await xyk.deployPoolAccount(poolId, consumable[0].id().toString(), {
  waitForConfirmation: true,
});

// 4. Register. The pool was configured when it was created: fees, the P2ID
// root, and the registry pointer are initial storage, and the LP token key is
// derived by the contract.
await xyk.registerPool(
  { registryId, feeFaucetId, registerFee },
  { sender: admin, poolId, asset0: token0FaucetId, asset1: token1FaucetId },
  { submit: true, waitForConfirmation: true },
);
```

## What the indexer reads

| Data | Source |
| --- | --- |
| Pool set | Registry `pools` map |
| Reserves, LP supply, pot, fees, oracle | The pool's eleven value slots and its vault |
| Token symbols and decimals | Each faucet's `token_config` slot |
| Note fee schedule and fee asset | The pool's `fee_asset_id` value slot and the `basic_constant_fee` schedule map |
| Activity and 24 h aggregates | Classified reserve and pot deltas between polls |

Reserves equal the vault balances of token0 and token1 minus the protocol pot.

## Failure conditions

| Symptom | Cause and fix |
| --- | --- |
| `MIDEN_XYC_REGISTRY_ID is required` | The indexer has no registry id. Set it in `.env`. |
| `registry response is missing slot pool_registry::pool_registry::pools` | The indexer points at an account that is not the registry. Correct the id. |
| Pool absent from the home page | The indexer is not running, the registry id is wrong, or the register note has not been consumed by the node's builder yet. Check `GET /status`. |
| `Pool code commitment not accepted` at registration | The registry was seeded with a stale commitment. Re-run `npm run pool:commitment` and redeploy the registry, or register a pool built with the accepted component set. |
| Trading disabled on the pool page | The indexer could not read the pool's fee asset id or fee schedule. Check the pool's network-account slots. |
| `funding not received within Ns (balance X/Y)` | The operator address was not funded within the wait. Send it fee asset base units and re-run, or raise `MIDEN_XYK_WAIT_SECS`. |
| `SummaryAnchorMismatchError` at register | The wallet captured its chain anchor at a block other than the request's bound block; a block landed between the two syncs. The page syncs the wallet immediately before the build to narrow the window. Press **Retry <stage>** to rebuild the request at a fresh tip. |
| `ERR_NETWORK_ACCOUNT_TRANSACTION_HAS_NO_EFFECT` | A network-account deploy with no effect. Deploy by consuming a funding note, as the tools do. |
| `procedure with root digest ... could not be found` | The client minor is behind the node. Bump every `@miden-sdk/*` and `miden-node-proto` pin to the node's version. |
