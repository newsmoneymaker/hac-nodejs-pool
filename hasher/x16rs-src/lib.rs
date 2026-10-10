#[link(name = "x16rs", kind = "static")]
unsafe extern "C" {
    // output must be *mut: C writes 32 bytes through this pointer.
    // Declaring *const here is UB (write via const) and lets LLVM assume
    // the output buffer never changes, returning all zeros under optimization.
    fn c_x16rs_hash(loopnum: i32, input: *const u8, output: *mut u8);
}

pub const H32S: usize = 32;

/// Compute the X16RS hash.
///
/// `indata` and the returned buffer are 32-byte digests. `loopnum` is the
/// number of X16R rounds (typically 1..=16 for block hashing).
pub fn x16rs_hash(loopnum: i32, indata: &[u8; H32S]) -> [u8; H32S] {
    let mut outdata = [0u8; H32S];
    unsafe {
        c_x16rs_hash(loopnum, indata.as_ptr(), outdata.as_mut_ptr());
    }
    outdata
}

#[cfg(test)]
mod tests {
    use super::*;

    fn to_hex(bytes: &[u8; H32S]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }

    #[test]
    fn hash_is_not_all_zeros() {
        let input = [0u8; H32S];
        let out = x16rs_hash(1, &input);
        assert_ne!(
            out,
            [0u8; H32S],
            "x16rs_hash must not return all zeros (FFI UB regression)"
        );
    }

    #[test]
    fn hash_zero_input_loop1() {
        let input = [0u8; H32S];
        let out = x16rs_hash(1, &input);
        assert_eq!(
            to_hex(&out),
            "6fe2a4b96f71518b7603e5c63702588ba816885aa1ce5908de31335e11473460"
        );
        assert_eq!(x16rs_hash(1, &input), out);
    }

    #[test]
    fn hash_sequential_input_loop1() {
        let mut input = [0u8; H32S];
        for (i, b) in input.iter_mut().enumerate() {
            *b = i as u8;
        }
        assert_eq!(
            to_hex(&x16rs_hash(1, &input)),
            "5f4b9c2bc542352be3bd684ce2228447ba14b3cf32a41b04d18b52290435cea5"
        );
    }

    #[test]
    fn hash_loop0_is_identity_copy() {
        // With loopnum == 0, C copies input to output without hashing.
        let mut input = [0u8; H32S];
        input[0] = 0xab;
        input[31] = 0xcd;
        assert_eq!(x16rs_hash(0, &input), input);
    }
}
