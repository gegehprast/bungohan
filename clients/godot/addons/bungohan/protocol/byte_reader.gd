extends RefCounted
## Reads PROTOCOL.md §1 primitives. Errors are sticky: the first failed
## read records `error`, and every later read returns a zero value, so
## callers check once per op rather than per read.

const Numeric = preload("numeric.gd")
const Utf8 = preload("utf8.gd")

var error := ""
var position := 0
var _bytes: PackedByteArray
var _end := 0
var _scratch := PackedByteArray()


func _init(data: PackedByteArray, from: int = 0, to: int = -1) -> void:
	_bytes = data
	position = from
	_end = data.size() if to < 0 else to
	_scratch.resize(8)


func failed() -> bool:
	return error != ""


func done() -> bool:
	return position >= _end


func remaining() -> int:
	return _end - position


## Records a failure (the first one wins) and stops reading.
func fail(message: String) -> void:
	if error == "":
		error = "%s (at byte %d)" % [message, position]
	position = _end


func u8() -> int:
	if position >= _end:
		fail("unexpected end of data")
		return 0
	position += 1
	return _bytes[position - 1]


## Unsigned LEB128: at most 5 bytes, at most 2^32 - 1.
func varint() -> int:
	var value := 0
	for i in 5:
		if position >= _end:
			fail("truncated varint")
			return 0
		var b := _bytes[position]
		position += 1
		value |= (b & 0x7f) << (7 * i)
		if b & 0x80 == 0:
			if value > Numeric.UINT32_MAX:
				fail("varint above 2^32-1")
				return 0
			return value
	fail("varint longer than 5 bytes")
	return 0


## A count or length, which can't exceed the bytes left.
func count() -> int:
	var n := varint()
	if n > remaining():
		fail("count %d exceeds the %d bytes left" % [n, remaining()])
		return 0
	return n


func zigzag() -> int:
	return Numeric.unzigzag(varint())


func float64() -> float:
	if remaining() < 8:
		fail("truncated float64")
		return 0.0
	var value := _bytes.decode_double(position)
	position += 8
	return value


func float32() -> float:
	if remaining() < 4:
		fail("truncated float32")
		return 0.0
	var value := _bytes.decode_float(position)
	position += 4
	return value


func string() -> String:
	var length := count()
	if failed():
		return ""
	return utf8_string(length)


## Decodes length bytes of strict UTF-8.
func utf8_string(length: int) -> String:
	if remaining() < length:
		fail("truncated string")
		return ""
	var text: Variant = Utf8.decode(_bytes, position, position + length)
	if text == null:
		fail("invalid UTF-8")
		return ""
	position += length
	return text


## Big-endian unsigned integer of size bytes (MessagePack). Sizes up to 8;
## an 8-byte value above 2^63 - 1 wraps (callers check).
func big_endian(size: int) -> int:
	if remaining() < size:
		fail("truncated value")
		return 0
	var value := 0
	for i in size:
		value = (value << 8) | _bytes[position + i]
	position += size
	return value


## The next count bytes.
func take(n: int) -> PackedByteArray:
	if remaining() < n:
		fail("truncated value")
		return PackedByteArray()
	var out := _bytes.slice(position, position + n)
	position += n
	return out
