/**
 * Media kit page. Static content; mounts the wallet control, the footer year,
 * and the testnet notice.
 */

import { mountSite } from '../lib/site'
import { mountWallet } from '../wallet/ui'

mountWallet()
mountSite()
