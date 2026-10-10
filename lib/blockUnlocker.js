/**
 * Hacash (HAC) Pool -- module=unlocker
 *
 * Polls the real chain height; once a found block is buried config.blockUnlocker.depth deep
 * (default 30 -- the node's own [engine] unstable_block is only 4, so 30 is a deliberately
 * generous safety margin beyond what the node itself considers final), credits its round's
 * PROP scores proportionally to each worker's `balance` field and marks the candidate unlocked.
 * No "orphan" detection yet: this pool is new enough that reorg behavior at this depth hasn't
 * been observed in practice -- a real orphan would currently just get paid as a false positive
 * until this is revisited. Flagged honestly, not fixed yet.
 **/
const rpc = require('./hacashRpc.js');
const reward = require('./reward.js');
const redisClient = require('redis').createClient(config.redis.port, config.redis.host, {
	auth_pass: config.redis.auth,
});

const logSystem = 'unlocker';
function log_(level, msg, args) { log(level, logSystem, msg, args || []); }

const depth = (config.blockUnlocker && config.blockUnlocker.depth) || 30;
const poolFeePercent = (config.blockUnlocker && config.blockUnlocker.poolFee) || 0;

async function tick() {
	let latest;
	try {
		const h = await rpc.chainHeight();
		if (h.ret !== 0) return;
		latest = h.height;
	} catch (e) {
		log_('error', 'chain height query failed: %s', [e.message]);
		return;
	}

	redisClient.hgetall('HAC:blocks:candidates', (err, candidates) => {
		if (err || !candidates) return;
		for (const heightStr of Object.keys(candidates)) {
			const height = parseInt(heightStr, 10);
			if (latest - height < depth) continue; // not mature yet
			unlockOne(height, JSON.parse(candidates[heightStr]));
		}
	});
}

function unlockOne(height, candidate) {
	const roundKey = 'HAC:round:' + height + ':scores';
	redisClient.zrange(roundKey, 0, -1, 'WITHSCORES', (err, flat) => {
		if (err) { log_('error', 'zrange failed for round %d: %s', [height, err.message]); return; }
		const totalReward = reward.blockRewardWholeHac(height);
		const poolCut = totalReward * (poolFeePercent / 100);
		const minerPool = totalReward - poolCut;

		let total = 0;
		const scores = [];
		for (let i = 0; i < flat.length; i += 2) {
			const member = flat[i], score = parseFloat(flat[i + 1]);
			scores.push([member, score]);
			total += score;
		}
		if (total <= 0) {
			log_('warn', 'Block %d has no recorded shares -- crediting the finder with the whole reward', [height]);
			scores.push([candidate.finder + (candidate.worker ? '~' + candidate.worker : ''), 1]);
			total = 1;
		}

		const multi = redisClient.multi();
		for (const [member, score] of scores) {
			const amount = minerPool * (score / total);
			multi.hincrbyfloat('HAC:workers:' + member, 'balance', amount);
		}
		multi.del(roundKey);
		multi.hset('HAC:blocks:candidates', String(height), JSON.stringify(Object.assign({}, candidate, { unlocked: true, reward: totalReward })));
		// Matured block entry, in the SAME colon-joined "rewardType:login:hash:time:difficulty:
		// shares:orphaned:reward" layout every dvandal-template coin here uses (see
		// veil-nodejs-pool/lib/blockUnlocker.js) -- js/common.js's poolBlocks_ParseBlock() parses
		// this exact 8-field shape for the website's Pool Blocks page. No orphan detection yet
		// (see module docstring above), so orphaned is always '0'.
		const finderMember = candidate.finder + (candidate.worker ? '~' + candidate.worker : '');
		const timeSeconds = Math.floor((candidate.time || Date.now()) / 1000);
		multi.zadd('HAC:blocks:matured', height, [
			'prop', finderMember, candidate.hash || '', timeSeconds,
			candidate.difficulty || 0, Math.round(total), '0', totalReward,
		].join(':'));
		multi.exec((err2) => {
			if (err2) log_('error', 'Failed crediting block %d: %s', [height, err2.message]);
			else log_('info', 'Block %d matured and credited: %d HAC split among %d worker(s)', [height, totalReward, scores.length]);
		});
	});
}

setInterval(tick, (config.blockUnlocker && config.blockUnlocker.interval || 60) * 1000);
tick();
