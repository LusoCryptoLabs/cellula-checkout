// LSP3 on testnet, the LSP3 line (fnn on the lsp-support line), as the
// wallet's fiber/config.ts has it: its gateway, its node and its reserve. Kept apart from start.ts so
// a script can use them without the session. LSP3 alone: the vendored v3 signer refuses a channel
// of the LSP2 line, so a kit on this line never reads an LSP2 channel's file (CHANNEL_FILE).

export const LAB_GATEWAY = 'https://cellula-fiber-lab.compartmentalizer.lusocryptolabs.com/lsp3'

/** LSP3's node id, and the args of the lock its share of a close goes to (the secp256k1 lock of
 * its funding key). Nothing starts while they are empty (lsp3Ready). */
export const LSP3_NODE = { pubkey: '0363bd9eef366a52c7cf328872769a147634b35e92f6b8a3c7b37b29005aa1a644', shutdownArgs: '0xa2fd49a1a931c106e0e93fc9a3354d0637d0465f' }

export const LSP3_PUBKEY = LSP3_NODE.pubkey

/** What a channel holds back on this side, in CKB: 100 with the full payment hash layout (58-byte
 * commitment args), the only one on the LSP3 line. It comes back when the channel closes. */
export const RESERVE_CKB = 100

/** The channel's file in a data directory: a name of the LSP3 line, so the v3 signer is never handed
 * a file of the LSP2 line (channel.json), which it refuses. */
export const CHANNEL_FILE = 'channel3.json'

/** Throws while LSP3's node is not named here: a session would register with an unknown LSP. */
export function lsp3Ready() {
  if (!LSP3_NODE.pubkey || !LSP3_NODE.shutdownArgs) throw new Error("LSP3's node is not named yet: set LSP3_NODE in packages/merchant/src/lsp3.ts")
}
