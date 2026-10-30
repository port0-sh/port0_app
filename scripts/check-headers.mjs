#!/usr/bin/env node
/**
 * Release gate: the served page must carry a content policy, HSTS and a
 * no-sniff header. A missing policy is how a compromised bundle signs a
 * request the wallet shows only as an amount.
 *
 *   node scripts/check-headers.mjs https://port0.sh/
 *
 * Exits non-zero when a required header is absent or a policy directive is
 * missing. The headers are set at the CDN; this checks what is actually served.
 */
const url = process.argv[2] ?? 'https://port0.sh/'
const response = await fetch(url, { redirect: 'follow' })
if (!response.ok) {
  console.error(`fetch failed: ${response.status} ${response.statusText}`)
  process.exit(2)
}

const required = [
  ['content-security-policy', ['default-src', "script-src", "connect-src", "object-src"]],
  ['strict-transport-security', ['max-age=']],
  ['x-content-type-options', ['nosniff']],
]

let failures = 0
for (const [name, needles] of required) {
  const value = response.headers.get(name)
  if (!value) {
    console.error(`missing header: ${name}`)
    failures += 1
    continue
  }
  for (const needle of needles) {
    if (!value.includes(needle)) {
      console.error(`${name} lacks ${needle}: ${value}`)
      failures += 1
    }
  }
}

if (failures > 0) {
  console.error(`${failures} header check(s) failed for ${url}`)
  process.exit(1)
}
console.log(`headers ok for ${url}`)
