/**
 * Hacash (HAC) Pool -- module=api
 *
 * Minimal /stats endpoint, same rough shape as every other pool here (network/pool/lastblock),
 * adapted to what actually exists for this coin (no "difficulty" field in the Bitcoin sense --
 * Hacash's target_hash IS the difficulty, shown as the real network target plus our own derived
 * share target).
 **/
const http = require('http');
const rpc = require('./hacashRpc.js');
const reward = require('./reward.js');
const redisClient = require('redis').createClient(config.redis.port, config.redis.host, {
	auth_pass: config.redis.auth,
});

function sendJson(res, obj) {
	const body = JSON.stringify(obj);
	res.writeHead(200, {
		'Access-Control-Allow-Origin': '*',
		'Content-Type': 'application/json',
		'Content-Length': Buffer.byteLength(body, 'utf8'),
	});
	res.end(body);
}

async function handleStats(res) {
	let work = null;
	try { work = await rpc.pendingWork(); } catch (e) { /* node unreachable */ }

	redisClient.hlen('HAC:blocks:candidates', (err, blockCount) => {
		// Also expose a plain numeric "difficulty" (MAX_HASH / target, same 2^256-1 MAX_HASH pool.js
		// itself already uses for share-target math) under the SAME network.difficulties[algo_key]
		// shape every other pool here uses -- lets monitor/profitability.py's generic machinery read
		// this coin without a special case, instead of only exposing the raw target_hash.
		let difficulty = null;
		if (work && work.ret === 0 && work.target_hash) {
			const MAX_HASH = (1n << 256n) - 1n;
			const t = BigInt('0x' + work.target_hash);
			difficulty = t > 0n ? Number(MAX_HASH / t) : null;
		}
		sendJson(res, {
			pool: { coin: 'HAC' },
			network: {
				height: work && work.ret === 0 ? work.height : null,
				target: work && work.ret === 0 ? work.target_hash : null,
				difficulties: { x16rs: difficulty },
			},
			lastblock: {
				reward: work && work.ret === 0 ? reward.blockRewardWholeHac(work.height) : null,
			},
			blocksFound: blockCount || 0,
		});
	});
}

function handleGetBlocks(res, query) {
	const maxHeight = query.height ? '(' + query.height : '+inf';
	redisClient.zrevrangebyscore('HAC:blocks:matured', maxHeight, '-inf', 'LIMIT', 0, (config.api && config.api.blocks) || 30, (err, result) => {
		sendJson(res, err ? { error: 'Query failed' } : (result || []));
	});
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url, 'http://x');
	if (url.pathname === '/stats') return handleStats(res);
	if (url.pathname === '/get_blocks') return handleGetBlocks(res, Object.fromEntries(url.searchParams));
	res.writeHead(404); res.end('not found');
});

server.listen(config.api.port, () => {
	log('info', 'api', 'Hacash pool API listening on port %d', [config.api.port]);
});
