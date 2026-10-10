/**
 * Hacash (HAC) Pool
 *
 * Hacash has no Stratum protocol at all -- the node exposes a plain HTTP polling API
 * (/query/miner/pending, /submit/miner/success; see hacashRpc.js) meant for a single solo
 * miner. This file is the ONE piece of real protocol design in this pool: a small newline-
 * delimited JSON-RPC TCP server, deliberately shaped like Stratum's own
 * subscribe/authorize/notify/submit so that porting a future poolpayminer client to it later
 * is a much smaller step than inventing something unrelated.
 *
 *   -> {"id":1,"method":"mining.subscribe","params":["<agent>"]}
 *   <- {"id":1,"result":true,"error":null}
 *   -> {"id":2,"method":"mining.authorize","params":["<address>","<worker>"]}
 *   <- {"id":2,"result":true,"error":null}
 *   <- {"id":null,"method":"mining.notify","params":{"job_id","height","intro","target","repeat"}}
 *       (intro: block_intro hex with the nonce field already zeroed; target: the POOL's own
 *        easier share target, NOT the real network target -- see shareTargetHex() below)
 *   -> {"id":3,"method":"mining.submit","params":["<worker>","<job_id>","<nonce hex, 8 chars>"]}
 *   <- {"id":3,"result":true/false,"error":null|"<reason>"}
 *
 * The pool polls the node every config.poolServer.pollIntervalMs and broadcasts a fresh job on
 * every poll (not only on height change): the node bumps coinbase_nonce -- and therefore the
 * merkle root, and therefore the whole intro -- on every single /query/miner/pending call (see
 * minter.rs, miner_pending_work: `Self::increase_nonce(&mut stuff.coinbase_nonce)` runs every
 * time), so there is no such thing as "the same job" across two polls.
 **/
const net = require('net');
const crypto = require('crypto');
const rpc = require('./hacashRpc.js');
const blockBuilder = require('./blockBuilder.js');
const shares = require('./shares.js');

const logSystem = 'pool';
function log_(level, msg, args) { log(level, logSystem, msg, args || []); }

let currentJob = null; // {jobId, height, introZeroed(Buffer), targetHex, shareTargetHex, coinbaseNonce}
let jobCounter = 0;
const miners = new Set(); // connected sockets with their own small state object attached

const MAX_HASH = (1n << 256n) - 1n;

function toHex64(n) {
	let h = n.toString(16);
	while (h.length < 64) h = '0' + h;
	return h;
}

/** The pool's own, deliberately easier, share target: realTarget * shareDiffFactor (clamped to
 * the maximum possible 256-bit value). A SMALLER target is harder (fewer hashes satisfy it), so
 * multiplying up makes the share target easier to hit than the real network target, letting us
 * credit partial work between real blocks -- same role vardiff/share-difficulty plays for every
 * other coin here, just computed directly from the real target instead of a separate diff unit. */
function shareTargetHex(realTargetHex) {
	const factor = BigInt(config.poolServer.shareDifficultyFactor || 256);
	let t = BigInt('0x' + realTargetHex) * factor;
	if (t > MAX_HASH) t = MAX_HASH;
	return toHex64(t);
}

function broadcastJob() {
	const payload = JSON.stringify({ id: null, method: 'mining.notify', params: {
		job_id: currentJob.jobId,
		height: currentJob.height,
		intro: currentJob.introZeroed.toString('hex'),
		target: currentJob.shareTargetHex,
		repeat: blockBuilder.repeatFor(currentJob.height),
	} }) + '\n';
	for (const m of miners) {
		if (m.authorized) {
			try { m.socket.write(payload); } catch (e) { /* socket likely already closing */ }
		}
	}
}

async function pollLoop() {
	try {
		const work = await rpc.pendingWork();
		if (work.ret !== 0) {
			log_('warn', 'pending work query failed: %s', [work.err || JSON.stringify(work)]);
			return;
		}
		const introBuf = Buffer.from(work.block_intro, 'hex');
		// Zero the nonce field before handing it to miners -- it's whatever the node last left
		// there (usually 0 on a fresh template), and must not be mistaken for a real candidate.
		introBuf.writeUInt32BE(0, blockBuilder.NONCE_OFFSET);
		currentJob = {
			jobId: 'j' + (++jobCounter),
			height: work.height,
			introZeroed: introBuf,
			targetHex: work.target_hash,
			shareTargetHex: shareTargetHex(work.target_hash),
			coinbaseNonce: work.coinbase_nonce,
		};
		broadcastJob();
	} catch (e) {
		log_('error', 'poll failed: %s', [e.message]);
	}
}

function reply(socket, id, result, error) {
	socket.write(JSON.stringify({ id, result: result === undefined ? null : result, error: error || null }) + '\n');
}

async function onSubmit(m, msg) {
	const [worker, jobId, nonceHex] = msg.params || [];
	if (!m.address) return reply(m.socket, msg.id, null, 'unauthorized');
	if (!currentJob || jobId !== currentJob.jobId) return reply(m.socket, msg.id, false, 'stale job');
	if (typeof nonceHex !== 'string' || !/^[0-9a-f]{8}$/i.test(nonceHex)) return reply(m.socket, msg.id, false, 'bad nonce');
	const nonce = parseInt(nonceHex, 16);

	const key = currentJob.jobId + ':' + nonceHex;
	if (m.seenNonces.has(key)) return reply(m.socket, msg.id, false, 'duplicate share');
	m.seenNonces.add(key);

	const job = currentJob; // snapshot: don't let a job rotation mid-hash change what we compare against
	const introWithNonce = blockBuilder.withNonce(job.introZeroed, nonce);
	blockBuilder.hashCandidate(job.height, introWithNonce, async (err, hashHex) => {
		if (err) { log_('error', 'hasher error: %s', [err.message]); return reply(m.socket, msg.id, false, 'internal error'); }

		if (!blockBuilder.meetsTarget(hashHex, job.shareTargetHex)) {
			reply(m.socket, msg.id, false, 'low difficulty share');
			shares.recordInvalid(m.address, worker);
			return;
		}

		reply(m.socket, msg.id, true);
		shares.recordShare(job.height, m.address, worker, job.shareTargetHex);
		log_('info', 'Share accepted from %s worker=%s height=%d', [m.address, worker, job.height]);

		if (blockBuilder.meetsTarget(hashHex, job.targetHex)) {
			log_('info', 'BLOCK CANDIDATE height=%d nonce=%s hash=%s', [job.height, nonceHex, hashHex]);
			try {
				const res = await rpc.submitSuccess(job.height, nonce, job.coinbaseNonce);
				if (res.ret === 0) {
					log_('info', 'Block %d ACCEPTED by the node', [job.height]);
					shares.recordBlockFound(job.height, m.address, worker);
				} else {
					log_('warn', 'Block %d submission rejected by the node: %s', [job.height, res.err]);
				}
			} catch (e) {
				log_('error', 'Block submission request failed: %s', [e.message]);
			}
		}
	});
}

function handleLine(m, line) {
	let msg;
	try { msg = JSON.parse(line); } catch (e) { return; }
	if (!msg || typeof msg.method !== 'string') return;

	switch (msg.method) {
		case 'mining.subscribe': {
			m.subscribed = true;
			// Same gap found+fixed tonight on KCN/TDC/RTM/BTRM: capture+log the client's own agent string
			// (params[0]) so monitor/miner_users.py's "agent=poolpayminer" filter can see real logins here too.
			const subParams = msg.params || [];
			if (typeof subParams[0] === 'string') m.agent = subParams[0].substr(0, 60);
			reply(m.socket, msg.id, true);
			break;
		}
		case 'mining.authorize': {
			const [address, worker] = msg.params || [];
			if (typeof address !== 'string' || !address.length) return reply(m.socket, msg.id, false, 'invalid address');
			m.address = address;
			m.worker = (typeof worker === 'string' && worker.length) ? worker : null;
			m.authorized = true;
			reply(m.socket, msg.id, true);
			// "type=prop" added purely so monitor/miner_users.py's shared LOGIN_RE (which requires a literal
			// "type=" field, matching every other coin's reward-type concept) matches this coin's log lines
			// too -- this pool is PROP-only, there is no solo/other mode to actually vary here.
			log_('info', 'Miner logged in: %s worker=%s type=prop ip=%s agent=%s', [address, m.worker, m.socket.remoteAddress, m.agent || '']);
			if (currentJob) {
				m.socket.write(JSON.stringify({ id: null, method: 'mining.notify', params: {
					job_id: currentJob.jobId, height: currentJob.height,
					intro: currentJob.introZeroed.toString('hex'), target: currentJob.shareTargetHex,
					repeat: blockBuilder.repeatFor(currentJob.height),
				} }) + '\n');
			}
			break;
		}
		case 'mining.submit':
			onSubmit(m, msg);
			break;
		default:
			reply(m.socket, msg.id, null, 'unknown method');
	}
}

function startServer() {
	const server = net.createServer((socket) => {
		socket.setKeepAlive(true, 30000); // see critical-missing-tcp-keepalive.md -- dead connections must not become zombies
		socket.setNoDelay(true);
		const m = { socket, address: null, worker: null, subscribed: false, authorized: false, buffer: '', seenNonces: new Set() };
		miners.add(m);

		socket.on('data', (data) => {
			m.buffer += data.toString('utf8');
			let idx;
			while ((idx = m.buffer.indexOf('\n')) !== -1) {
				const line = m.buffer.slice(0, idx).trim();
				m.buffer = m.buffer.slice(idx + 1);
				if (line) handleLine(m, line);
			}
			if (m.buffer.length > 8192) { log_('warn', 'Disconnecting %s: line too long', [socket.remoteAddress]); socket.destroy(); }
		});
		socket.on('error', () => {});
		socket.on('close', () => { miners.delete(m); });
	});

	server.listen(config.poolServer.port, config.poolServer.host || '0.0.0.0', () => {
		log_('info', 'Hacash pool listening on %s:%d', [config.poolServer.host || '0.0.0.0', config.poolServer.port]);
	});
}

startServer();
pollLoop();
setInterval(pollLoop, config.poolServer.pollIntervalMs || 3000);
