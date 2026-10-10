/**
 * Hacash (HAC) Pool -- module=payments
 *
 * HONEST STATUS (2026-10-10): this does NOT send real transactions yet. Hacash's own transaction
 * format (StdTransaction, secp256k1-rfc6979-sha256 signing, its own fee/gas pricing unit system --
 * see field/src/types/amount.rs) is a real, separate implementation task that was out of scope
 * for getting the pool itself proven end to end, and was not attempted. This module only reports
 * what WOULD be paid, from the real balances blockUnlocker.js already credits correctly. Treat
 * `dryRun` as effectively hardcoded true until real signing/broadcast is built and tested with a
 * real transaction accepted by the node -- do not flip it based on config alone.
 **/
const redisClient = require('redis').createClient(config.redis.port, config.redis.host, {
	auth_pass: config.redis.auth,
});

const logSystem = 'payments';
function log_(level, msg, args) { log(level, logSystem, msg, args || []); }

const minPayment = (config.payments && config.payments.minPayment) || 1;

function tick() {
	redisClient.keys('HAC:workers:*', (err, keys) => {
		if (err || !keys || !keys.length) return;
		const multi = redisClient.multi();
		keys.forEach((k) => multi.hget(k, 'balance'));
		multi.exec((err2, balances) => {
			if (err2) return;
			let due = 0, dueCount = 0;
			keys.forEach((k, i) => {
				const bal = parseFloat(balances[i]) || 0;
				if (bal >= minPayment) { due += bal; dueCount++; }
			});
			if (dueCount > 0) {
				log_('info', 'DRY RUN: would pay %d worker(s), %d HAC total -- real transaction signing/broadcast is not implemented for this coin yet', [dueCount, due]);
			}
		});
	});
}

setInterval(tick, (config.payments && config.payments.interval || 600) * 1000);
tick();
