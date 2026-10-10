/**
 * Load the config.json whose path follows -config= on the command line (same CLI convention as
 * every other pool here, e.g. `init.js -module=pool -config=config.json`).
 **/
const fs = require('fs');

global.version = 'v1.0.0';

const configFile = (() => {
	for (const arg of process.argv) {
		if (arg.indexOf('-config=') === 0) return arg.substr('-config='.length);
	}
	return 'config.json';
})();

global.config = JSON.parse(fs.readFileSync(configFile, { encoding: 'utf8' }));
