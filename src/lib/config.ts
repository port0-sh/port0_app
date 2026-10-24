/**
 * Resolved runtime configuration.
 *
 * Every value is fixed at build time from Vite env vars, so a static
 * deployment embeds its own settings and needs no runtime config fetch.
 *
 * `VITE_NETWORK` selects a per-network defaults table. An individual env var
 * overrides its entry, so a deployment sets the network and only the values
 * that differ from it.
 */

/** Networks the app can be built against, plus any custom chain by name. */
export type NetworkName = 'testnet' | 'devnet' | 'localnet' | 'mainnet'

/**
 * Per-network protocol values.
 *
 * Testnet values are the 0.17 configuration. Mainnet values were read from the
 * partner network on 2026-10-22: the RPC served a sync at height 224,912 and
 * reported the fee faucet; the prover and the note transport answer with the
 * same shapes as their testnet counterparts. A proof and a note delivery
 * confirm the last two.
 */
interface NetworkDefaults {
  rpcUrl: string
  chainFeeFaucetId: string
  proverUrl: string
  noteTransportUrl: string
  explorerUrl: string
  /**
   * The chain's own network id, which decides an address's bech32 prefix. A
   * chain with its own prefix uses `custom`, and the prefix itself.
   */
  chainId: 'testnet' | 'devnet' | 'mainnet' | 'custom'
  /** Prefix used when `chainId` is `custom`. */
  chainPrefix?: string
  /** True when real funds are at stake: gates the blocking risk notice. */
  realFunds: boolean
}

const NETWORKS: Record<NetworkName, NetworkDefaults> = {
  testnet: {
    rpcUrl: 'https://rpc.testnet.miden.io',
    chainFeeFaucetId: '0x4cbdcaffe75f0a317482224dae6436',
    proverUrl: 'testnet',
    noteTransportUrl: 'testnet',
    explorerUrl: 'https://testnet.midenscan.com/account',
    chainId: 'testnet',
    realFunds: false,
  },
  devnet: {
    rpcUrl: 'https://rpc.devnet.miden.io',
    chainFeeFaucetId: '',
    proverUrl: 'devnet',
    noteTransportUrl: 'devnet',
    explorerUrl: 'https://explorer.devnet.miden.io/account',
    chainId: 'devnet',
    realFunds: false,
  },
  localnet: {
    rpcUrl: 'http://localhost:57291',
    chainFeeFaucetId: '',
    proverUrl: 'local',
    noteTransportUrl: 'local',
    explorerUrl: '',
    chainId: 'custom',
    chainPrefix: 'mlcl',
    realFunds: false,
  },
  mainnet: {
    rpcUrl: 'https://rpc.cedar.miden.io',
    chainFeeFaucetId: '0xe69e6ca6e39df1b10c1e5399399feb',
    proverUrl: 'https://tx-prover.cedar.miden.io',
    noteTransportUrl: 'https://transport.cedar.miden.io',
    explorerUrl: 'https://explorer.cedar.miden.io/account',
    chainId: 'mainnet',
    realFunds: true,
  },
}

/**
 * Selected network, from `VITE_NETWORK`. An unrecognised value is a build error
 * rather than a silent fallback: deploying a build that quietly talks to the
 * wrong chain is worse than failing to build.
 */
const NETWORK: NetworkName = (() => {
  const requested = (import.meta.env.VITE_NETWORK ?? 'testnet').trim().toLowerCase()
  if (requested in NETWORKS) return requested as NetworkName
  throw new Error(
    `VITE_NETWORK="${requested}" is not a known network; expected one of ` +
      `${Object.keys(NETWORKS).join(', ')}`,
  )
})()

const DEFAULTS = NETWORKS[NETWORK]

export const CONFIG = {
  appName: 'port0.sh',

  /** Network this build talks to. */
  network: NETWORK,

  /** True when real funds are at stake: gates the blocking risk notice. */
  realFunds: DEFAULTS.realFunds,

  /** The chain's network id selector and its bech32 prefix when custom. */
  chainId: DEFAULTS.chainId,
  chainPrefix: DEFAULTS.chainPrefix,

  /**
   * Branding. The name and text mark come from env vars rather than being
   * written into the pages. The slogan, the header logo text, and both drawings
   * are inlined at build time by `vite.config.ts`.
   */
  brand: {
    /** Wordmark and page-title name. */
    name: import.meta.env.VITE_BRAND_NAME?.trim() || 'port0.sh',
    /** Text form of the mark, used in page titles the app sets at runtime. */
    markText: import.meta.env.VITE_BRAND_MARK_TEXT?.trim() || '[p0]',
  },

  /**
   * RPC endpoint for on-chain reads: scheme and host, nothing else.
   *
   * The same value serves development and a build. The node sends the CORS
   * headers a browser needs, so no dev-server proxy is involved, and the SDK
   * appends the gRPC service path itself: a base that already carries a path is
   * rejected with `Invalid node URL`.
   */
  midenRpcUrl: import.meta.env.VITE_MIDEN_RPC_URL?.trim() || DEFAULTS.rpcUrl,

  /**
   * Faucet of the chain's fee asset. Required by MidenClient.create and used as
   * every new pool's network note-fee faucet.
   */
  chainFeeFaucetId:
    import.meta.env.VITE_CHAIN_FEE_FAUCET_ID?.trim() || DEFAULTS.chainFeeFaucetId,

  /**
   * Transaction prover. A preset (`local`, `testnet`, `devnet`) or a remote
   * prover URL. Mainnet proves at the partner network's prover.
   */
  proverUrl: import.meta.env.VITE_PROVER_URL?.trim() || DEFAULTS.proverUrl,

  /**
   * Note transport, for private notes. A preset (`testnet`, `devnet`) or a
   * remote transport URL.
   */
  noteTransportUrl:
    import.meta.env.VITE_NOTE_TRANSPORT_URL?.trim() || DEFAULTS.noteTransportUrl,

  /**
   * Para wallet integration. Empty apiKey disables the Para option in the
   * wallet picker until a key is configured and the login flow is wired.
   */
  paraApiKey: import.meta.env.VITE_PARA_API_KEY?.trim() ?? '',
  paraEnvironment: import.meta.env.VITE_PARA_ENVIRONMENT?.trim() ?? 'BETA',

  /**
   * On-chain pool registry account. When set, pool creation emits a register
   * note after the pool is deployed. Empty disables registration.
   */
  registryId: import.meta.env.VITE_REGISTRY_ID?.trim() ?? '',

  /**
   * Register note consumption fee, in the registry's fee asset (the chain fee
   * asset). Must match the registry's note fee schedule. Decimal string.
   */


  /**
   * Indexer base URL. When set, pool state is read from the indexer in one
   * request instead of one account fetch per pool. Empty keeps the per-pool
   * chain reads.
   */
  indexerUrl: import.meta.env.VITE_INDEXER_URL?.trim() ?? '',

  /**
   * Block explorer, without a trailing slash. Account ids are appended, so an
   * empty value simply leaves the links off the page.
   */
  explorerUrl: import.meta.env.VITE_EXPLORER_URL?.trim() ?? DEFAULTS.explorerUrl,
} as const
