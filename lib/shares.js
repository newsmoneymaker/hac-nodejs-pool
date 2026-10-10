/**
 * Hacash (HAC) Pool
 *
 * PROP share accounting, same shape as every other pool here: one Redis sorted set per round
 * (keyed by the height the round is FOR), score = cumulative difficulty-weighted contribution.
 * When a block is found, blockUnlocker.js reads that round's full score set once height matures,
 * credits each miner proportionally, and starts a new round for the next height.
 *
 * Double-credit guard (see critical-double-credit-bug.md): recordBlockFound only ever writes ONE
 * `HAC:blocks:candidates` member per height -- a duplicate call for the same height is a no-op
 * (checked via HSETNX-style existence check before adding), so a race between two accepted
 * shares for the same block (unlikely here since the node itself is the single source of truth
 * for "did this submission actually get accepted", but cheap to guard anyway) can't double-pay.
 **/
const redisClient = require('redis').createClient(config.redis.port, config.redis.host, {
	auth_pass: config.redis.auth,
});

const MAX_HASH = (1n << 256n) - 1n;

function weightFor(shareTargetHex) {
	const t = BigInt('0x' + shareTargetHex);
	if (t <= 0n) return 1;
	const w = MAX_HASH / t;
	return Number(w > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : w) || 1;
}
// Exported so pool.js and api.js can compute the SAME real-difficulty number (MAX_HASH/target,
// capped) from a target_hash, instead of duplicating the BigInt math in three places.
exports.weightFor = weightFor;

exports.recordShare = function (height, address, worker, shareTargetHex) {
	const weight = weightFor(shareTargetHex);
	const member = address + (worker ? '~' + worker : '');
	const dateNow = Date.now();
	const dateNowSeconds = dateNow / 1000 | 0;

	redisClient.zincrby('HAC:round:' + height + ':scores', weight, member, (err) => {
		if (err) log('error', 'shares', 'zincrby failed: %s', [err.message]);
	});
	redisClient.hincrby('HAC:workers:' + member, 'shares', 1, () => {});
	redisClient.hincrby('HAC:workers:' + member, 'hashes', weight, () => {});
	redisClient.hset('HAC:workers:' + member, 'lastShare', dateNowSeconds, () => {});

	// Live hashrate zset -- SAME format as every other dvandal-template coin here (see
	// veil-nodejs-pool / qwc-nodejs-pool lib/shares.js, which both have this identical pair of
	// lines): score=unix seconds (so api.js can trim stale entries with zremrangebyscore), member=
	// "weight:login[~worker]:timestampMs:rewardType:algo". This pool is PROP-only (no solo mode)
	// and mines only x16rs, so those last two fields are always constant here.
	redisClient.zadd('HAC:hashrate', dateNowSeconds, [weight, address, dateNow, 'prop', 'x16rs'].join(':'), (err) => {
		if (err) log('error', 'shares', 'hashrate zadd failed: %s', [err.message]);
	});
	if (worker) {
		redisClient.zadd('HAC:hashrate', dateNowSeconds, [weight, address + '~' + worker, dateNow, 'prop', 'x16rs'].join(':'), (err) => {
			if (err) log('error', 'shares', 'hashrate zadd (worker) failed: %s', [err.message]);
		});
	}
};

exports.recordInvalid = function (address, worker) {
	const member = address + (worker ? '~' + worker : '');
	redisClient.hincrby('HAC:workers:' + member, 'invalidShares', 1, () => {});
};

/** hash/difficulty: the winning share's real hash and the real network difficulty (MAX_HASH/
 * target_hash) at the moment the block was found -- used only to give the matured block entry
 * (see blockUnlocker.js) real values for the website's blocks table / luck %, not for accounting. */
exports.recordBlockFound = function (height, finderAddress, finderWorker, hash, difficulty) {
	redisClient.hsetnx('HAC:blocks:candidates', String(height), JSON.stringify({
		height, finder: finderAddress, worker: finderWorker, hash: hash || '', difficulty: difficulty || 0, time: Date.now(),
	}), (err, wasSet) => {
		if (err) return log('error', 'shares', 'recordBlockFound failed: %s', [err.message]);
		if (!wasSet) log('warn', 'shares', 'Block %d already recorded as a candidate -- ignoring duplicate', [height]);
	});
};
