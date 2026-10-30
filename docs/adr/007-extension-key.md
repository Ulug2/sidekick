# ADR-007: A fixed public key pins the extension ID

Status: accepted (2026-10-29).

An unpacked extension's ID comes from its folder path unless the manifest has a `key`. Moving from `extension/` to `dist/` would change the ID (and leave storage behind); so would re-cloning the repo or another Mac. `src/manifest.json` now carries a public key; the ID is always `nhnafciagehpkiaighdpmnahdacacnfj` (asserted by the real-Chrome suite). The key is public and safe to commit; its private half was not kept (only needed to sign a .crx, which a Web Store upload doesn't use). Storage from the old `extension/` install did not carry over; Ulugbek chose to start fresh.
