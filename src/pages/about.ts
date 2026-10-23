/**
 * About page. Static content; mounts the wallet control, the footer year, and
 * the alpha notice.
 */

import { mountSite } from '../lib/site'
import { mountWallet } from '../wallet/ui'

mountWallet()
mountSite()
