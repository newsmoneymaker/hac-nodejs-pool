/**
 * Hacash (HAC) Pool -- entry point.
 * Each module runs as its own OS process (one systemd unit per module, same convention as every
 * other pool here) -- no in-process clustering needed for a pool this size.
 *   node init.js -module=pool|unlocker|payments|api -config=config.json
 **/
require('./lib/configReader.js');
require('./lib/logger.js');

const moduleName = (() => {
	for (const arg of process.argv) {
		if (arg.indexOf('-module=') === 0) return arg.substr('-module='.length);
	}
	return null;
})();

const MODULES = {
	pool: './lib/pool.js',
	unlocker: './lib/blockUnlocker.js',
	payments: './lib/paymentProcessor.js',
	api: './lib/api.js',
};

if (!MODULES[moduleName]) {
	console.error('Usage: node init.js -module=' + Object.keys(MODULES).join('|') + ' -config=config.json');
	process.exit(1);
}

log('info', 'master', 'Starting Hacash pool module: %s', [moduleName]);
require(MODULES[moduleName]);
