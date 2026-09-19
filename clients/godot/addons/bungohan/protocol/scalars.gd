extends RefCounted
## Scalar values under the schema codec (PROTOCOL.md §13.1.4). A scalar
## type is [StateType.Scalar, decimals].

const ByteReader = preload("byte_reader.gd")
const ByteWriter = preload("byte_writer.gd")
const Numeric = preload("numeric.gd")
const StateType = preload("state_type.gd")

const Scalar = StateType.Scalar


## Writes a primitive, integer or key value; a message if it doesn't fit
## ("" if it does).
static func write(out: ByteWriter, type: Array, value: Variant) -> String:
	match type[0]:
		Scalar.FLOAT64:
			if not Numeric.is_number(value):
				return "float64: not a number"
			out.float64(value)
		Scalar.FLOAT32:
			if not Numeric.is_number(value):
				return "float32: not a number"
			out.float32(value)
		Scalar.STRING:
			if typeof(value) != TYPE_STRING:
				return "string: not a string"
			out.string(value)
		Scalar.BOOL:
			if typeof(value) != TYPE_BOOL:
				return "bool: not a boolean"
			out.u8(1 if value else 0)
		Scalar.FIXED:
			if not Numeric.is_int_of(value, Numeric.IntKind.INT32):
				return "fixed:%d: not an int32" % type[1]
			out.zigzag(int(value))
		_:
			var kind := StateType.int_kind(type)
			if not Numeric.is_int_of(value, kind):
				return "%s: out of range" % Numeric.int_kind_name(kind)
			write_int(out, kind, int(value))
	return ""


static func write_int(out: ByteWriter, kind: int, value: int) -> void:
	match kind:
		Numeric.IntKind.INT8, Numeric.IntKind.UINT8:
			out.u8(value)
		Numeric.IntKind.INT16, Numeric.IntKind.INT32:
			out.zigzag(value)
		_:
			out.varint(value)


## Reads a primitive, integer or key value (range-checked). Integer kinds
## and fixed:n give ints (the wire integer), float32/float64 give floats.
static func read(input: ByteReader, type: Array) -> Variant:
	match type[0]:
		Scalar.FLOAT64:
			return input.float64()
		Scalar.FLOAT32:
			return input.float32()
		Scalar.STRING:
			return input.string()
		Scalar.BOOL:
			var b := input.u8()
			if b > 1:
				input.fail("bool byte %d" % b)
			return b == 1
		Scalar.FIXED:
			return input.zigzag()
	return read_int(input, StateType.int_kind(type))


static func read_int(input: ByteReader, kind: int) -> int:
	var value := 0
	match kind:
		Numeric.IntKind.INT8:
			value = input.u8()
			if value >= 128:
				value -= 256
		Numeric.IntKind.UINT8:
			value = input.u8()
		Numeric.IntKind.INT16, Numeric.IntKind.INT32:
			value = input.zigzag()
		_:
			value = input.varint()
	if value < Numeric.int_min(kind) or value > Numeric.int_max(kind):
		input.fail("%s out of range: %d" % [Numeric.int_kind_name(kind), value])
	return value
