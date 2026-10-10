#ifndef X16R_H
#define X16R_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>

void c_x16rs_hash(const int loopnum, const uint8_t* input32, uint8_t* output32);

#ifdef __cplusplus
}
#endif

#endif
