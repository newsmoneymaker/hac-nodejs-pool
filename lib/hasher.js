/**
 * Hacash (HAC) Pool
 *
 * Wrapper around the x16rshash helper (hasher/x16rshash.cpp, vendored verbatim from the real
 * x16rs-sys crate the node itself links -- see hasher/x16rs-src/). Protocol:
 *   hash(loopnum, sha3hex, cb)   cb(err, hashHex): the 32-byte x16rs_hash of an already-sha3-256'd
 *                                32-byte input, as a hex string (big-endian, same byte order the
 *                                node compares against target_hash with -- see blockBuilder.js).
 * Settings in config.hasher: {path, threads}: `threads` helper processes, requests go round robin.
 * A helper is restarted if it dies.
 **/
let spawn = require('child_process').spawn;
let path = require('path');

let hasherConfig = config.hasher || {};
let log_ = function (level, text, args) { log(level, 'hasher', text, args || []); };

let helpers = [];
let next = 0;
let nextId = 1;

function start (index) {
	let file = hasherConfig.path || path.join(__dirname, '..', 'hasher', 'x16rshash');
	let helper = {index: index, child: null, buffer: '', pending: new Map(), restartTimer: null};
	helpers[index] = helper;

	let child = spawn(file, [], {stdio: ['pipe', 'pipe', 'inherit']});
	helper.child = child;
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', function (data) {
		helper.buffer += data;
		let idx;
		while ((idx = helper.buffer.indexOf('\n')) !== -1) {
			let line = helper.buffer.slice(0, idx);
			helper.buffer = helper.buffer.slice(idx + 1);
			let parts = line.split(' ');
			if (parts[0] !== 'H') continue;
			let cb = helper.pending.get(parts[1]);
			if (!cb) continue;
			helper.pending.delete(parts[1]);
			if (parts[2] === 'err' || !parts[2]) cb(new Error('hasher error')); else cb(null, parts[2]);
		}
	});
	child.stdin.on('error', function () {});
	child.on('error', function (err) {
		log_('error', 'Cannot run %s: %s', [file, err.message]);
	});
	child.on('exit', function (code, signal) {
		log_('error', 'x16rshash exited (code %s, signal %s), restarting in 3 s', [code, signal]);
		helper.child = null;
		helper.pending.forEach(function (cb) { cb(new Error('hasher restarted')); });
		helper.pending.clear();
		clearTimeout(helper.restartTimer);
		helper.restartTimer = setTimeout(function () { start(index); }, 3000);
	});
}

let threads = Math.max(1, hasherConfig.threads || 1);
for (let i = 0; i < threads; i++) start(i);

/** loopnum: the X16R repeat count (see blockBuilder.js's repeatFor(height)).
 *  sha3Hex: 64 hex chars, the sha3-256 of the (nonce-spliced) block_intro bytes. */
exports.hash = function (loopnum, sha3Hex, cb) {
	let helper = helpers[next];
	next = (next + 1) % helpers.length;
	if (!helper || !helper.child) return cb(new Error('hasher not running'));
	let id = String(nextId++);
	helper.pending.set(id, cb);
	helper.child.stdin.write('H ' + id + ' ' + loopnum + ' ' + sha3Hex + '\n');
};
