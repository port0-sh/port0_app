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
  appName: 'Miden XYK',

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
   * Platform fee recipient: every pool the app deploys sends its protocol fee
   * here. Account id in hex or bech32. Displayed on the create page, never
   * user-settable. Empty string when unset; pool creation then fails.
   */
  protocolFeeRecipient: import.meta.env.VITE_PROTOCOL_FEE_RECIPIENT?.trim() ?? '',

  /**
   * Para wallet integration. Empty apiKey disables the Para option in the
   * wallet picker until a key is configured and the login flow is wired.
   */
  paraApiKey: import.meta.env.VITE_PARA_API_KEY?.trim() ?? '',
  paraEnvironment: import.meta.env.VITE_PARA_ENVIRONMENT?.trim() ?? 'BETA',
} as const
