extends RefCounted
## The `schema` codec (PROTOCOL.md §13.1), the default: tag-free binary
## state ops and contract messages.
##
## State ops go through a session per stream (schema_session.gd).

const ByteReader = preload("byte_reader.gd")
const ByteWriter = preload("byte_writer.gd")
const Contract = preload("contract.gd")
const Numeric = preload("numeric.gd")
const Result = preload("result.gd")
const Scalars = preload("scalars.gd")
const SchemaSession = preload("schema_session.gd")

const Kind = Contract.Kind


func get_name() -> String:
	return "schema"


func create_session():
	return SchemaSession.new()


## Encodes a contract message (value: PackedByteArray); numbers are
## converted per §12.
func encode_message(def: Contract.MessageDef, payload: Dictionary):
	var out := ByteWriter.new()
	var problem := write_message(out, def, payload, def.name)
	if problem != "":
		return Result.failure(Result.ENCODE_FAILED, problem)
	return Result.success(out.bytes)


## Decodes a contract message (value: Dictionary), strictly (§10).
func decode_message(def: Contract.MessageDef, data: PackedByteArray):
	var input := ByteReader.new(data)
	var message := read_message(input, def)
	if not input.failed() and not input.done():
		input.fail("trailing bytes after the message")
	if input.failed():
		return Result.failure(Result.DECODE_FAILED, def.name + ": " + input.error)
	return Result.success(message)


# ===========================================================================
# Contract messages (§13.1.6)
# ===========================================================================


static func write_message(out: ByteWriter, def: Contract.MessageDef, payload: Variant, path: String) -> String:
	if typeof(payload) != TYPE_DICTIONARY:
		return path + ": not an object"
	var flags_at := out.length()
	var flags := PackedByteArray()
	flags.resize(def.flag_bytes)
	for i in def.flag_bytes:
		out.u8(0)
	for i in def.fields.size():
		var field_name: String = def.fields[i][0]
		var type: Contract.FieldType = def.fields[i][1]
		var value: Variant = payload.get(field_name)
		var at := path + "." + field_name
		if type.kind == Kind.BOOL:
			if typeof(value) != TYPE_BOOL:
				return at + ": not a bool"
			if value:
				_set_bit(flags, def.bits[i])
			continue
		if type.kind == Kind.OPTIONAL:
			if value == null:
				continue
			_set_bit(flags, def.bits[i])
			if def.value_bits[i] >= 0:
				if typeof(value) != TYPE_BOOL:
					return at + ": not a bool"
				if value:
					_set_bit(flags, def.value_bits[i])
				continue
			var optional_problem := write_field(out, type.of, value, at)
			if optional_problem != "":
				return optional_problem
			continue
		var problem := write_field(out, type, value, at)
		if problem != "":
			return problem
	for i in def.flag_bytes:
		out.patch(flags_at + i, flags[i])
	return ""


static func _set_bit(flags: PackedByteArray, bit: int) -> void:
	flags[bit >> 3] = flags[bit >> 3] | (1 << (bit & 7))


static func _bit(flags: PackedByteArray, bit: int) -> bool:
	return flags[bit >> 3] & (1 << (bit & 7)) != 0


## Writes one value (not a message-level bool or optional).
static func write_field(out: ByteWriter, type: Contract.FieldType, value: Variant, path: String) -> String:
	match type.kind:
		Kind.FLOAT64:
			if not Numeric.is_number(value):
				return path + ": not a number"
			out.float64(value)
		Kind.FLOAT32:
			if not Numeric.is_number(value):
				return path + ": not a number"
			out.float32(value)
		Kind.FIXED:
			if not Numeric.is_number(value):
				return path + ": not a number"
			out.zigzag(Numeric.fixed_encode(value, type.decimals))
		Kind.STRING:
			if typeof(value) != TYPE_STRING:
				return path + ": not a string"
			out.string(value)
		Kind.BOOL:
			if typeof(value) != TYPE_BOOL:
				return path + ": not a bool"
			out.u8(1 if value else 0)
		Kind.ENUM:
			var index := type.enum_index_of(value)
			if index < 0:
				return path + ": not one of the enum values"
			out.varint(index)
		Kind.ARRAY:
			if typeof(value) != TYPE_ARRAY:
				return path + ": not an array"
			out.varint(value.size())
			for i in value.size():
				var problem := write_field(out, type.of, value[i], "%s[%d]" % [path, i])
				if problem != "":
					return problem
		Kind.MAP:
			if typeof(value) != TYPE_DICTIONARY:
				return path + ": not an object"
			out.varint(value.size())
			for key in value:
				if typeof(key) != TYPE_STRING:
					return path + ": map keys must be strings"
				out.string(key)
				var problem := write_field(out, type.of, value[key], path + "." + key)
				if problem != "":
					return problem
		Kind.OPTIONAL:
			# An array element or map value: a presence byte.
			if value == null:
				out.u8(0)
				return ""
			out.u8(1)
			return write_field(out, type.of, value, path)
		Kind.NESTED:
			return write_message(out, type.message, value, path)
		_:
			if not Numeric.is_number(value):
				return path + ": not a number"
			Scalars.write_int(out, type.kind, Numeric.int_encode(value, type.kind))
	return ""


static func read_message(input: ByteReader, def: Contract.MessageDef) -> Dictionary:
	var flags := PackedByteArray()
	for i in def.flag_bytes:
		flags.append(input.u8())
	if def.flag_bytes > 0 and flags[def.flag_bytes - 1] & ~def.last_mask & 0xff != 0:
		input.fail("flag padding bit set")
	var out := {}
	for i in def.fields.size():
		if input.failed():
			break
		var field_name: String = def.fields[i][0]
		var type: Contract.FieldType = def.fields[i][1]
		if type.kind == Kind.BOOL:
			out[field_name] = _bit(flags, def.bits[i])
		elif type.kind == Kind.OPTIONAL:
			if not _bit(flags, def.bits[i]):
				if def.value_bits[i] >= 0 and _bit(flags, def.value_bits[i]):
					input.fail("value bit of an absent optional")
				continue
			if def.value_bits[i] >= 0:
				out[field_name] = _bit(flags, def.value_bits[i])
			else:
				out[field_name] = read_field(input, type.of)
		else:
			out[field_name] = read_field(input, type)
	return out


static func read_field(input: ByteReader, type: Contract.FieldType) -> Variant:
	match type.kind:
		Kind.FLOAT64:
			return input.float64()
		Kind.FLOAT32:
			return input.float32()
		Kind.FIXED:
			return Numeric.fixed_decode(input.zigzag(), type.decimals)
		Kind.STRING:
			return input.string()
		Kind.BOOL:
			var b := input.u8()
			if b > 1:
				input.fail("bool byte %d" % b)
			return b == 1
		Kind.ENUM:
			var index := input.varint()
			if input.failed():
				return null
			if index >= type.enum_values.size():
				input.fail("enum index %d out of range" % index)
				return null
			return type.enum_values[index]
		Kind.ARRAY:
			var count := input.count()
			var list := []
			for i in count:
				if input.failed():
					break
				list.append(read_field(input, type.of))
			return list
		Kind.MAP:
			var count := input.count()
			var map := {}
			for i in count:
				if input.failed():
					break
				var key := input.string()
				if input.failed():
					break
				if key == "__proto__":
					input.fail("forbidden map key __proto__")
				elif map.has(key):
					input.fail("duplicate map key")
				var value: Variant = read_field(input, type.of)
				if not input.failed():
					map[key] = value
			return map
		Kind.OPTIONAL:
			var present := input.u8()
			if present > 1:
				input.fail("presence byte %d" % present)
			return read_field(input, type.of) if present == 1 else null
		Kind.NESTED:
			return read_message(input, type.message)
	return Scalars.read_int(input, type.kind)
