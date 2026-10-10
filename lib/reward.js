/**
 * Hacash (HAC) Pool
 *
 * Block reward: NOT a halving curve. hacash-params/src/lib.rs defines a fixed 66-entry integer
 * schedule indexed by height/100_000 (out-of-range defaults to 1), and the reward IS that integer
 * directly in WHOLE HAC (mint/src/consensus/coinbase.rs: `Amount::mei(block_reward_number(height))`
 * -- `mei` is literally "1 unit = 1 whole HAC", no further scaling). Values rise 1,1,2,3,5,8 then
 * hold at a peak of 8 HAC/block for a long stretch, then fall back to a permanent floor of 1
 * HAC/block forever after height ~4.6M. Copied verbatim from the real constant, not re-derived.
 **/
const BLOCK_REWARD_STEP_BLOCKS = 100000;

const BLOCK_REWARD_SCHEDULE = [
	1, 1, 2, 3, 5, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 3, 3, 3, 3, 3, 3,
	3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
	1, 1,
];

/** Whole-HAC block reward at this height (integer, no decimals -- see module docstring). */
exports.blockRewardWholeHac = function (height) {
	const step = Math.floor(height / BLOCK_REWARD_STEP_BLOCKS);
	if (step >= 0 && step < BLOCK_REWARD_SCHEDULE.length) return BLOCK_REWARD_SCHEDULE[step];
	return 1;
};
