extends RefCounted
## The MessagePack subset PROTOCOL.md §4 needs, for control bodies and the
## `messagepack` codec.
##
## Values: null, bool, int, float, String, PackedByteArray (bin), Array and
## Dictionary (String keys; Godot keeps insertion order, which is the order
## entries are written in). Decoding gives int for integers (float for a
## uint64 above 2^63 - 1), float for floats, Array and Dictionary.

const ByteReader = preload("byte_reader.gd")
const ByteWriter = preload("byte_writer.gd")
const Numeric = preload("numeric.gd")
const Result = preload("result.gd")
const Utf8 = preload("utf8.gd")

## Nesting limit when decoding untrusted input.
const MAX_DEPTH := 512


static func encode(value: Variant):
	var writer := ByteWriter.new()
	var problem := write(writer, value, 0)
	if problem != "":
		return Result.failure(Result.ENCODE_FAILED, problem)
	return Result.success(writer.bytes)


## Writes one value per the §4 table; a message if it can't ("" if it can).
static func write(out: ByteWriter, value: Variant, depth: int) -> String:
	if depth > MAX_DEPTH:
		return "value nested too deeply"
	match typeof(value):
		TYPE_NIL:
			out.u8(0xc0)
		TYPE_BOOL:
			out.u8(0xc3 if value else 0xc2)
		TYPE_INT:
			write_integer(out, value)
		TYPE_FLOAT:
			write_number(out, value)
		TYPE_STRING, TYPE_STRING_NAME:
			write_string(out, str(value))
		TYPE_PACKED_BYTE_ARRAY:
			write_bin(out, value)
		TYPE_ARRAY:
			var list: Array = value
			write_array_header(out, list.size())
			for item in list:
				var problem := write(out, item, depth + 1)
				if problem != "":
					return problem
		TYPE_DICTIONARY:
			var map: Dictionary = value
			write_map_header(out, map.size())
			for key in map:
				if typeof(key) != TYPE_STRING and typeof(key) != TYPE_STRING_NAME:
					return "map keys must be strings"
				write_string(out, str(key))
				var problem := write(out, map[key], depth + 1)
				if problem != "":
					return problem
		_:
			return "unsupported value type %s" % type_string(typeof(value))
	return ""


## A number: an integer if it has no fractional part and its magnitude is
## at most 2^53 - 1 (so -0 is 00), else float64.
static func write_number(out: ByteWriter, value: float) -> void:
	if is_finite(value) and value == floorf(value) and absf(value) <= float(Numeric.MAX_SAFE_INTEGER):
		write_integer(out, int(value))
	else:
		write_float64(out, value)


static func write_integer(out: ByteWriter, value: int) -> void:
	if value > Numeric.MAX_SAFE_INTEGER or value < -Numeric.MAX_SAFE_INTEGER:
		write_float64(out, float(value))
		return
	if value >= 0:
		if value <= 0x7f:
			out.u8(value)
		elif value <= 0xff:
			out.u8(0xcc)
			out.big_endian(value, 1)
		elif value <= 0xffff:
			out.u8(0xcd)
			out.big_endian(value, 2)
		elif value <= 0xffffffff:
			out.u8(0xce)
			out.big_endian(value, 4)
		else:
			out.u8(0xcf)
			out.big_endian(value, 8)
		return
	if value >= -32:
		out.u8(value & 0xff)
	elif value >= -128:
		out.u8(0xd0)
		out.big_endian(value, 1)
	elif value >= -32768:
		out.u8(0xd1)
		out.big_endian(value, 2)
	elif value >= -2147483648:
		out.u8(0xd2)
		out.big_endian(value, 4)
	else:
		out.u8(0xd3)
		out.big_endian(value, 8)


static func write_float64(out: ByteWriter, value: float) -> void:
	out.u8(0xcb)
	var bits := 0x7ff8000000000000 if is_nan(value) else Numeric.float_bits(value)
	out.big_endian(bits, 8)


static func write_string(out: ByteWriter, value: String) -> void:
	var utf8 := Utf8.encode(value)
	var n := utf8.size()
	if n <= 31:
		out.u8(0xa0 | n)
	elif n <= 0xff:
		out.u8(0xd9)
		out.big_endian(n, 1)
	elif n <= 0xffff:
		out.u8(0xda)
		out.big_endian(n, 2)
	else:
		out.u8(0xdb)
		out.big_endian(n, 4)
	out.append(utf8)


static func write_bin(out: ByteWriter, value: PackedByteArray) -> void:
	var n := value.size()
	if n <= 0xff:
		out.u8(0xc4)
		out.big_endian(n, 1)
	elif n <= 0xffff:
		out.u8(0xc5)
		out.big_endian(n, 2)
	else:
		out.u8(0xc6)
		out.big_endian(n, 4)
	out.append(value)


static func write_array_header(out: ByteWriter, count: int) -> void:
	if count <= 15:
		out.u8(0x90 | count)
	elif count <= 0xffff:
		out.u8(0xdc)
		out.big_endian(count, 2)
	else:
		out.u8(0xdd)
		out.big_endian(count, 4)


static func write_map_header(out: ByteWriter, count: int) -> void:
	if count <= 15:
		out.u8(0x80 | count)
	elif count <= 0xffff:
		out.u8(0xde)
		out.big_endian(count, 2)
	else:
		out.u8(0xdf)
		out.big_endian(count, 4)


# ---------------------------------------------------------------------------


## Decodes exactly one value from bytes[from, to). Truncated input, trailing
## bytes, invalid UTF-8, a non-string map key, the key __proto__, a repeated
## key and ext types are all DECODE_FAILED.
static func decode(data: PackedByteArray, from: int = 0, to: int = -1):
	var input := ByteReader.new(data, from, to)
	var value: Variant = _read(input, 0)
	if not input.failed() and not input.done():
		input.fail("trailing bytes after the value")
	if input.failed():
		return Result.failure(Result.DECODE_FAILED, "MessagePack: " + input.error)
	return Result.success(value)


static func _read(input: ByteReader, depth: int) -> Variant:
	if depth > MAX_DEPTH:
		input.fail("value nested too deeply")
		return null
	var head := input.u8()
	if input.failed():
		return null
	if head <= 0x7f:
		return head
	if head >= 0xe0:
		return head - 256
	if head <= 0x8f:
		return _read_map(input, head & 0x0f, depth)
	if head <= 0x9f:
		return _read_array(input, head & 0x0f, depth)
	if head <= 0xbf:
		return input.utf8_string(head & 0x1f)
	match head:
		0xc0:
			return null
		0xc2:
			return false
		0xc3:
			return true
		0xc4:
			return input.take(_length(input, 1))
		0xc5:
			return input.take(_length(input, 2))
		0xc6:
			return input.take(_length(input, 4))
		0xca:
			var bits := input.big_endian(4)
			var buffer := PackedByteArray()
			buffer.resize(4)
			buffer.encode_u32(0, bits)
			return buffer.decode_float(0)
		0xcb:
			return Numeric.float_from_bits(input.big_endian(8))
		0xcc:
			return input.big_endian(1)
		0xcd:
			return input.big_endian(2)
		0xce:
			return input.big_endian(4)
		0xcf:
			var value := input.big_endian(8)
			# Above 2^63 - 1 the int wrapped negative: widen to a float.
			return value if value >= 0 else float(value) + 18446744073709551616.0
		0xd0:
			var v8 := input.big_endian(1)
			return v8 - 256 if v8 >= 128 else v8
		0xd1:
			var v16 := input.big_endian(2)
			return v16 - 65536 if v16 >= 32768 else v16
		0xd2:
			var v32 := input.big_endian(4)
			return v32 - 4294967296 if v32 >= 2147483648 else v32
		0xd3:
			return input.big_endian(8)
		0xd9:
			return input.utf8_string(_length(input, 1))
		0xda:
			return input.utf8_string(_length(input, 2))
		0xdb:
			return input.utf8_string(_length(input, 4))
		0xdc:
			return _read_array(input, _length(input, 2), depth)
		0xdd:
			return _read_array(input, _length(input, 4), depth)
		0xde:
			return _read_map(input, _length(input, 2), depth)
		0xdf:
			return _read_map(input, _length(input, 4), depth)
	input.fail("unsupported MessagePack type 0x%02x" % head)
	return null


## A length or count; each element takes at least one byte.
static func _length(input: ByteReader, size: int) -> int:
	var length := input.big_endian(size)
	if length > input.remaining():
		input.fail("length %d exceeds the bytes left" % length)
		return 0
	return length


static func _read_array(input: ByteReader, count: int, depth: int) -> Array:
	var list := []
	if count > input.remaining():
		input.fail("array count exceeds the bytes left")
		return list
	for i in count:
		if input.failed():
			break
		list.append(_read(input, depth + 1))
	return list


static func _read_map(input: ByteReader, count: int, depth: int) -> Dictionary:
	var map := {}
	if count > input.remaining():
		input.fail("map count exceeds the bytes left")
		return map
	for i in count:
		var key: Variant = _read(input, depth + 1)
		if input.failed():
			break
		if typeof(key) != TYPE_STRING:
			input.fail("map key is not a string")
			break
		if key == "__proto__":
			input.fail("forbidden map key __proto__")
			break
		var value: Variant = _read(input, depth + 1)
		if input.failed():
			break
		if map.has(key):
			input.fail("repeated map key")
			break
		map[key] = value
	return map
