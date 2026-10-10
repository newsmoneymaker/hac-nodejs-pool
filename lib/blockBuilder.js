/**
 * Hacash (HAC) Pool
 *
 * Real consensus facts, verified against the live node 2026-10-10 (not assumed):
 *   - block_intro is exactly 89 bytes: version(1) + height(5) + timestamp(5) + prevhash(32) +
 *     mrklroot(32) + transaction_count(4) + nonce(4) + difficulty(4) + witness_stage(2).
 *     See protocol/src/codec/block.rs, BlockV1::INTRO_SIZE / encode_intro_to.
 *   - NONCE_OFFSET = 79 (version+height+timestamp+prevhash+mrklroot+transaction_count), 4 bytes,
 *     big-endian (field/src/types/uint.rs encode_to: to_be_bytes, truncated to N bytes).
 *   - block_hash(height, data) = x16rs_hash(repeat(height), sha3_256(data)), where
 *     repeat(height) = min(floor(height/50000)+1, 16). See x16rs/src/lib.rs, block_hash/block_hash_repeat.
 *   - A hash "beats" a target when the hash, read as a big-endian 256-bit number, is <= the
 *     target (mint/src/consensus/minter.rs, miner_success_block: `if block_hash > target_hash`
 *     rejects) -- plain hex-string comparison of equal-length hex works the same way as numeric
 *     comparison here since both are fixed 64-hex-char (32 byte) big-endian values.
 * Verified end to end 2026-10-10: computed this exact pipeline for a real live block at height
 * 30001 and got a byte-for-byte match against the node's own internally-computed hash (extracted
 * from its own "difficulty check failed: expected at most X but got Y" rejection message).
 **/
const crypto = require('crypto');
const hasher = require('./hasher.js');

const INTRO_SIZE = 89;
const NONCE_OFFSET = 79;

exports.INTRO_SIZE = INTRO_SIZE;
exports.NONCE_OFFSET = NONCE_OFFSET;

exports.repeatFor = function (height) {
	return Math.min(Math.floor(height / 50000) + 1, 16);
};

/** Splice a candidate nonce (uint32) into a copy of the block_intro buffer at NONCE_OFFSET. */
exports.withNonce = function (introBuf, nonce) {
	const buf = Buffer.from(introBuf);
	buf.writeUInt32BE(nonce >>> 0, NONCE_OFFSET);
	return buf;
};

/** Async hash of a candidate (intro+nonce already spliced) -- cb(err, hashHex). */
exports.hashCandidate = function (height, introWithNonce, cb) {
	const sha3Hex = crypto.createHash('sha3-256').update(introWithNonce).digest('hex');
	hasher.hash(exports.repeatFor(height), sha3Hex, cb);
};

/** hashHex <= targetHex, both 64-hex-char big-endian values (equal length, so a plain
 * lexicographic string compare is a correct stand-in for the numeric compare). */
exports.meetsTarget = function (hashHex, targetHex) {
	return hashHex.toLowerCase() <= targetHex.toLowerCase();
};
