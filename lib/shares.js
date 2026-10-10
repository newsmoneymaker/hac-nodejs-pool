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

exports.recordShare = function (height, address, worker, shareTargetHex) {
	const weight = weightFor(shareTargetHex);
	const member = address + (worker ? '~' + worker : '');
	redisClient.zincrby('HAC:round:' + height + ':scores', weight, member, (err) => {
		if (err) log('error', 'shares', 'zincrby failed: %s', [err.message]);
	});
	redisClient.hincrby('HAC:workers:' + member, 'shares', 1, () => {});
};

exports.recordInvalid = function (address, worker) {
	const member = address + (worker ? '~' + worker : '');
	redisClient.hincrby('HAC:workers:' + member, 'invalidShares', 1, () => {});
};

exports.recordBlockFound = function (height, finderAddress, finderWorker) {
	redisClient.hsetnx('HAC:blocks:candidates', String(height), JSON.stringify({
		height, finder: finderAddress, worker: finderWorker, time: Date.now(),
	}), (err, wasSet) => {
		if (err) return log('error', 'shares', 'recordBlockFound failed: %s', [err.message]);
		if (!wasSet) log('warn', 'shares', 'Block %d already recorded as a candidate -- ignoring duplicate', [height]);
	});
};
