extends RefCounted
## An output buffer for the PROTOCOL.md §1 primitives. Floats are written
## little-endian through PackedByteArray.encode_*, and NaN in its canonical
## form (a NaN's payload is not portable).

const Numeric = preload("numeric.gd")
const Utf8 = preload("utf8.gd")

var bytes := PackedByteArray()
var _scratch := PackedByteArray()


func _init() -> void:
	_scratch.resize(8)


func length() -> int:
	return bytes.size()


func u8(value: int) -> void:
	bytes.append(value & 0xff)


func append(data: PackedByteArray) -> void:
	bytes.append_array(data)


## Overwrites an already-written byte.
func patch(at: int, value: int) -> void:
	bytes[at] = value & 0xff


## Unsigned LEB128 of 0 … 2^32 - 1.
func varint(value: int) -> void:
	while value >= 0x80:
		bytes.append((value & 0x7f) | 0x80)
		value >>= 7
	bytes.append(value)


## Zigzag varint of an int32.
func zigzag(value: int) -> void:
	varint(Numeric.zigzag(value))


func float64(value: float) -> void:
	if is_nan(value):
		bytes.append_array(PackedByteArray([0, 0, 0, 0, 0, 0, 0xf8, 0x7f]))
		return
	_scratch.encode_double(0, value)
	bytes.append_array(_scratch.slice(0, 8))


## Writes value rounded to binary32 (ties to even).
func float32(value: float) -> void:
	if is_nan(value):
		bytes.append_array(PackedByteArray([0, 0, 0xc0, 0x7f]))
		return
	_scratch.encode_float(0, value)
	bytes.append_array(_scratch.slice(0, 4))


## Varint byte length, then the UTF-8 bytes.
func string(value: String) -> void:
	var utf8 := Utf8.encode(value)
	varint(utf8.size())
	bytes.append_array(utf8)


## Big-endian unsigned integer of size bytes (MessagePack).
func big_endian(value: int, size: int) -> void:
	for i in range(size - 1, -1, -1):
		bytes.append((value >> (8 * i)) & 0xff)
