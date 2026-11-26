# Fiber session, vendored

The Fiber session the Cellula wallet runs, copied here so the merchant kit and the agent build on
their own. The kit imports it by relative path. It is the LSP3 line of the session: its saved state
is `channel3.json`, and a state saved by an older line is not read (`packages/merchant/src/lsp3.ts`).

- Sources: browser.ts, delay.ts, fees.ts, funding.ts, history.ts, host.ts, idb.ts, index.ts,
  keeper.ts, node.ts, opening.ts, recovery-file.ts, session.ts, stepup.ts, terms.ts, vault.ts.
- `signer/`: the channel signer, compiled (below), and `cellula_lsp_signer.d.ts`, its interface.

## The channel signer

The session signs every channel step with a signer compiled to WebAssembly: the tenant signer of
Fiber's LSP SDK (`fiber-lsp-sdk`, from nervosnetwork/fiber, which took the LSP work in pull request
1623) with the wallet's own rules on top. Its source is not in this repository. The build is, so
the kit runs as it is:

| File | sha256 |
| --- | --- |
| `signer/cellula_lsp_signer_bg.wasm` | `fca086d51db7f2286a2c92a8ccc5434ca78a78fa7f04e7b724f42013675378d8` |
| `signer/cellula_lsp_signer.js` | `3e146c0d135704359d6ce143113f77ba050d13f34fce7b4cf93c654c73fc9c0d` |

It is the build the Cellula wallet runs on testnet since 2026-11-25. Built from:

- the signer's source at `62b132b7` (LusoCryptoLabs, private)
- the Fiber crates at `7f3fc26c5939e24306992a9e248250af7931edb6`, a branch of Fiber's LSP line
  with our commits on top (LusoCryptoLabs, private)
- rustc 1.96.0, target `wasm32-unknown-unknown`, wasm-bindgen 0.2.125 (`--target web`), clang
  18.1.3, on Ubuntu 24.04. Built twice from an empty target directory: the same bytes both times.

To check a copy: `sha256sum vendor/fiber-session/signer/*`.

`npm run build` copies the two files into each bundle's `dist/signer/`, where the bundle loads them
at run time. The type check and the tests do not load the signer: the session is replaced by fakes.

The signer is MIT, as this repository is. It links Fiber's crates (MIT, Copyright (c) 2024-2026
Nervos Foundation) and other crates under permissive licences; their notices are in
`signer/THIRD-PARTY.md`.
