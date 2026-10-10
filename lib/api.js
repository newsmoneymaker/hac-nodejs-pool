/**
 * Hacash (HAC) Pool -- module=api
 *
 * Public JSON API for the website (same dvandal-template contract js/common.js expects on every
 * other pool-pay.com coin: veil, qwc, c64, keva, sal, tdc, ...), adapted to what actually exists
 * for Hacash: no cryptonote wallet RPC, no vardiff, no solo mining, a fixed-schedule reward (see
 * reward.js) instead of a halving curve, and payments that are honestly, permanently dryRun until
 * real secp256k1/rfc6979 transaction signing is built (see paymentProcessor.js's own docstring).
 *
 * Stats are recomputed on a timer (config.api.updateInterval, default 5s) into `currentStats`,
 * same pattern as cryptonote-nodejs-pool's collectStats(): one Redis round trip + one daemon call
 * per cycle, not per request. /live_stats and /stats_address?longpoll=true are true long-polls:
 * the response is held open and answered on the NEXT cycle that completes, not a busy loop.
 *
 * IMPORTANT: the Redis key PREFIX used everywhere in this pool (shares.js, blockUnlocker.js) is
 * the literal string 'HAC', not config.coin ("Hacash") -- see critical-wrong-coin-unit-scale.md.
 * monitor/active_users.py and monitor/miner_users.py also read 'HAC:hashrate' directly with this
 * exact member format, so it must not change without updating those too.
 **/
const http = require('http');
const url = require('url');
const rpc = require('./hacashRpc.js');
const reward = require('./reward.js');
const shares = require('./shares.js');
const redisClient = require('redis').createClient(config.redis.port, config.redis.host, {
	auth_pass: config.redis.auth,
});

const logSystem = 'api';
function log_(level, msg, args) { log(level, logSystem, msg, args || []); }

const COIN = 'HAC';
const apiCfg = config.api || {};
const hashrateWindow = apiCfg.hashrateWindow || 600;
const updateInterval = apiCfg.updateInterval || 5;
const blocksLimit = apiCfg.blocks || 30;
const paymentsLimit = apiCfg.payments || 30;
// Best-available estimate, not a verified Hacash consensus constant (no official source found for
// an exact target block time) -- used ONLY for the cosmetic "Network Hash Rate" display
// (difficulty / coinDifficultyTarget); every pool-side number (pool hashrate, miners, time-to-
// block estimate) is computed independently of this and is exact, not an estimate.
const coinDifficultyTarget = apiCfg.coinDifficultyTarget || 300;

let currentStats = {};
let minerStats = {}; // login[~worker] -> { hashrate }
let liveConnections = {}; // key -> http.ServerResponse, answered on the next collectStats() cycle
let addressConnections = {}; // key -> http.ServerResponse, same but for /stats_address long-polls

function sendJson(res, obj, status) {
	const body = JSON.stringify(obj);
	res.writeHead(status || 200, {
		'Access-Control-Allow-Origin': '*',
		'Cache-Control': 'no-cache',
		'Content-Type': 'application/json',
		'Content-Length': Buffer.byteLength(body, 'utf8'),
	});
	res.end(body);
}

/** Pending (not-yet-matured) block candidates, in the colon-joined layout poolBlocks_ParseBlock()
 * understands when only 6 fields are present (no orphaned/reward -> rendered as "Waiting..."/
 * pending). The round's live share total isn't tracked here (it's only finalized at maturity in
 * blockUnlocker.js), so "shares" is honestly 0 for a still-pending block -- the frontend shows
 * luck as "?" rather than a fabricated percentage. */
function pendingBlocksFlat(candidatesRaw) {
	const flat = [];
	for (const heightStr of Object.keys(candidatesRaw || {})) {
		let c;
		try { c = JSON.parse(candidatesRaw[heightStr]); } catch (e) { continue; }
		if (c.unlocked) continue;
		const member = c.finder + (c.worker ? '~' + c.worker : '');
		flat.push(['prop', member, c.hash || '', Math.floor((c.time || Date.now()) / 1000), c.difficulty || 0, 0].join(':'));
		flat.push(String(c.height));
	}
	return flat;
}

/** Collect the stats shared by every public endpoint. Runs on a timer, not per-request. */
function collectStats() {
	const startTime = Date.now();
	const windowStart = '(' + (((Date.now() / 1000) - hashrateWindow) | 0);

	const redisCommands = [
		['zremrangebyscore', COIN + ':hashrate', '-inf', windowStart],
		['zrange', COIN + ':hashrate', 0, -1],
		['hgetall', COIN + ':blocks:candidates'],
		['zrevrange', COIN + ':blocks:matured', 0, blocksLimit - 1, 'WITHSCORES'],
		['zrevrange', COIN + ':payments:all', 0, paymentsLimit - 1, 'WITHSCORES'],
		['zcard', COIN + ':payments:all'],
	];

	redisClient.multi(redisCommands).exec((err, replies) => {
		if (err) {
			log_('error', 'Redis error collecting stats: %s', [err.message]);
			setTimeout(collectStats, updateInterval * 1000);
			return;
		}

		const hashrateMembers = replies[1] || [];
		const candidatesRaw = replies[2] || {};
		const maturedFlat = replies[3] || [];
		const paymentsFlat = replies[4] || [];
		const totalPayments = parseInt(replies[5], 10) || 0;

		minerStats = {};
		const minerTotals = {};
		let poolTotalShares = 0;
		for (const m of hashrateMembers) {
			const parts = m.split(':');
			const weight = parseInt(parts[0], 10) || 0;
			const login = parts[1];
			if (!login) continue;
			minerTotals[login] = (minerTotals[login] || 0) + weight;
			poolTotalShares += weight;
		}
		let miners = 0, workers = 0;
		for (const login in minerTotals) {
			minerStats[login] = { hashrate: Math.round(minerTotals[login] / hashrateWindow) };
			if (login.indexOf('~') !== -1) workers++; else miners++;
		}
		const poolHashrate = Math.round(poolTotalShares / hashrateWindow);

		const pending = pendingBlocksFlat(candidatesRaw);
		const blocksFlat = pending.concat(maturedFlat);

		let totalBlocks = 0, totalDiff = 0, totalShares = 0, lastBlockFound = null;
		for (let i = 0; i < maturedFlat.length; i += 2) {
			const parts = maturedFlat[i].split(':');
			totalBlocks++;
			totalDiff += parseInt(parts[4], 10) || 0;
			totalShares += parseInt(parts[5], 10) || 0;
			const t = parseInt(parts[3], 10) * 1000;
			if (!lastBlockFound || t > lastBlockFound) lastBlockFound = t;
		}

		rpc.pendingWork().then((work) => {
			let network = { height: null, target: null, difficulty: 0, difficulties: { x16rs: 0 }, algorithm: 'x16rs' };
			let lastblock = { height: null, hash: null, timestamp: null, reward: null };
			if (work && work.ret === 0) {
				const difficulty = shares.weightFor(work.target_hash);
				network = { height: work.height, target: work.target_hash, difficulty, difficulties: { x16rs: difficulty }, algorithm: 'x16rs' };
				lastblock = {
					height: work.height - 1,
					hash: work.prevhash || null,
					// Approximate: the pending block's own timestamp field (set by the node to roughly
					// "now"), not a confirmed timestamp read back off the previous block -- Hacash's node
					// API has no "get block by height/hash" route this pool found to read that directly.
					timestamp: work.timestamp || (Date.now() / 1000 | 0),
					reward: reward.blockRewardWholeHac(work.height),
				};
			} else {
				log_('warn', 'pending work query failed while collecting stats: %j', [work]);
			}

			// Current round's live weighted-share total (for the round-effort display + per-miner
			// roundScore/roundHashes) -- fetched fresh each cycle for whatever height is now pending.
			const roundKey = work && work.ret === 0 ? COIN + ':round:' + work.height + ':scores' : null;
			const afterRound = (roundScores) => {
				let roundTotal = 0;
				const roundByMember = roundScores || {};
				for (const member in roundByMember) roundTotal += parseFloat(roundByMember[member]) || 0;

				currentStats = {
					pool: {
						hashrate: poolHashrate, hashrateSolo: 0,
						miners, minersSolo: 0, workers, workersSolo: 0,
						totalBlocks, totalBlocksSolo: 0, totalDiff, totalDiffSolo: 0, totalShares, totalSharesSolo: 0,
						lastBlockFound, lastBlockFoundSolo: null,
						roundScore: roundTotal, roundHashes: roundTotal,
						payments: paymentsFlat, totalPayments, totalMinersPaid: 0,
						blocks: blocksFlat,
					},
					network,
					lastblock,
					config: {
						poolHost: config.poolHost || '',
						coin: config.symbol, symbol: config.symbol,
						coinUnits: 1, coinDecimalPlaces: 8, coinDifficultyTarget,
						depth: (config.blockUnlocker && config.blockUnlocker.depth) || 30,
						fee: (config.blockUnlocker && config.blockUnlocker.poolFee) || 0,
						soloFee: 0, networkFee: 0, finderReward: 0,
						donation: {},
						version: require('../package.json').version,
						paymentsInterval: (config.payments && config.payments.interval) || 600,
						minPaymentThreshold: (config.payments && config.payments.minPayment) || 1,
						maxPaymentThreshold: null,
						transferFee: 0, denominationUnit: 1,
						slushMiningEnabled: false, weight: null,
						priceSource: null, priceCurrency: null,
						paymentIdSeparator: '.', fixedDiffEnabled: false, fixedDiffSeparator: '.',
						sendEmails: false,
						blocksChartEnabled: false, blocksChartDays: null, telegramBotName: null,
						workerSeparator: '+', algorithms: ['x16rs'],
						blockMaturity: (config.blockUnlocker && config.blockUnlocker.depth) || 30,
					},
					charts: {},
				};

				broadcastLiveStats();
				log_('info', 'Stat collection finished in %d ms', [Date.now() - startTime]);
				setTimeout(collectStats, updateInterval * 1000);
			};

			if (roundKey) redisClient.hgetall(roundKey, (err2, r) => afterRound(err2 ? null : r));
			else afterRound(null);
		}).catch((e) => {
			log_('error', 'daemon error collecting stats: %s', [e.message]);
			setTimeout(collectStats, updateInterval * 1000);
		});
	});
}

function broadcastLiveStats() {
	for (const key in liveConnections) {
		const res = liveConnections[key];
		const address = key.substr(0, key.indexOf(':'));
		const data = Object.assign({}, currentStats);
		data.miner = (address && minerStats[address]) || {};
		try { res.end(JSON.stringify(data)); } catch (e) { /* already closed */ }
	}
	liveConnections = {};

	for (const key in addressConnections) {
		const res = addressConnections[key];
		const address = key.substr(0, key.indexOf(':'));
		buildMinerData(address, (data) => {
			try { res.end(JSON.stringify(data)); } catch (e) { /* already closed */ }
		});
	}
	addressConnections = {};
}

/** Per-miner stats + payments + workers breakdown -- the real per-miner lookup. */
function buildMinerData(address, cb) {
	if (!address) return cb({ error: 'No address given. / Адрес не указан.' });

	redisClient.multi([
		['hgetall', COIN + ':workers:' + address],
		['zrevrangebyscore', COIN + ':payments:' + address, '+inf', '-inf', 'WITHSCORES', 'LIMIT', 0, paymentsLimit],
		['keys', COIN + ':workers:' + address + '~*'],
	]).exec((err, replies) => {
		if (err || !replies[0] || !Object.keys(replies[0]).length) {
			return cb({ error: 'No shares from this address yet. Enter the address your miner logs in with. / С этого адреса ещё не было шар. Введите адрес, под которым входит майнер.' });
		}

		const stats = replies[0];
		stats.hashrate = (minerStats[address] && minerStats[address].hashrate) || 0;
		stats.roundScore = 0; // per-miner round share isn't tracked separately from the pool total here
		stats.roundHashes = 0;

		const paymentsData = replies[1] || [];
		const workerKeys = replies[2] || [];

		redisClient.multi(workerKeys.map((k) => ['hgetall', k])).exec((err2, workerReplies) => {
			const workersData = [];
			for (let i = 0; i < workerKeys.length; i++) {
				const name = workerKeys[i].substr((COIN + ':workers:' + address + '~').length);
				const w = (workerReplies && workerReplies[i]) || {};
				workersData.push({
					name,
					hashrate: (minerStats[address + '~' + name] && minerStats[address + '~' + name].hashrate) || 0,
					lastShare: w.lastShare ? parseInt(w.lastShare, 10) : 0,
					hashes: w.hashes ? parseInt(w.hashes, 10) : 0,
				});
			}
			cb({ stats, payments: paymentsData, workers: workersData, charts: {} });
		});
	});
}

function handleStats(req, res, query) {
	const data = Object.assign({}, currentStats);
	data.miner = (query.address && minerStats[query.address]) || {};
	sendJson(res, data);
}

function handleLiveStats(req, res, query) {
	res.writeHead(200, {
		'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache',
		'Content-Type': 'application/json', 'Connection': 'keep-alive',
	});
	const address = query.address || 'undefined';
	const key = address + ':' + Math.random().toString();
	res.on('close', () => { delete liveConnections[key]; });
	liveConnections[key] = res;
}

function handleStatsAddress(req, res, query) {
	const address = query.address;
	const longpoll = query.longpoll === 'true';
	if (!longpoll) return buildMinerData(address, (data) => sendJson(res, data));

	res.writeHead(200, {
		'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache',
		'Content-Type': 'application/json', 'Connection': 'keep-alive',
	});
	if (!address) { res.end(JSON.stringify({ error: 'No address given. / Адрес не указан.' })); return; }
	const key = address + ':' + Math.random().toString();
	res.on('close', () => { delete addressConnections[key]; });
	addressConnections[key] = res;
}

function handleGetPayments(req, res, query) {
	// HAC payments are permanently dryRun (see paymentProcessor.js) -- this is honestly always
	// empty right now, not an error. The key exists in the Redis layout for when real signing ships.
	const key = query.address ? COIN + ':payments:' + query.address : COIN + ':payments:all';
	const maxTime = query.time ? '(' + query.time : '+inf';
	redisClient.zrevrangebyscore(key, maxTime, '-inf', 'WITHSCORES', 'LIMIT', 0, paymentsLimit, (err, result) => {
		sendJson(res, err ? { error: 'Query failed' } : (result || []));
	});
}

function handleGetBlocks(req, res, query) {
	const maxHeight = query.height ? '(' + query.height : '+inf';
	redisClient.zrevrangebyscore(COIN + ':blocks:matured', maxHeight, '-inf', 'WITHSCORES', 'LIMIT', 0, blocksLimit, (err, result) => {
		sendJson(res, err ? { error: 'Query failed' } : (result || []));
	});
}

function handleTopMiners(req, res) {
	redisClient.keys(COIN + ':workers:*', (err, workerKeys) => {
		if (err || !workerKeys) return sendJson(res, { error: 'Error collecting top 10 miners stats' });
		redisClient.multi(workerKeys.map((k) => ['hmget', k, 'lastShare', 'hashes'])).exec((err2, redisData) => {
			if (err2) return sendJson(res, { error: 'Error collecting top 10 miners stats' });
			const minersData = [];
			for (let i = 0; i < workerKeys.length; i++) {
				const member = workerKeys[i].substr((COIN + ':workers:').length);
				const data = redisData[i] || [null, null];
				minersData.push({
					miner: member.length > 24 ? member.substring(0, 10) + '...' + member.substring(member.length - 8) : member,
					hashrate: (minerStats[member] && minerStats[member].hashrate) || 0,
					lastShare: data[0], hashes: data[1],
				});
			}
			minersData.sort((a, b) => (b.hashrate || 0) - (a.hashrate || 0));
			sendJson(res, minersData.slice(0, 10));
		});
	});
}

function handleBlockExplorers(req, res) {
	// No public Hacash block/transaction explorer with a confirmed per-block or per-tx deep-link
	// pattern was found (explorer.hacash.org exists as a client-rendered dashboard, but no usable
	// URL template for a single block or transaction could be confirmed) -- left genuinely empty,
	// not guessed. js/common.js degrades to a plain, non-linked hash/id when these are blank.
	sendJson(res, { HAC: { blockchainExplorer: '', transactionExplorer: '' } });
}

function handleGetApis(req, res) {
	// HAC is not aggregated with any other coin's pool here (config.childPools doesn't exist for
	// this pool) -- empty object is the correct "no sibling pools" answer, same shape dvandal's
	// own handleGetApis returns when a pool's childPools list is empty.
	sendJson(res, {});
}

function handleMinersHashrate(req, res) {
	const data = {};
	for (const login in minerStats) {
		if (login.indexOf('~') !== -1) continue;
		data[login] = minerStats[login].hashrate;
	}
	sendJson(res, { minersHashrate: data });
}

function handleWorkersHashrate(req, res) {
	const data = {};
	for (const login in minerStats) {
		if (login.indexOf('~') === -1) continue;
		data[login] = minerStats[login].hashrate;
	}
	sendJson(res, { workersHashrate: data });
}

const ROUTES = {
	'/stats': handleStats,
	'/live_stats': handleLiveStats,
	'/stats_address': handleStatsAddress,
	'/get_payments': handleGetPayments,
	'/get_blocks': handleGetBlocks,
	'/get_top10miners': handleTopMiners,
	'/block_explorers': handleBlockExplorers,
	'/get_apis': handleGetApis,
	'/miners_hashrate': handleMinersHashrate,
	'/workers_hashrate': handleWorkersHashrate,
};

const server = http.createServer((req, res) => {
	const parsed = url.parse(req.url, true);
	const handler = ROUTES[parsed.pathname];
	if (!handler) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end('Invalid API call'); return; }
	handler(req, res, parsed.query || {});
});

server.listen(apiCfg.port, apiCfg.bindIp || '0.0.0.0', () => {
	log('info', 'api', 'Hacash pool API listening on %s:%d', [apiCfg.bindIp || '0.0.0.0', apiCfg.port]);
});

collectStats();
