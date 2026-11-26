# Third-party notices for the compiled signer

`cellula_lsp_signer_bg.wasm` is compiled from Rust crates, each under its own licence. All of them
allow redistribution in compiled form with their notice. The list below is every crate the build
links for `wasm32-unknown-unknown`, from `cargo metadata` on the build's `Cargo.lock`.

The main parts:

- the Fiber crates (`fiber-lsp-sdk`, `fiber-types`, `fiber-json-types`), from nervosnetwork/fiber,
  MIT, Copyright (c) 2024-2026 Nervos Foundation
- `fiber-sphinx`, MIT, Copyright (c) 2024 ian
- `secp256k1-sys`, which compiles libsecp256k1, MIT, Copyright (c) 2013 Pieter Wuille
- the CKB crates (`ckb-*`), from nervosnetwork/ckb, MIT
- `cellula-lsp-signer` and `fiber-watch`, by LusoCryptoLabs, MIT

## MIT License

The text below applies to each crate above marked MIT, with the copyright line of its authors.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## subtle 2.6.1 (BSD-3-Clause)

```
Copyright (c) 2016-2017 Isis Agora Lovecruft, Henry de Valence. All rights reserved.
Copyright (c) 2016-2024 Isis Agora Lovecruft. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

1. Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright
notice, this list of conditions and the following disclaimer in the
documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS
IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED
TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED
TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE. 
```

## arrayref 0.3.9 (BSD-2-Clause)

```
Copyright (c) 2015 David Roundy <roundyd@physics.oregonstate.edu>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the
   distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Crates linked

| Crate | Version | Licence |
| --- | --- | --- |
| anyhow | 1.0.104 | MIT OR Apache-2.0 |
| arcode | 0.2.4 | MIT |
| arrayref | 0.3.9 | BSD-2-Clause |
| arrayvec | 0.7.8 | MIT OR Apache-2.0 |
| async-trait | 0.1.92 | MIT OR Apache-2.0 |
| base16ct | 0.2.0 | Apache-2.0 OR MIT |
| base64 | 0.23.1 | MIT OR Apache-2.0 |
| bech32 | 0.11.1 | MIT |
| bech32 | 0.9.1 | MIT |
| bincode | 1.3.3 | MIT |
| bit-vec | 0.6.3 | MIT/Apache-2.0 |
| bitbit | 0.2.0 | MIT |
| bitcoin-consensus-encoding | 1.3.0 | CC0-1.0 |
| bitcoin-internals | 0.7.0 | CC0-1.0 |
| bitcoin-io | 0.1.101 | CC0-1.0 |
| bitcoin_hashes | 0.14.101 | CC0-1.0 |
| bitflags | 1.3.2 | MIT/Apache-2.0 |
| bitflags | 2.13.2 | MIT OR Apache-2.0 |
| blake2b-ref | 0.3.1 | MIT |
| block-buffer | 0.10.4 | MIT OR Apache-2.0 |
| bs58 | 0.5.1 | MIT/Apache-2.0 |
| bumpalo | 3.20.4 | MIT OR Apache-2.0 |
| byteorder | 1.5.0 | Unlicense OR MIT |
| bytes | 1.12.1 | MIT |
| cellula-lsp-signer | 0.3.0 | MIT |
| cfg-if | 1.0.5 | MIT OR Apache-2.0 |
| chacha20 | 0.9.1 | Apache-2.0 OR MIT |
| chrono | 0.4.45 | MIT OR Apache-2.0 |
| cipher | 0.4.4 | MIT OR Apache-2.0 |
| ckb-constant | 1.1.4 | MIT |
| ckb-error | 1.1.1 | MIT |
| ckb-fixed-hash | 1.1.1 | MIT |
| ckb-fixed-hash-core | 1.1.2 | MIT |
| ckb-fixed-hash-macros | 1.1.1 | MIT |
| ckb-gen-types | 1.1.2 | MIT |
| ckb-hash | 1.1.1 | MIT |
| ckb-jsonrpc-types | 1.2.1 | MIT |
| ckb-merkle-mountain-range | 0.5.2 | MIT |
| ckb-occupied-capacity | 1.1.1 | MIT |
| ckb-occupied-capacity-core | 1.1.1 | MIT |
| ckb-occupied-capacity-macros | 1.1.1 | MIT |
| ckb-rational | 1.1.2 | MIT |
| ckb-types | 1.1.4 | MIT |
| crypto-common | 0.1.7 | MIT OR Apache-2.0 |
| darling | 0.24.1 | MIT |
| darling_core | 0.24.1 | MIT |
| darling_macro | 0.24.1 | MIT |
| data-encoding | 2.11.1 | MIT |
| defmt | 1.2.0 | MIT OR Apache-2.0 |
| defmt-macros | 1.2.0 | MIT OR Apache-2.0 |
| defmt-parser | 1.1.0 | MIT OR Apache-2.0 |
| deranged | 0.5.9 | MIT OR Apache-2.0 |
| derive_more | 1.0.0 | MIT |
| derive_more-impl | 1.0.0 | MIT |
| digest | 0.10.7 | MIT OR Apache-2.0 |
| dyn-clone | 1.0.20 | MIT OR Apache-2.0 |
| equivalent | 1.0.3 | Apache-2.0 OR MIT |
| faster-hex | 0.6.1 | MIT |
| fastrand | 2.5.0 | Apache-2.0 OR MIT |
| fenwick | 1.0.0 | MIT |
| fiber-json-types | 0.10.1 | MIT |
| fiber-lsp-sdk | 0.1.0 | MIT |
| fiber-sphinx | 3.0.0 | MIT |
| fiber-types | 0.10.1 | MIT |
| fiber-watch | 0.1.0 | MIT |
| futures | 0.3.34 | MIT OR Apache-2.0 |
| futures-channel | 0.3.34 | MIT OR Apache-2.0 |
| futures-core | 0.3.34 | MIT OR Apache-2.0 |
| futures-executor | 0.3.34 | MIT OR Apache-2.0 |
| futures-io | 0.3.34 | MIT OR Apache-2.0 |
| futures-macro | 0.3.34 | MIT OR Apache-2.0 |
| futures-sink | 0.3.34 | MIT OR Apache-2.0 |
| futures-task | 0.3.34 | MIT OR Apache-2.0 |
| futures-util | 0.3.34 | MIT OR Apache-2.0 |
| generic-array | 0.14.7 | MIT |
| getrandom | 0.1.16 | MIT OR Apache-2.0 |
| getrandom | 0.2.17 | MIT OR Apache-2.0 |
| getrandom | 0.3.4 | MIT OR Apache-2.0 |
| golomb-coded-set | 0.2.1 | MIT |
| hashbrown | 0.12.3 | MIT OR Apache-2.0 |
| hashbrown | 0.17.1 | MIT OR Apache-2.0 |
| heapsize | 0.4.2 | MIT/Apache-2.0 |
| heck | 0.5.0 | MIT OR Apache-2.0 |
| hex | 0.4.3 | MIT OR Apache-2.0 |
| hex-conservative | 0.2.3 | CC0-1.0 |
| hex-conservative | 1.3.0 | CC0-1.0 |
| hmac | 0.12.1 | MIT OR Apache-2.0 |
| ident_case | 1.0.1 | MIT/Apache-2.0 |
| indexmap | 1.9.3 | Apache-2.0 OR MIT |
| indexmap | 2.14.2 | Apache-2.0 OR MIT |
| inout | 0.1.4 | MIT OR Apache-2.0 |
| itoa | 1.0.19 | MIT OR Apache-2.0 |
| jiff | 0.2.39 | Unlicense OR MIT |
| jiff-core | 0.1.2 | Unlicense OR MIT |
| jiff-tzdb | 0.1.9 | Unlicense OR MIT |
| jiff-tzdb-platform | 0.1.3 | Unlicense OR MIT |
| js-sys | 0.3.102 | MIT OR Apache-2.0 |
| log | 0.4.35 | MIT OR Apache-2.0 |
| memchr | 2.8.3 | Unlicense OR MIT |
| merkle-cbt | 0.3.2 | MIT |
| minimal-lexical | 0.2.1 | MIT/Apache-2.0 |
| molecule | 0.9.2 | MIT |
| musig2 | 0.2.4 | Unlicense |
| nom | 7.1.3 | MIT |
| num-conv | 0.2.2 | MIT OR Apache-2.0 |
| num-traits | 0.2.19 | MIT OR Apache-2.0 |
| num_enum | 0.7.6 | BSD-3-Clause OR MIT OR Apache-2.0 |
| num_enum_derive | 0.7.6 | BSD-3-Clause OR MIT OR Apache-2.0 |
| numext-constructor | 0.1.6 | Apache-2.0 OR MIT |
| numext-fixed-uint | 0.1.6 | Apache-2.0 OR MIT |
| numext-fixed-uint-core | 0.1.6 | Apache-2.0 OR MIT |
| numext-fixed-uint-hack | 0.1.6 | Apache-2.0 OR MIT |
| once_cell | 1.21.4 | MIT OR Apache-2.0 |
| paste | 1.0.15 | MIT OR Apache-2.0 |
| phf | 0.12.1 | MIT |
| phf_generator | 0.12.1 | MIT |
| phf_macros | 0.12.1 | MIT |
| phf_shared | 0.12.1 | MIT |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT |
| powerfmt | 0.2.1 | MIT OR Apache-2.0 |
| ppv-lite86 | 0.2.21 | MIT OR Apache-2.0 |
| proc-macro-crate | 3.5.0 | MIT OR Apache-2.0 |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 |
| quote | 1.0.47 | MIT OR Apache-2.0 |
| rand | 0.7.3 | MIT OR Apache-2.0 |
| rand | 0.8.8 | MIT OR Apache-2.0 |
| rand_chacha | 0.2.2 | MIT OR Apache-2.0 |
| rand_chacha | 0.3.1 | MIT OR Apache-2.0 |
| rand_core | 0.5.1 | MIT OR Apache-2.0 |
| rand_core | 0.6.4 | MIT OR Apache-2.0 |
| ref-cast | 1.0.27 | MIT OR Apache-2.0 |
| ref-cast-impl | 1.0.27 | MIT OR Apache-2.0 |
| rustversion | 1.0.23 | MIT OR Apache-2.0 |
| schemars | 0.9.0 | MIT |
| schemars | 1.2.3 | MIT |
| schemars_derive | 1.2.3 | MIT |
| secp | 0.5.0 | Unlicense |
| secp256k1 | 0.30.0 | CC0-1.0 |
| secp256k1-sys | 0.10.1 | CC0-1.0 |
| send_wrapper | 0.6.0 | MIT/Apache-2.0 |
| seq-macro | 0.3.6 | MIT OR Apache-2.0 |
| serde | 1.0.229 | MIT OR Apache-2.0 |
| serde_core | 1.0.229 | MIT OR Apache-2.0 |
| serde_derive | 1.0.229 | MIT OR Apache-2.0 |
| serde_derive_internals | 0.30.0 | MIT OR Apache-2.0 |
| serde_json | 1.0.154 | MIT OR Apache-2.0 |
| serde_with | 3.24.0 | MIT OR Apache-2.0 |
| serde_with_macros | 3.24.0 | MIT OR Apache-2.0 |
| serdect | 0.3.0 | Apache-2.0 OR MIT |
| sha2 | 0.10.9 | MIT OR Apache-2.0 |
| siphasher | 0.3.11 | MIT/Apache-2.0 |
| siphasher | 1.0.4 | MIT OR Apache-2.0 |
| slab | 0.4.12 | MIT |
| strsim | 0.11.1 | MIT |
| strum | 0.27.2 | MIT |
| strum | 0.28.0 | MIT |
| strum_macros | 0.27.2 | MIT |
| strum_macros | 0.28.0 | MIT |
| subtle | 2.6.1 | BSD-3-Clause |
| syn | 1.0.109 | MIT OR Apache-2.0 |
| syn | 2.0.119 | MIT OR Apache-2.0 |
| syn | 3.0.10 | MIT OR Apache-2.0 |
| tentacle-multiaddr | 0.3.8 | MIT |
| thiserror | 1.0.69 | MIT OR Apache-2.0 |
| thiserror | 2.0.21 | MIT OR Apache-2.0 |
| thiserror-impl | 1.0.69 | MIT OR Apache-2.0 |
| thiserror-impl | 2.0.21 | MIT OR Apache-2.0 |
| time | 0.3.55 | MIT OR Apache-2.0 |
| time-core | 0.1.9 | MIT OR Apache-2.0 |
| time-macros | 0.2.32 | MIT OR Apache-2.0 |
| tinyvec | 1.13.3 | Zlib OR Apache-2.0 OR MIT |
| toml_datetime | 1.1.3+spec-1.1.0 | MIT OR Apache-2.0 |
| toml_edit | 0.25.18+spec-1.1.0 | MIT OR Apache-2.0 |
| toml_parser | 1.1.5+spec-1.1.0 | MIT OR Apache-2.0 |
| tracing | 0.1.44 | MIT |
| tracing-attributes | 0.1.31 | MIT |
| tracing-core | 0.1.36 | MIT |
| typenum | 1.20.1 | MIT OR Apache-2.0 |
| unicode-ident | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0 |
| unicode-xid | 0.2.6 | MIT OR Apache-2.0 |
| unsigned-varint | 0.8.0 | MIT |
| wasm-bindgen | 0.2.125 | MIT OR Apache-2.0 |
| wasm-bindgen-futures | 0.4.75 | MIT OR Apache-2.0 |
| wasm-bindgen-macro | 0.2.125 | MIT OR Apache-2.0 |
| wasm-bindgen-macro-support | 0.2.125 | MIT OR Apache-2.0 |
| wasm-bindgen-shared | 0.2.125 | MIT OR Apache-2.0 |
| web-time | 1.1.0 | MIT OR Apache-2.0 |
| winnow | 1.0.5 | MIT |
| zerocopy | 0.8.63 | BSD-2-Clause OR Apache-2.0 OR MIT |
| zeroize | 1.9.1 | Apache-2.0 OR MIT |
| zmij | 1.0.23 | MIT |
