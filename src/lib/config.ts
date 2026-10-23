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

/** Networks the app can be built against. */
export type NetworkName = 'testnet' | 'mainnet'

/**
 * Per-network protocol values.
 *
 * Testnet values are the 0.17 configuration. Mainnet values were read from the
 * partner network on 2026-10-22: the RPC served a sync at height 224,912 and
 * reported the fee faucet; the prover and the note transport answer with the
 * same shapes as their testnet counterparts. A proof and a note delivery
 * confirm the last two.
 */
const NETWORKS: Record<
  NetworkName,
  {
    rpcUrl: string
    chainFeeFaucetId: string
    proverUrl: string
    noteTransportUrl: string
    explorerUrl: string
  }
> = {
  testnet: {
    rpcUrl: 'https://rpc.testnet.miden.io',
    chainFeeFaucetId: '0x4cbdcaffe75f0a317482224dae6436',
    proverUrl: 'testnet',
    noteTransportUrl: 'testnet',
    explorerUrl: 'https://testnet.midenscan.com/account',
  },
  mainnet: {
    rpcUrl: 'https://rpc.cedar.miden.io',
    chainFeeFaucetId: '0xe69e6ca6e39df1b10c1e5399399feb',
    proverUrl: 'https://tx-prover.cedar.miden.io',
    noteTransportUrl: 'https://transport.cedar.miden.io',
    explorerUrl: 'https://explorer.cedar.miden.io/account',
  },
}

/** Selected network. Anything other than `mainnet` resolves to testnet. */
const NETWORK: NetworkName =
  import.meta.env.VITE_NETWORK?.trim() === 'mainnet' ? 'mainnet' : 'testnet'

const DEFAULTS = NETWORKS[NETWORK]

export const CONFIG = {
  appName: 'port0.sh',

  /** Network this build talks to. */
  network: NETWORK,

  /** True on the partner mainnet: real funds, closed alpha, no reset. */
  isMainnet: NETWORK === 'mainnet',

  /**
   * Branding. The name, the text mark, and the slogan come from env vars rather
   * than being written into the pages; the two drawings are files.
   */
  brand: {
    /** Wordmark and page-title name. */
    name: import.meta.env.VITE_BRAND_NAME?.trim() || 'port0.sh',
    /** Text form of the mark, used in page titles the app sets at runtime. */
    markText: import.meta.env.VITE_BRAND_MARK_TEXT?.trim() || '[p0]',
    /** Single-line text mark beside the header logo. */
    logoText: import.meta.env.VITE_BRAND_LOGO_TEXT?.trim() ?? '',
    /** One line under the name on the home page; hidden when empty. */
    slogan: import.meta.env.VITE_BRAND_SLOGAN?.trim() ?? '',
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
   * Platform fee recipient. Pool creation is gated on this value; the pools
   * pay the registry's `protocol_fee_to`, which the create flow reads from the
   * registry. Account id in hex or bech32. Empty string when unset; pool
   * creation is then disabled.
   */
  protocolFeeRecipient: import.meta.env.VITE_PROTOCOL_FEE_RECIPIENT?.trim() ?? '',

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
  registryRegisterFee: import.meta.env.VITE_REGISTRY_REGISTER_FEE?.trim() || '0',

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
