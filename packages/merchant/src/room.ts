// Room to receive, rented from the LSP. A shop paid more than its channel
// can take in rents more room: it asks the LSP's gateway, pays the LSP's invoice from its channel,
// and the room comes with its next channel with the LSP. A hosted shop takes its channel out and
// opens it again once nothing is under way; the new channel is a new tenant, so the rent is moved to
// it with the claim the ask gave. A shop on its own node opens a second channel. A rent runs for
// months of 30 days; a week before it ends the shop is told (room.ending), and when it ends
// (room.ended) the LSP funds the default again and, after its grace (a week), closes the channel
// the rent paid for. Renew before then to keep it.

/** What more room costs where the LSP rents it: a fraction of the room per month, the least and
 * most room, in shannons, and a month in ms. */
export type RailTerms = { perMonth: number; least: bigint; most: bigint; monthMs: number }

/** A rent as the LSP's gateway keeps it (times in ms). `claim`, from the ask only. */
export type RailRent = { paymentHash: string; room: bigint; months: number; price: bigint; paid: boolean; start: number | null; until: number | null; ended: boolean; closed: boolean; claim?: string }

/** What renting needs of the shop's side: start.ts gives one for a hosted shop, ownNodeRoom one
 * for a shop on its own node. */
export interface RoomRail {
  terms(): Promise<RailTerms | null>
  /** Ask for `room` shannons over `months`, pay the LSP's invoice, and resolve once it is seen paid
   * (or with it unpaid after a minute). */
  rent(room: bigint, months: number): Promise<RailRent>
  status(paymentHash: string): Promise<RailRent>
  /** Bring paid room into a channel with the LSP. Hosted: the channel is taken out and the process
   * starts again (the service brings it back), the rents moving to the new tenant then (`move`).
   * Own node: a second channel. */
  place(): Promise<void>
  /** Move a rent to this shop's current node (hosted, after a new start). */
  move?(paymentHash: string, claim: string): Promise<void>
}

/** The gateway's terms, from its /capacity: null where it rents no room. */
export async function termsAt(gateway: string, f: typeof fetch = fetch): Promise<RailTerms | null> {
  const r = await f(`${gateway}/capacity`)
  if (!r.ok) throw new Error(`the LSP answered ${r.status}`)
  const c = (await r.json()) as Record<string, number | undefined>
  if (!c.rent_per_month) return null
  return { perMonth: Number(c.rent_per_month), least: BigInt(c.rent_room_min ?? 0), most: BigInt(c.rent_room_max ?? 0), monthMs: Number(c.rent_month_seconds) * 1000 }
}

/** A rent by its payment hash, as the gateway says it now. */
export async function statusAt(gateway: string, paymentHash: string, f: typeof fetch = fetch): Promise<RailRent> {
  const r = await f(`${gateway}/rent/${paymentHash}`)
  const b = (await r.json().catch(() => ({}))) as Record<string, unknown>
  if (!r.ok) throw new Error(String(b.error ?? `the LSP answered ${r.status}`))
  const ms = (x: unknown) => (x == null ? null : Number(x) * 1000)
  return { paymentHash, room: BigInt(b.room as number), months: Number(b.months), price: BigInt(b.price as number), paid: !!b.paid, start: ms(b.start), until: ms(b.until), ended: !!b.ended, closed: !!b.closed }
}

/** What a shop on its own node needs of it to rent: its key, a payment, a channel opened. */
export type RentingNode = {
  pubkey(): Promise<string>
  pay(invoice: string): Promise<void>
  openChannel(pubkey: string, ckb: bigint): Promise<void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Renting for a shop on its own node: asked with the node's key, paid by the node, and the room
 * brought in by a second channel of `openCkb` CKB (109 unless told: the node's reserve and 10). */
export function ownNodeRoom(o: { gateway: string; lspPubkey: string; node: RentingNode; openCkb?: number; fetch?: typeof fetch; waitMs?: number }): RoomRail {
  const f = o.fetch ?? fetch
  return {
    terms: () => termsAt(o.gateway, f),
    async rent(room, months) {
      const pubkey = await o.node.pubkey()
      const r = await f(`${o.gateway}/rent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pubkey, room_ckb: Number(room) / 1e8, months }) })
      const body = (await r.json().catch(() => ({}))) as { payment_hash?: string; invoice?: string; claim?: string; error?: string }
      if (!r.ok || !body.payment_hash || !body.invoice) throw new Error(body.error ?? `the LSP answered ${r.status}`)
      await o.node.pay(body.invoice)
      const end = Date.now() + (o.waitMs ?? 60_000)
      for (;;) {
        const now = await statusAt(o.gateway, body.payment_hash, f).catch(() => null)
        if (now?.paid || Date.now() >= end) return { ...(now ?? (await statusAt(o.gateway, body.payment_hash, f))), claim: body.claim }
        await sleep(2000)
      }
    },
    status: (h) => statusAt(o.gateway, h, f),
    place: () => o.node.openChannel(o.lspPubkey, BigInt(o.openCkb ?? 109)),
  }
}
