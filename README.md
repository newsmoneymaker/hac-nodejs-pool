# hac-nodejs-pool

Mining pool for Hacash (HAC), algorithm X16RS. Real, built from scratch for this coin --
Hacash has no Stratum protocol at all, just a plain HTTP polling API on the node itself
(`/query/miner/pending`, `/submit/miner/success`), designed for a single solo miner.

## Protocol

This pool exposes its own small newline-delimited JSON-RPC TCP server (port 5100 by default),
deliberately shaped like Stratum's own subscribe/authorize/notify/submit so that a future
poolpayminer client port is a smaller step than inventing something unrelated:

```
-> {"id":1,"method":"mining.subscribe","params":["<agent>"]}
<- {"id":1,"result":true,"error":null}
-> {"id":2,"method":"mining.authorize","params":["<address>","<worker>"]}
<- {"id":2,"result":true,"error":null}
<- {"id":null,"method":"mining.notify","params":{"job_id","height","intro","target","repeat"}}
-> {"id":3,"method":"mining.submit","params":["<worker>","<job_id>","<nonce hex, 8 chars>"]}
<- {"id":3,"result":true/false,"error":null|"<reason>"}
```

`intro` is the real `block_intro` hex from the node, with the nonce field (offset 79, 4 bytes
big-endian within the 89-byte intro) zeroed. A miner splices its candidate nonce in at that
offset, computes `x16rs_hash(repeat, sha3_256(intro))`, and submits the nonce if the result is
<= `target` (the pool's own easier share target, NOT the real network target in `network.target`
from `/stats`).

## Hasher

`hasher/x16rshash` wraps the real X16RS C source vendored verbatim from the `x16rs-sys` crate
(crates.io, `=0.1.2`) that Hacash's own node links -- see `hasher/x16rs-src/`. Verified against
that crate's own unit test vectors, and independently cross-checked against a real live block:
the hash this pool computes for a real block_intro + nonce=0 matches, byte for byte, the hash the
node itself reports in a deliberate "difficulty check failed" rejection message.

## Status (2026-10-10)

Real end-to-end verified: job distribution, share hashing/acceptance, real block submission to
the node, Redis PROP crediting. **Payment sending is NOT implemented** -- Hacash's own transaction
format (secp256k1-rfc6979-sha256 signing, its own fee/gas pricing units) is a separate task that
was out of scope here; `paymentProcessor.js` only logs what would be paid. `dryRun` should be
treated as permanently true until that's built and tested with a real accepted transaction.
Orphan/reorg detection is not implemented either -- a block that gets reorged out after crediting
would currently just be paid as a false positive; not yet observed in practice on this new chain.
