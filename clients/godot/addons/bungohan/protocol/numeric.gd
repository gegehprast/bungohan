extends RefCounted
## The numeric rules of PROTOCOL.md §12, bit for bit, and the varint/zigzag
## mappings of §1.1–1.2.
##
## GDScript ints are 64-bit, so 32-bit behavior is spelled out: zigzag uses
## arithmetic rather than shifts of negative numbers, and every conversion
## saturates before it truncates.

enum IntKind { INT8, INT16, INT32, UINT8, UINT16, UINT32 }

const INT32_MIN := -2147483648
const INT32_MAX := 2147483647
const UINT32_MAX := 4294967295
## 2^53 - 1: the largest integer MessagePack writes as an integer.
const MAX_SAFE_INTEGER := 9007199254740991

## 10^n as exact binary64 values, n = 0…9.
const SCALE := [1.0, 10.0, 100.0, 1000.0, 10000.0, 100000.0, 1000000.0, 10000000.0, 100000000.0, 1000000000.0]

const _MIN := [-128, -32768, -2147483648, 0, 0, 0]
const _MAX := [127, 32767, 2147483647, 255, 65535, 4294967295]
const _NAMES := ["int8", "int16", "int32", "uint8", "uint16", "uint32"]


static func int_min(kind: int) -> int:
	return _MIN[kind]


static func int_max(kind: int) -> int:
	return _MAX[kind]


## The IntKind of "int8" … "uint32", or -1.
static func int_kind_of(name: String) -> int:
	return _NAMES.find(name)


static func int_kind_name(kind: int) -> String:
	return _NAMES[kind]


## §12.1 encode: x × 10^n in binary64, rounded half away from zero,
## saturated to int32. NaN → 0; never -0.
static func fixed_encode(value: float, decimals: int) -> int:
	if is_nan(value):
		return 0
	var scaled: float = value * SCALE[decimals]
	# roundf() rounds half away from zero (2.5 → 3, -2.5 → -3).
	var rounded := roundf(scaled)
	if rounded <= -2147483648.0:
		return INT32_MIN
	if rounded >= 2147483647.0:
		return INT32_MAX
	return int(rounded)


## §12.1 decode: divides, never multiplies by 0.1^n.
static func fixed_decode(wire: int, decimals: int) -> float:
	return float(wire) / SCALE[decimals]


## §12.2: truncate toward zero, saturate to the kind's range. NaN → 0.
static func int_encode(value: float, kind: int) -> int:
	if is_nan(value):
		return 0
	if value <= float(_MIN[kind]):
		return _MIN[kind]
	if value >= float(_MAX[kind]):
		return _MAX[kind]
	return int(value)


## §12.3: rounds to binary32 (ties to even).
static func float32(value: float) -> float:
	var buffer := PackedByteArray()
	buffer.resize(4)
	buffer.encode_float(0, value)
	return buffer.decode_float(0)


static func is_number(value: Variant) -> bool:
	var t := typeof(value)
	return t == TYPE_INT or t == TYPE_FLOAT


## True if value is a number with no fractional part (ints always are).
static func is_integral(value: Variant) -> bool:
	if typeof(value) == TYPE_INT:
		return true
	if typeof(value) != TYPE_FLOAT:
		return false
	var number: float = value
	return is_finite(number) and number == floorf(number)


## True if value is an integer (int, or integral float) inside the kind's range.
static func is_int_of(value: Variant, kind: int) -> bool:
	if not is_integral(value):
		return false
	var number: float = float(value)
	return number >= float(_MIN[kind]) and number <= float(_MAX[kind])


## JavaScript's Object.is on numbers: NaN equals NaN, -0 differs from 0.
static func same_value(a: float, b: float) -> bool:
	if is_nan(a):
		return is_nan(b)
	return float_bits(a) == float_bits(b)


static func float_bits(value: float) -> int:
	var buffer := PackedByteArray()
	buffer.resize(8)
	buffer.encode_double(0, value)
	return buffer.decode_s64(0)


static func float_from_bits(bits: int) -> float:
	var buffer := PackedByteArray()
	buffer.resize(8)
	buffer.encode_s64(0, bits)
	return buffer.decode_double(0)


## Maps an int32 to a uint32: 0, -1, 1, -2 → 0, 1, 2, 3.
static func zigzag(value: int) -> int:
	return value * 2 if value >= 0 else -value * 2 - 1


## Inverse of zigzag() for a uint32.
static func unzigzag(value: int) -> int:
	return value >> 1 if value & 1 == 0 else -(value >> 1) - 1


## Bytes value takes as a varint.
static func varint_size(value: int) -> int:
	var size := 1
	while value >= 0x80:
		value >>= 7
		size += 1
	return size
