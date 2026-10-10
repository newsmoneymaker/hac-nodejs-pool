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
