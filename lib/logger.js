/**
 * Minimal logger: level, system tag, printf-style message. Matches the shape every other
 * coin's pool.js/api.js/etc already calls (`log('info', logSystem, 'msg %s', [arg])`), just
 * without the cryptonote-nodejs-pool legacy color/multi-transport machinery this coin doesn't need.
 **/
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const configuredLevel = LEVELS[(global.config && global.config.logging && global.config.logging.level) || 'info'];

function format(msg, args) {
	if (!args || !args.length) return msg;
	let i = 0;
	return msg.replace(/%[sd]/g, () => (i < args.length ? args[i++] : ''));
}

global.log = function (level, system, msg, args) {
	const lvl = LEVELS[level] !== undefined ? LEVELS[level] : LEVELS.info;
	if (lvl > configuredLevel) return;
	const ts = new Date().toISOString().replace('T', ' ').substr(0, 19);
	const line = `${ts} [${system}] ${format(msg, args)}`;
	if (level === 'error') console.error(line);
	else console.log(line);
};
