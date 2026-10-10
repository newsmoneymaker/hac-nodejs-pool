// x16rshash: share-validation helper for the Hacash (HAC) pool.
// Vendored verbatim from the x16rs-sys crate (crates.io, =0.1.2) that Hacash's own node links --
// see x16rs-src/x16rs.c/.h, never hand-modified. This CLI does ONLY the x16rs_hash(loopnum, in32) step;
// the outer sha3_256(stuff) step (see x16rs crate's block_hash()) is done in JS via Node's own
// crypto.createHash('sha3-256'), which is a standard, independently-verifiable primitive -- no reason
// to vendor a second SHA3 implementation here just for that outer step.
//
// Reads commands on stdin, writes answers on stdout (one line each):
//   H <id> <loopnum> <64 hex>   32-byte input (already sha3-256'd); answers "H <id> <64 hex>": the
//                               32-byte x16rs_hash output, or "H <id> err"
//   Q                           quit
// Command line: --hash <loopnum> <64 hex> prints the hash.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include "x16rs-src/x16rs.h"

static int hexval(int c)
{
	if (c >= '0' && c <= '9') return c - '0';
	if (c >= 'a' && c <= 'f') return c - 'a' + 10;
	if (c >= 'A' && c <= 'F') return c - 'A' + 10;
	return -1;
}

static int from_hex(const char *s, unsigned char *out, size_t n)
{
	if (strlen(s) != n * 2) return -1;
	for (size_t i = 0; i < n; i++) {
		int a = hexval(s[2 * i]), b = hexval(s[2 * i + 1]);
		if (a < 0 || b < 0) return -1;
		out[i] = (unsigned char)(a * 16 + b);
	}
	return 0;
}

static void to_hex(const unsigned char *in, size_t n, char *out)
{
	static const char d[] = "0123456789abcdef";
	for (size_t i = 0; i < n; i++) { out[2 * i] = d[in[i] >> 4]; out[2 * i + 1] = d[in[i] & 15]; }
	out[2 * n] = 0;
}

int main(int argc, char **argv)
{
	unsigned char in32[32], out32[32];
	char hex[65];

	if (argc == 4 && strcmp(argv[1], "--hash") == 0) {
		int loopnum = atoi(argv[2]);
		if (from_hex(argv[3], in32, 32)) { fprintf(stderr, "need 64 hex chars\n"); return 1; }
		c_x16rs_hash(loopnum, in32, out32);
		to_hex(out32, 32, hex);
		puts(hex);
		return 0;
	}

	char line[512];
	while (fgets(line, sizeof(line), stdin)) {
		if (line[0] == 'Q') break;
		if (line[0] != 'H') continue;
		char idbuf[32], loopbuf[16], hexbuf[128];
		if (sscanf(line + 1, "%31s %15s %127s", idbuf, loopbuf, hexbuf) != 3) {
			printf("H ? err\n"); fflush(stdout); continue;
		}
		if (from_hex(hexbuf, in32, 32)) {
			printf("H %s err\n", idbuf); fflush(stdout); continue;
		}
		c_x16rs_hash(atoi(loopbuf), in32, out32);
		to_hex(out32, 32, hex);
		printf("H %s %s\n", idbuf, hex);
		fflush(stdout);
	}
	return 0;
}
