// What came and went through this channel, for people to read: the payments this host sent, and
// its invoices that were paid. Kept apart from the session so it can be tested in node.

export type HistoryItem = {
  kind: 'sent' | 'received'
  paymentHash: string
  /** In shannons. */
  amount: bigint
  /** `done`: paid (or, received, in this channel); `failed`: it did not go and nothing left;
   * `going`: still on its way, perhaps held for a payee who is away. */
  state: 'done' | 'failed' | 'going'
  /** When it was sent, or when its payment arrived; null for records kept before times were. */
  at: number | null
  /** Paid through a pay link (a name), rather than an invoice shown by hand. */
  link: boolean
  /** A payment to the LSP itself: its opening fee, or rent of room to receive. Not "paid" to
   * anyone, so the wallet names it (a tester's remark, 2026-10-25: the fee showed as "Paid"). */
  what?: 'fee' | 'rent'
  /** The token it was paid in, for a channel of a token (`tokens`); absent for CKB. Its amount is
   * then in the token's smallest unit. */
  token?: { code_hash: string; hash_type: string; args: string }
  /** That token's name and decimals, as its channel kept them ('' when it kept no name). */
  unit?: { name: string; decimals: number }
  /** The channel it went through, where the record kept it: a payment of a channel closed since is
   * on chain with that channel until it ends (a 14:00 test payment, 2026-10-30). */
  channel?: string
  /** Failed after it had left: what it held came back on chain with its channel's settlement, a
   * channel closed by force (a 14:00 test payment of 1.005 CKB, back inside the payer's share, 2026-10-30). */
  back?: true
  /** Sent and paid: what the routing cost, in shannons (or the token's unit), as the LSP's node
   * counted it; absent when not known (paid before it was kept, or not paid). */
  fee?: bigint
}

type SentRecord = { payment_hash: string; amount: string; status: string; at?: number; what?: 'fee'; channel_id?: string; back?: boolean; fee?: string }
type InvoiceRecord = { payment_hash: string; amount: string; released?: boolean; refused?: boolean; link?: boolean; paid_at?: number; channel_id?: string }
type Script = { code_hash: string; hash_type: string; args: string }
type Kept = { script: Script; name: string; decimals: number }

/** Newest first; records without a time keep their order after the rest, newest kept last.
 * `rents`: the payment hashes of rent this host paid (its room rent records). `tokens`: the channels
 * of a token this host had, by id, so each payment says what it was paid in. */
export function historyOf(sent: SentRecord[], invoices: InvoiceRecord[], rents: string[] = [], tokens: Record<string, Script | Kept> = {}): HistoryItem[] {
  const tokenOf = (id?: string) => {
    const t = id ? tokens[id] : undefined
    if (!t) return {}
    return 'script' in t ? { token: t.script, unit: { name: t.name, decimals: t.decimals } } : { token: t }
  }
  const out: (HistoryItem & { order: number })[] = []
  sent.forEach((p, order) => {
    const what = p.what ?? (rents.includes(p.payment_hash) ? 'rent' : undefined)
    out.push({
      kind: 'sent',
      paymentHash: p.payment_hash,
      amount: BigInt(p.amount),
      state: p.status === 'Paid' ? 'done' : p.status === 'Failed' ? 'failed' : 'going',
      at: p.at ?? null,
      link: false,
      ...(what ? { what } : {}),
      ...tokenOf(p.channel_id),
      ...(p.channel_id ? { channel: p.channel_id } : {}),
      ...(p.back ? { back: true as const } : {}),
      ...(p.status === 'Paid' && p.fee !== undefined ? { fee: BigInt(p.fee) } : {}),
      order,
    })
  })
  invoices.forEach((inv, order) => {
    if (!inv.released || inv.refused) return
    out.push({
      kind: 'received',
      paymentHash: inv.payment_hash,
      amount: BigInt(inv.amount),
      state: 'done',
      at: inv.paid_at ?? null,
      link: !!inv.link,
      ...tokenOf(inv.channel_id),
      ...(inv.channel_id ? { channel: inv.channel_id } : {}),
      order: sent.length + order,
    })
  })
  out.sort((a, b) => (a.at !== null && b.at !== null ? b.at - a.at : a.at !== null ? -1 : b.at !== null ? 1 : b.order - a.order))
  return out.map(({ order: _, ...item }) => item)
}
