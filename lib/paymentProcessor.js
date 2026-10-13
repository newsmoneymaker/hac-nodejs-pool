/**
 * Hacash (HAC) Pool -- module=payments
 *
 * REAL transaction signing/broadcast (2026-10-13). The node itself does the cryptographic work
 * (StdTransaction / secp256k1-rfc6979-sha256 signing) via its own HTTP API -- this module never
 * touches raw crypto, it only calls:
 *   GET  /create/coin/transfer  -- builds + SIGNS a real tx with the pool's own private key
 *   GET  /query/fee/average     -- the real, live-moving network fee floor, for a safe flat fee
 *   POST /submit/transaction    -- actually broadcasts the signed tx (raw bytes body, not hex text)
 * (see hacashRpc.js for the exact request/response shapes, confirmed against the real live node.)
 *
 * Per due worker: build once with a placeholder fee just to learn the real signed-tx size, ask
 * /query/fee/average for a safe flat fee for that size (extra9=true -- the node's own 10x-over-
 * current-minimum suggestion, so it tracks the real minimum at payout time instead of a number
 * that goes stale), then build the REAL tx with that fee and either log it (dryRun) or broadcast
 * it. The fee is eaten out of the MINER's own payout, not the pool's cut -- same default this
 * project already uses elsewhere (tdc/qwc paymentProcessor.js's minerPayFee defaults to true):
 * blockUnlocker.poolFee is already taken once, at block maturity; piling a second, separate
 * network-tx fee onto the pool's margin on every payout cycle with no cap would be a different and
 * uncapped cost, whereas a few atoms of HAC off an individual payout is not.
 *
 * Crash safety: unlike tdc/qwc (one batched sendmany covering many accounts, with a "pending"
 * ledger + reconciliation against the wallet's tx log because a crash mid-flight could otherwise
 * double- or never-pay a whole batch), HAC pays ONE worker with ONE already-fully-built-and-signed
 * tx per call, and the redis balance is only ever decremented AFTER /submit/transaction answers
 * ret:0. A crash before that point simply means nothing was sent and nothing was recorded --
 * the worker is retried next tick, never double-paid. The only real crash window is the single
 * synchronous gap between getting ret:0 back and the redis write actually landing (an in-flight tx
 * whose payment record never gets written) -- small enough, and rare enough, not to warrant a
 * whole pending-state ledger for a first real implementation. Flagged honestly, not over-built.
 *
 * dryRun (config.payments.dryRun, default true): the REAL build+sign call always runs either way
 * (so an operator can watch real signed tx hashes come out before ever broadcasting anything) --
 * only the broadcast (/submit/transaction) is skipped while dryRun is true. Flip it only after a
 * real block has matured and there is real balance to test a real send with.
 **/
const fs = require('fs');
const rpc = require('./hacashRpc.js');
const redisClient = require('redis').createClient(config.redis.port, config.redis.host, {
	auth_pass: config.redis.auth,
});

const logSystem = 'payments';
function log_(level, msg, args) { log(level, logSystem, msg, args || []); }

const COIN = 'HAC';
const pc = config.payments || {};
const minPayment = pc.minPayment || 1;
const dryRun = pc.dryRun !== false; // anything but an explicit false means: do not broadcast
const maxPerTick = pc.maxPaymentsPerTick || 10; // sequential, small-batch -- see module docstring

log_('info', 'Started%s: min payment %s HAC, at most %d worker(s) paid per cycle, every %ds',
	[dryRun ? ' in DRY RUN mode (real signing runs, nothing is ever broadcast)' : '', minPayment, maxPerTick, (pc.interval || 600)]);

// The node's /create/coin/transfer does NOT validate main_prikey's format -- confirmed live
// 2026-10-13: feeding it garbage ("nothex123", "aabbcc") still returns {"ret":0,...} with a real-
// looking signed body, just silently derived from a DIFFERENT address nobody here controls. If
// this pool didn't check the shape itself, a corrupted/truncated secrets file would sign
// real-looking transactions from the wrong identity instead of ever erroring. So: enforce the
// expected 64-hex-char secp256k1 key shape here, before the key is ever handed to the node.
const PRIVATE_KEY_RE = /^[0-9a-fA-F]{64}$/;

let privateKey = null;
(function loadPrivateKey() {
	const keyFile = pc.privateKeyFile;
	if (!keyFile) {
		log_('error', 'payments.privateKeyFile is not configured -- this module will stay idle (no real or dry-run signing is possible without the pool\'s own private key)');
		return;
	}
	let raw;
	try {
		raw = fs.readFileSync(keyFile, 'utf8').trim();
	} catch (e) {
		log_('error', 'Cannot read payments.privateKeyFile %s: %s -- this module will stay idle', [keyFile, e.message]);
		return;
	}
	if (!PRIVATE_KEY_RE.test(raw)) {
		log_('error', '%s does not contain a plain 64-hex-char private key -- refusing to use it (see this module\'s docstring on why the node won\'t catch this for us). This module will stay idle.', [keyFile]);
		return;
	}
	privateKey = raw;
	// Never log the key itself -- only that it loaded, and never its value.
	log_('info', 'Private key loaded from %s', [keyFile]);
})();

function promiseHgetAllBalances(keys) {
	return new Promise((resolve, reject) => {
		const multi = redisClient.multi();
		keys.forEach((k) => multi.hget(k, 'balance'));
		multi.exec((err, balances) => err ? reject(err) : resolve(balances));
	});
}

function promiseKeys(pattern) {
	return new Promise((resolve, reject) => {
		redisClient.keys(pattern, (err, keys) => err ? reject(err) : resolve(keys || []));
	});
}

/** colon-joined layout every dvandal-template coin's js/common.js payments_ParsePayment() expects:
 * hash:amount:fee:mixin:recipients:height (see tdc-nodejs-pool/lib/paymentProcessor.js's complete()
 * for the identical shape on a coin that already pays real money). mixin is always 0 (HAC has no
 * ring signatures); recipients is always 1 (one tx per worker here, never batched). height is the
 * chain height AT BROADCAST TIME, not a confirmed inclusion height -- this module does not track
 * confirmations (same honestly-flagged gap as blockUnlocker.js's "no orphan detection yet"), so
 * it's only ever approximate, same spirit as that module's docstring.
 *
 * amount/fee are stored as plain decimal HAC (not atomic units) -- the SAME convention
 * blockUnlocker.js already uses for the `balance` field (hincrbyfloat, not atoms) and api.js's
 * config already declares (coinUnits: 1). The website's getReadableCoin() does `parseInt(amount)`
 * before dividing by coinUnits, which truncates any fractional HAC in the display -- a pre-existing
 * quirk of this coin's whole unit setup (balance already has the exact same issue), not something
 * newly introduced here; fixing it would mean redesigning the unit convention this coin already
 * committed to everywhere else, which is out of scope for wiring up real payments.
 **/
function recordPayment(member, address, grossAmount, netSent, fee, txHash, heightAtSend) {
	const now = Math.floor(Date.now() / 1000);
	const paymentMember = [txHash, netSent, fee, 0, 1, heightAtSend || 0].join(':');
	const multi = redisClient.multi();
	multi.hincrbyfloat(COIN + ':workers:' + member, 'balance', -grossAmount);
	multi.zadd(COIN + ':payments:all', now, paymentMember);
	multi.zadd(COIN + ':payments:' + address, now, paymentMember);
	multi.exec((err) => {
		if (err) log_('error', 'Paid %s but FAILED to record it in redis (the tx %s is ALREADY broadcast on-chain -- needs a manual fix): %s', [member, txHash, err.message]);
		else log_('info', 'Paid %s HAC to %s (%s), network fee %s HAC, tx %s', [netSent, address, member, fee, txHash]);
	});
}

/** Build, price, and (if not dryRun) broadcast ONE worker's payout. Never throws -- every failure
 * path logs the real node error and returns, leaving the balance untouched for a later retry. */
async function payWorker(member, address, amountDue, heightAtSend) {
	// Step 1: build with a throwaway minimal fee, purely to learn the real signed body's byte size
	// (fee amount barely moves tx size, but this measures the real thing instead of guessing it).
	let probe;
	try {
		probe = await rpc.createTransfer(privateKey, address, amountDue.toFixed(8), '0.00000001');
	} catch (e) {
		log_('error', 'Size-probe build failed for %s (%s HAC to %s): %s -- balance untouched', [member, amountDue, address, e.message]);
		return;
	}
	if (!probe || probe.ret !== 0 || !probe.body) {
		log_('error', 'Size-probe build rejected for %s (%s HAC to %s): %s -- balance untouched', [member, amountDue, address, (probe && (probe.err || probe.error)) || JSON.stringify(probe)]);
		return;
	}
	const sizeBytes = probe.body.length / 2;

	// Step 2: a real, currently-safe flat fee for a tx this size -- see hacashRpc.js's feeAverage
	// doc for why extra9's 10x-over-the-live-minimum is used instead of a hardcoded number.
	let feeResp;
	try {
		feeResp = await rpc.feeAverage(sizeBytes);
	} catch (e) {
		log_('error', 'fee/average query failed for %s: %s -- balance untouched', [member, e.message]);
		return;
	}
	if (!feeResp || feeResp.ret !== 0 || !feeResp.feasible) {
		log_('error', 'fee/average query rejected for %s: %s -- balance untouched', [member, (feeResp && (feeResp.err || feeResp.error)) || JSON.stringify(feeResp)]);
		return;
	}
	const fee = parseFloat(feeResp.feasible);
	const netSend = amountDue - fee;
	if (!(netSend > 0)) {
		log_('warn', '%s is owed %s HAC, which does not cover the current %s HAC network fee yet -- left on the balance for a later, larger payout', [member, amountDue, fee]);
		return;
	}

	// Step 3: the REAL tx, built with the real fee -- this is what actually gets signed and (if
	// not dryRun) broadcast.
	let real;
	try {
		real = await rpc.createTransfer(privateKey, address, netSend.toFixed(8), fee.toFixed(8));
	} catch (e) {
		log_('error', 'Real build failed for %s (%s HAC to %s): %s -- balance untouched', [member, netSend, address, e.message]);
		return;
	}
	if (!real || real.ret !== 0 || !real.body) {
		log_('error', 'Real build rejected for %s (%s HAC to %s): %s -- balance untouched', [member, netSend, address, (real && (real.err || real.error)) || JSON.stringify(real)]);
		return;
	}

	if (dryRun) {
		log_('info', '[DRY RUN] would send %s HAC (fee %s HAC) to %s (%s) -- real signed tx built, hash %s, NOT broadcast', [netSend, fee, member, address, real.hash]);
		return;
	}

	let submitResp;
	try {
		submitResp = await rpc.submitTransaction(real.body);
	} catch (e) {
		log_('error', 'Broadcast request failed for %s (%s HAC to %s, tx %s): %s -- balance untouched, will retry next cycle', [member, netSend, address, real.hash, e.message]);
		return;
	}
	if (!submitResp || submitResp.ret !== 0) {
		log_('error', 'Broadcast REJECTED for %s (%s HAC to %s, tx %s): %s -- balance untouched, will retry next cycle', [member, netSend, address, real.hash, (submitResp && (submitResp.err || submitResp.error)) || JSON.stringify(submitResp)]);
		return;
	}

	recordPayment(member, address, amountDue, netSend, fee, submitResp.hash || real.hash, heightAtSend);
}

async function tick() {
	if (!privateKey) {
		log_('warn', 'No valid private key loaded -- skipping this payout cycle entirely (see the error logged at startup)');
		return;
	}

	let keys;
	try {
		keys = await promiseKeys(COIN + ':workers:*');
	} catch (e) {
		log_('error', 'Could not list workers: %s', [e.message]);
		return;
	}
	if (!keys.length) return;

	let balances;
	try {
		balances = await promiseHgetAllBalances(keys);
	} catch (e) {
		log_('error', 'Could not read balances: %s', [e.message]);
		return;
	}

	const prefixLen = (COIN + ':workers:').length;
	const due = [];
	keys.forEach((k, i) => {
		const bal = parseFloat(balances[i]) || 0;
		if (bal < minPayment) return;
		const member = k.substr(prefixLen);
		// member = address[~worker] (same convention shares.js/blockUnlocker.js already use) --
		// the part before '~' is the real Hacash address that actually gets paid; a worker-level
		// key is a VIEW into the same miner's earnings, not a separate payable account. If both
		// "addr" and "addr~rig1" happen to carry balance (shouldn't under normal operation, since
		// shares.js only ever credits "addr" or "addr~worker" consistently per login, never both
		// for the same miner), each is still paid to the SAME underlying address -- harmless, just
		// two transactions instead of one.
		const address = member.split('~')[0];
		due.push({ member, address, amount: bal });
	});
	if (!due.length) return;

	let heightAtSend = 0;
	try {
		const h = await rpc.chainHeight();
		if (h && h.ret === 0) heightAtSend = h.height;
	} catch (e) {
		log_('warn', 'Could not read chain height for payment records (non-fatal, records this cycle will show height 0): %s', [e.message]);
	}

	const batch = due.slice(0, maxPerTick);
	if (due.length > batch.length) {
		log_('info', '%d worker(s) due, paying the first %d this cycle (the rest follow on a later cycle)', [due.length, batch.length]);
	}

	for (const d of batch) {
		try {
			await payWorker(d.member, d.address, d.amount, heightAtSend);
		} catch (e) {
			log_('error', 'Unexpected error paying %s: %s -- continuing with the rest of this cycle', [d.member, e.message]);
		}
	}
}

setInterval(() => { tick().catch((e) => log_('error', 'tick() crashed: %s', [e.message])); }, (pc.interval || 600) * 1000);
tick().catch((e) => log_('error', 'tick() crashed: %s', [e.message]));
