// What the agent fetches for its caller (/v1/fetch): the public internet only. A seller's 402 is
// never on this machine or its network, and an agent told to fetch there would hand the answer of a
// router or a local service to whoever asked, a model misled by a page included. The address is
// checked on each connection, after the name is looked up, so a name that points inside (at once or
// on the second lookup, after paying) is refused too.
//
// `allowPrivate` is for a person testing their own seller on this machine (AGENT_FETCH_PRIVATE=1).

import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { MerchantError } from './errors.ts'

// One list per family: a BlockList checks an IPv4 address against IPv6 rules too, as if mapped, so
// the IPv4-mapped rule below would take every IPv4 address in one list.
const NOT_PUBLIC_V4 = new net.BlockList()
const NOT_PUBLIC_V6 = new net.BlockList()
// This network, private, shared (CGNAT), loopback, link-local, protocol, documentation, benchmark,
// multicast, reserved and broadcast.
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) NOT_PUBLIC_V4.addSubnet(a, p, 'ipv4')
// Unspecified, loopback and IPv4-compatible; the forms with an IPv4 address inside, any of the above
// (mapped, translated, NAT64 well-known and local-use, 6to4, Teredo); discard, documentation, unique
// local, site-local (deprecated, still routed by some), link-local and multicast.
for (const [a, p] of [
  ['::', 96], ['::ffff:0:0', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2002::', 16], ['2001::', 32],
  ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fec0::', 10], ['fe80::', 10], ['ff00::', 8],
] as const) NOT_PUBLIC_V6.addSubnet(a, p, 'ipv6')

export function isPublicAddress(ip: string): boolean {
  const v = net.isIP(ip)
  if (v === 4) return !NOT_PUBLIC_V4.check(ip, 'ipv4')
  return v === 6 && !NOT_PUBLIC_V6.check(ip, 'ipv6')
}

const notPublic = (host: string, ip: string) =>
  new MerchantError('not_public', `${host} is at ${ip}, not on the public internet: the agent fetches only there`, 403)

// A seller's answer is read up to this much (the API hands back less), a connection that says
// nothing for this long is dropped, and so is one still going after the longest: a seller sending a
// byte at a time holds no call open for good.
const MOST = 1_000_000
const QUIET_MS = 30_000
const LONGEST_MS = 60_000

export function publicFetch(o: { allowPrivate?: boolean; longestMs?: number } = {}): typeof fetch {
  const allowPrivate = o.allowPrivate === true
  const longest = o.longestMs ?? LONGEST_MS
  const lookup = (hostname: string, options: dns.LookupOptions, callback: (...a: any[]) => void) => {
    dns.lookup(hostname, { ...options, all: true }, (err, found) => {
      if (err) return callback(err)
      const inside = allowPrivate ? undefined : found.find((a) => !isPublicAddress(a.address))
      if (inside) return callback(notPublic(hostname, inside.address))
      if (options.all) return callback(null, found)
      callback(null, found[0]!.address, found[0]!.family)
    })
  }
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new MerchantError('invalid_request', 'url must be an http or https URL', 400)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    // An address in the URL is not looked up, so it is checked here.
    if (!allowPrivate && net.isIP(host) && !isPublicAddress(host)) throw notPublic(host, host)
    const headers: Record<string, string> = {}
    // The host is the URL's, never a header's (TLS would take its name from one).
    new Headers(init.headers).forEach((v, k) => {
      if (k !== 'host') headers[k] = v
    })
    const body = typeof init.body === 'string' ? init.body : undefined
    const mod = url.protocol === 'https:' ? https : http
    return new Promise<Response>((resolve, reject) => {
      const req = mod.request(url, { method: init.method ?? 'GET', headers, lookup: lookup as net.LookupFunction, timeout: QUIET_MS }, (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          if (size >= MOST) return
          chunks.push(c)
          size += c.length
        })
        res.on('error', reject)
        res.on('end', () => {
          clearTimeout(deadline)
          const out = new Headers()
          for (const [k, v] of Object.entries(res.headers)) for (const one of Array.isArray(v) ? v : v == null ? [] : [v]) out.append(k, one)
          const status = res.statusCode ?? 502
          const empty = status === 204 || status === 205 || status === 304 || init.method === 'HEAD'
          resolve(new Response(empty ? null : Buffer.concat(chunks).subarray(0, MOST), { status, statusText: res.statusMessage, headers: out }))
        })
      })
      const deadline = setTimeout(() => {
        const e = new MerchantError('timeout', `${url.host} took more than ${longest / 1000} s`, 504)
        reject(e)
        req.destroy(e)
      }, longest)
      req.on('timeout', () => req.destroy(new MerchantError('timeout', `${url.host} said nothing for ${QUIET_MS / 1000} s`, 504)))
      req.on('error', (e) => {
        clearTimeout(deadline)
        if (e instanceof MerchantError) return reject(e)
        reject(new MerchantError('unreachable', `${url.host} could not be reached (${(e as NodeJS.ErrnoException).code ?? e.message})`, 502))
      })
      req.end(body)
    })
  }) as typeof fetch
}
