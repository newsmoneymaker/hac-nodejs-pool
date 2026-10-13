/**
 * HTTP client for Hacash's own mining API (no Stratum, no JSON-RPC envelope -- plain query-string
 * GET routes that return {"ret":0,...} on success or {"ret":1,"err":"..."} on failure).
 * See mint/src/api/util/miner.rs and mint/src/api/miner.rs on the node for the real route shapes.
 **/
const http = require('http');
const querystring = require('querystring');

function get(path, query) {
	const qs = query ? '?' + querystring.stringify(query) : '';
	return new Promise((resolve, reject) => {
		const req = http.get({
			host: config.daemon.host,
			port: config.daemon.port,
			path: path + qs,
			timeout: config.daemon.timeout || 8000,
		}, (res) => {
			let body = '';
			res.on('data', (d) => body += d);
			res.on('end', () => {
				try {
					resolve(JSON.parse(body));
				} catch (e) {
					reject(new Error('bad JSON from node: ' + e.message + ' body=' + body.slice(0, 200)));
				}
			});
		});
		req.on('timeout', () => { req.destroy(new Error('node request timed out')); });
		req.on('error', reject);
	});
}

/** GET /query/miner/pending?detail=true -- the current block template to mine. */
exports.pendingWork = function () {
	return get('/query/miner/pending', { detail: 'true' });
};

/** GET /submit/miner/success -- a winning nonce; the node validates+accepts synchronously. */
exports.submitSuccess = function (height, blockNonce, coinbaseNonce) {
	return get('/submit/miner/success', { height, block_nonce: blockNonce, coinbase_nonce: coinbaseNonce });
};

/** GET /query/block/height/latest -- real route (api/src/chain.rs, ChainApi); used by
 * blockUnlocker to judge maturity depth. */
exports.chainHeight = function () {
	return get('/query/block/height/latest');
};

/** POST /submit/transaction -- real route (mint/src/api/query/tx.rs, submit_transaction_handler).
 * Confirmed live (2026-10-13): the body must be the RAW SIGNED BYTES (Buffer.from(hex, 'hex')),
 * NOT the hex string itself -- posting the hex text verbatim gets back {"ret":1,"err":"transaction
 * parse failed"} every time; body_data_may_hex apparently only recognizes a literal "0x..." form or
 * similar, not a bare hex string, so this pool always sends raw bytes to avoid relying on that. */
function post(path, bodyBuffer) {
	return new Promise((resolve, reject) => {
		const req = http.request({
			host: config.daemon.host,
			port: config.daemon.port,
			path,
			method: 'POST',
			timeout: config.daemon.timeout || 8000,
			headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': bodyBuffer.length },
		}, (res) => {
			let body = '';
			res.on('data', (d) => body += d);
			res.on('end', () => {
				try {
					resolve(JSON.parse(body));
				} catch (e) {
					reject(new Error('bad JSON from node: ' + e.message + ' body=' + body.slice(0, 200)));
				}
			});
		});
		req.on('timeout', () => { req.destroy(new Error('node request timed out')); });
		req.on('error', reject);
		req.end(bodyBuffer);
	});
}

/** GET /create/coin/transfer -- builds and SIGNS a real StdTransaction using the given raw private
 * key (plain 64-hex-char secp256k1 key, NOT validated by the node -- see paymentProcessor.js's own
 * validation before ever calling this). hacash/fee are plain decimal HAC strings (Amount::from(),
 * "mei" units -- "0.05" means 0.05 whole HAC), confirmed live 2026-10-13. Returns
 * {"ret":0,"hash":...,"hash_with_fee":...,"timestamp":...,"body":"<hex>"} or {"ret":1,"err":...}. */
exports.createTransfer = function (mainPrikey, toAddress, hacashAmount, feeAmount) {
	return get('/create/coin/transfer', {
		main_prikey: mainPrikey, to_address: toAddress, hacash: hacashAmount, fee: feeAmount,
	});
};

/** POST /submit/transaction with the raw signed bytes from createTransfer's "body" hex field.
 * Returns {"ret":0,"hash":...} or {"ret":1,"err":"<real node error text>"}. */
exports.submitTransaction = function (bodyHex) {
	return post('/submit/transaction', Buffer.from(bodyHex, 'hex'));
};

/** GET /query/fee/average?consumption=<bytes> -- real current network fee-per-byte ("purity", in
 * the chain's u232 pricing sub-unit = 10^-16 HAC), confirmed live 2026-10-13 to be IDENTICAL to the
 * node's own currently-enforced txpool minimum (mint/src/api/query/tx.rs reads
 * ctx.node.txpool().min_fee_purity() for admission, which read back as the exact same number this
 * route reports as "purity"). With `consumption` set to the tx's real byte size and extra9=true, the
 * node computes "feasible": a flat HAC fee already priced at 10x that average/minimum -- verified
 * live: consumption=159, extra9=true -> feasible=0.000957816, and avgfeep(6024000000)*10/1e16*159
 * matches exactly. That 10x headroom (chosen by the node's own route, not invented by this pool) is
 * why paymentProcessor.js uses extra9=true rather than hand-rolling its own multiplier: it tracks
 * whatever the real minimum is AT PAYOUT TIME, not a number that goes stale. */
exports.feeAverage = function (consumptionBytes) {
	return get('/query/fee/average', { consumption: consumptionBytes, extra9: 'true', unit: 'mei' });
};
