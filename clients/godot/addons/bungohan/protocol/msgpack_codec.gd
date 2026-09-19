extends RefCounted
## The `messagepack` codec (PROTOCOL.md §13.2): self-describing, kept for
## debugging. A state body is one array of op tuples; a message is a
## positional array of its field values.

const ClassTable = preload("class_table.gd")
const Contract = preload("contract.gd")
const MsgPack = preload("msgpack.gd")
const Numeric = preload("numeric.gd")
const Result = preload("result.gd")

const Kind = Contract.Kind


func get_name() -> String:
	return "messagepack"


func create_session() -> Session:
	return Session.new()


func encode_message(def: Contract.MessageDef, payload: Dictionary):
	var packed := []
	var problem := pack_message(def, payload, def.name, packed)
	if problem != "":
		return Result.failure(Result.ENCODE_FAILED, problem)
	return MsgPack.encode(packed)


func decode_message(def: Contract.MessageDef, data: PackedByteArray):
	var decoded = MsgPack.decode(data)
	if not decoded.ok:
		return decoded
	var message := {}
	var problem := unpack_message(def, decoded.value, def.name, message)
	if problem != "":
		return Result.failure(Result.DECODE_FAILED, problem)
	return Result.success(message)


## One op stream: the class table, kept from the DEFINEs it sees.
class Session:
	extends RefCounted

	const _ClassTable = preload("class_table.gd")
	const _MsgPack = preload("msgpack.gd")
	const _Numeric = preload("numeric.gd")
	const _Result = preload("result.gd")

	var table = _ClassTable.new()

	func encode_ops(ops: Array):
		var mark: int = table.size()
		for op in ops:
			if typeof(op) == TYPE_ARRAY and op.size() > 0 and _Numeric.is_integral(op[0]) and int(op[0]) == 4:
				var problem: String = _ClassTable.check_define(op)
				if problem == "":
					problem = table.define(op)
				if problem != "":
					table.truncate(mark)
					return _Result.failure(_Result.ENCODE_FAILED, problem)
		var encoded = _MsgPack.encode(ops)
		if not encoded.ok:
			table.truncate(mark)
		return encoded

	func decode_ops(data: PackedByteArray):
		var decoded = _MsgPack.decode(data)
		if not decoded.ok:
			return decoded
		if typeof(decoded.value) != TYPE_ARRAY:
			return _Result.failure(_Result.DECODE_FAILED, "frame is not an array")
		var mark: int = table.size()
		var ops := []
		for i in decoded.value.size():
			var op: Variant = _to_op(decoded.value[i])
			var problem := ""
			if op == null:
				problem = "malformed op #%d" % i
			elif op[0] == 4:
				problem = _ClassTable.check_define(op)
				if problem == "":
					problem = table.define(op)
			if problem != "":
				table.truncate(mark)
				return _Result.failure(_Result.DECODE_FAILED, problem)
			ops.append(op)
		return _Result.success(ops)

	## A decoded tuple → an op (§13.2.1): code, arity and value types. Codes,
	## targets and indices become ints.
	func _to_op(item: Variant) -> Variant:
		if typeof(item) != TYPE_ARRAY or item.size() < 2:
			return null
		if not _is_int(item[0]) or not _is_int(item[1]):
			return null
		var code := int(item[0])
		var target := int(item[1])
		match code:
			0:
				if item.size() == 4 and _is_int(item[2]) and _is_value(item[3]):
					return [0, target, int(item[2]), _value(item[3])]
			1:
				if item.size() == 3 and _is_value(item[2]):
					return [1, target, _value(item[2])]
				if item.size() == 4 and _is_key(item[2]) and _is_value(item[3]):
					return [1, target, item[2], _value(item[3])]
			2:
				if item.size() == 3 and _is_key(item[2]):
					return [2, target, item[2]]
			3:
				if item.size() == 2:
					return [3, target]
			4:
				if item.size() == 5 and typeof(item[2]) == TYPE_STRING and _is_strings(item[3]) and _is_strings(item[4]):
					return [4, target, item[2], item[3], item[4]]
		return null

	func _is_int(value: Variant) -> bool:
		return _Numeric.is_integral(value) and absf(float(value)) <= float(_Numeric.MAX_SAFE_INTEGER)

	func _is_key(value: Variant) -> bool:
		var t := typeof(value)
		return t == TYPE_STRING or t == TYPE_BOOL or t == TYPE_INT or t == TYPE_FLOAT

	func _is_value(value: Variant) -> bool:
		if typeof(value) == TYPE_ARRAY:
			return value.size() == 2 and _is_int(value[0]) and _is_int(value[1])
		return _is_key(value)

	func _value(value: Variant) -> Variant:
		return [int(value[0]), int(value[1])] if typeof(value) == TYPE_ARRAY else value

	func _is_strings(value: Variant) -> bool:
		if typeof(value) != TYPE_ARRAY:
			return false
		for item in value:
			if typeof(item) != TYPE_STRING:
				return false
		return true


# ---------------------------------------------------------------------------
# Positional messages (§13.2.2)
# ---------------------------------------------------------------------------


static func pack_message(def: Contract.MessageDef, payload: Variant, path: String, packed: Array) -> String:
	if typeof(payload) != TYPE_DICTIONARY:
		return path + ": not an object"
	for field in def.fields:
		var result := [null]
		var problem := _pack_field(field[1], payload.get(field[0]), path + "." + field[0], result)
		if problem != "":
			return problem
		packed.append(result[0])
	# Trailing absent optionals are left out.
	var length := packed.size()
	while length > 0 and packed[length - 1] == null and def.fields[length - 1][1].kind == Kind.OPTIONAL:
		length -= 1
	packed.resize(length)
	return ""


static func _pack_field(type: Contract.FieldType, value: Variant, path: String, out: Array) -> String:
	match type.kind:
		Kind.FLOAT64:
			if not Numeric.is_number(value):
				return path + ": not a number"
			out[0] = float(value)
		Kind.FLOAT32:
			if not Numeric.is_number(value):
				return path + ": not a number"
			out[0] = Numeric.float32(value)
		Kind.FIXED:
			if not Numeric.is_number(value):
				return path + ": not a number"
			out[0] = Numeric.fixed_encode(value, type.decimals)
		Kind.STRING:
			if typeof(value) != TYPE_STRING:
				return path + ": not a string"
			out[0] = value
		Kind.BOOL:
			if typeof(value) != TYPE_BOOL:
				return path + ": not a bool"
			out[0] = value
		Kind.ENUM:
			var index := type.enum_index_of(value)
			if index < 0:
				return path + ": not one of the enum values"
			out[0] = index
		Kind.ARRAY:
			if typeof(value) != TYPE_ARRAY:
				return path + ": not an array"
			var items := []
			for i in value.size():
				var item := [null]
				var problem := _pack_field(type.of, value[i], "%s[%d]" % [path, i], item)
				if problem != "":
					return problem
				items.append(item[0])
			out[0] = items
		Kind.MAP:
			if typeof(value) != TYPE_DICTIONARY:
				return path + ": not an object"
			var map := {}
			for key in value:
				if typeof(key) != TYPE_STRING:
					return path + ": map keys must be strings"
				var item := [null]
				var problem := _pack_field(type.of, value[key], path + "." + key, item)
				if problem != "":
					return problem
				map[key] = item[0]
			out[0] = map
		Kind.OPTIONAL:
			if value == null:
				out[0] = null
				return ""
			return _pack_field(type.of, value, path, out)
		Kind.NESTED:
			var nested := []
			var problem := pack_message(type.message, value, path, nested)
			out[0] = nested
			return problem
		_:
			if not Numeric.is_number(value):
				return path + ": not a number"
			out[0] = Numeric.int_encode(value, type.kind)
	return ""


static func unpack_message(def: Contract.MessageDef, wire: Variant, path: String, message: Dictionary) -> String:
	if typeof(wire) != TYPE_ARRAY:
		return path + ": expected a positional array"
	if wire.size() > def.fields.size():
		return path + ": too many fields"
	for i in def.fields.size():
		var field: Array = def.fields[i]
		# Past the end of the array, only a trimmed optional may be missing.
		var item: Variant = wire[i] if i < wire.size() else null
		var out := [null, false]  # value, absent
		var problem := _unpack_field(field[1], item, path + "." + field[0], out)
		if problem != "":
			return problem
		if not out[1]:
			message[field[0]] = out[0]
	return ""


static func _unpack_field(type: Contract.FieldType, wire: Variant, path: String, out: Array) -> String:
	match type.kind:
		Kind.FLOAT64:
			if not Numeric.is_number(wire):
				return path + ": expected a number"
			out[0] = float(wire)
		Kind.FLOAT32:
			if not Numeric.is_number(wire):
				return path + ": expected a number"
			out[0] = Numeric.float32(wire)
		Kind.FIXED:
			if not Numeric.is_int_of(wire, Numeric.IntKind.INT32):
				return path + ": expected an int32"
			out[0] = Numeric.fixed_decode(int(wire), type.decimals)
		Kind.STRING:
			if typeof(wire) != TYPE_STRING:
				return path + ": expected a string"
			out[0] = wire
		Kind.BOOL:
			if typeof(wire) != TYPE_BOOL:
				return path + ": expected a bool"
			out[0] = wire
		Kind.ENUM:
			if not Numeric.is_integral(wire) or float(wire) < 0 or float(wire) >= type.enum_values.size():
				return path + ": bad enum index"
			out[0] = type.enum_values[int(wire)]
		Kind.ARRAY:
			if typeof(wire) != TYPE_ARRAY:
				return path + ": expected an array"
			var items := []
			for i in wire.size():
				var item := [null, false]
				var problem := _unpack_field(type.of, wire[i], "%s[%d]" % [path, i], item)
				if problem != "":
					return problem
				items.append(item[0])
			out[0] = items
		Kind.MAP:
			if typeof(wire) != TYPE_DICTIONARY:
				return path + ": expected a map"
			var map := {}
			for key in wire:
				var item := [null, false]
				var problem := _unpack_field(type.of, wire[key], path + "." + key, item)
				if problem != "":
					return problem
				map[key] = item[0]
			out[0] = map
		Kind.OPTIONAL:
			if wire == null:
				out[0] = null
				out[1] = true
				return ""
			return _unpack_field(type.of, wire, path, out)
		Kind.NESTED:
			var nested := {}
			var problem := unpack_message(type.message, wire, path, nested)
			out[0] = nested
			return problem
		_:
			if not Numeric.is_int_of(wire, type.kind):
				return path + ": expected " + Numeric.int_kind_name(type.kind)
			out[0] = int(wire)
	return ""
