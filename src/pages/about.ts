/**
 * About page. Static content; mounts only the shared header wallet control and
 * the site chrome (footer year, one-time testnet disclaimer).
 */

import { mountSiteChrome } from '../lib/site'
import { mountWallet } from '../wallet/ui'

mountWallet()
mountSiteChrome()
