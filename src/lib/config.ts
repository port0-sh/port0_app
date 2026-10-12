/**
 * Resolved runtime configuration.
 *
 * Every value is fixed at build time from Vite env vars, so a static
 * deployment embeds its own settings and needs no runtime config fetch.
 */

const DEFAULT_MIDEN_RPC_URL = 'https://rpc.testnet.miden.io'

/**
 * The 0.17 testnet's chain fee faucet, read from the node's protocol
 * configuration. On 0.17 the network-note fee faucet of a pool must be the
 * chain's own: the node never consumes notes for an account whose fee asset
 * differs. Override with VITE_CHAIN_FEE_FAUCET_ID for other networks.
 */
const DEFAULT_CHAIN_FEE_FAUCET_ID = '0x4cbdcaffe75f0a317482224dae6436'

/** Path the Vite dev server proxies to the Miden RPC (see vite.config.ts). */
const DEV_RPC_PROXY_PATH = '/rpc.Api'

export const CONFIG = {
  appName: 'port0.sh',

  /**
   * Branding. The name, the text mark, and the slogan come from env vars rather
   * than being written into the pages; the two drawings are files.
   */
  brand: {
    /** Wordmark and page-title name. */
    name: import.meta.env.VITE_BRAND_NAME?.trim() || 'port0.sh',
    /** Single-line text mark beside the header logo. */
    logoText: import.meta.env.VITE_BRAND_LOGO_TEXT?.trim() ?? '',
    /** One line under the name on the home page; hidden when empty. */
    slogan: import.meta.env.VITE_BRAND_SLOGAN?.trim() ?? '',
  },

  /**
   * RPC endpoint for on-chain reads. In development this is the same-origin
   * proxy path; in production it is VITE_MIDEN_RPC_URL or the public testnet
   * RPC endpoint.
   */
  midenRpcUrl: import.meta.env.DEV
    ? DEV_RPC_PROXY_PATH
    : (import.meta.env.VITE_MIDEN_RPC_URL?.trim() || DEFAULT_MIDEN_RPC_URL),

  /**
   * Faucet of the chain's fee asset (the 0.17 protocol configuration).
   * Required by MidenClient.create and used as every new pool's network
   * note-fee faucet.
   */
  chainFeeFaucetId:
    import.meta.env.VITE_CHAIN_FEE_FAUCET_ID?.trim() || DEFAULT_CHAIN_FEE_FAUCET_ID,

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
  registryRegisterFee:
    import.meta.env.VITE_REGISTRY_REGISTER_FEE?.trim() || '0',

  /**
   * Indexer base URL. When set, pool state is read from the indexer in one
   * request instead of one account fetch per pool. Empty keeps the per-pool
   * chain reads.
   */
  indexerUrl: import.meta.env.VITE_INDEXER_URL?.trim() ?? '',
} as const
