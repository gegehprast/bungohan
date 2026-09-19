extends RefCounted
## One `schema` codec op stream (PROTOCOL.md §13.1.1–13.1.3): the class
## table and the target table (refId → what it denotes), with an undo
## journal so a failed frame leaves the session as it was.
##
## Ops are Arrays in their §11.1 tuple form (see class_table.gd), carrying
## wire values (§12.5): ints for integer kinds, fixed:n, indices and refIds;
## floats for float32/float64.

const ByteReader = preload("byte_reader.gd")
const ByteWriter = preload("byte_writer.gd")
const ClassTable = preload("class_table.gd")
const Numeric = preload("numeric.gd")
const Result = preload("result.gd")
const Scalars = preload("scalars.gd")
const StateType = preload("state_type.gd")

const HEADER_S := 0x10
const F_ESCAPE := 15

var table := ClassTable.new()
## refId → [layout] for an instance, or StateType for a collection.
var _targets := {}
## Per classId: {types: Array[StateType], collections: Array[StateType]}.
var _layouts: Array = []
var _undo: Array = []
var _class_mark := 0

## Encodes ops (value: PackedByteArray).
func encode_ops(ops: Array):
	var out := ByteWriter.new()
	_begin()
	var last := [0]
	for i in ops.size():
		var problem := _encode_op(out, ops[i], last)
		if problem != "":
			_rollback()
			return Result.failure(Result.ENCODE_FAILED, "op #%d: %s" % [i, problem])
	return Result.success(out.bytes)

## Decodes a body (value: Array of ops).
func decode_ops(data: PackedByteArray):
	var input := ByteReader.new(data)
	_begin()
	var ops := []
	var last := [0]
	while not input.done():
		var op: Variant = _decode_op(input, last)
		if op == null or input.failed():
			break
		ops.append(op)
	if input.failed():
		_rollback()
		return Result.failure(Result.DECODE_FAILED, "op #%d: %s" % [ops.size(), input.error])
	return Result.success(ops)

# --- tables -------------------------------------------------------------

func _begin() -> void:
	_undo.clear()
	_class_mark = _layouts.size()

func _rollback() -> void:
	for i in range(_undo.size() - 1, -1, -1):
		var entry: Array = _undo[i]
		if entry[1] == null:
			_targets.erase(entry[0])
		else:
			_targets[entry[0]] = entry[1]
	_undo.clear()
	_layouts.resize(_class_mark)
	table.truncate(_class_mark)

func _define(op: Array) -> String:
	var known := table.size()
	var problem := table.define(op)
	if problem != "":
		return problem
	if table.size() == known:
		return ""  # a restatement
	var types := []
	var collections := []
	for text in op[4]:
		var parsed = StateType.parse(text)
		types.append(parsed)
		if parsed.is_collection():
			collections.append(parsed)
	var layout := {"types": types, "collections": collections}
	_layouts.append(layout)
	# The root is refId 0, an instance of classId 0 (§11.3).
	if op[1] == 0:
		_bind(0, layout)
	return ""

func _bind_ref(class_id: int, ref_id: int) -> String:
	if class_id < 0 or class_id >= _layouts.size():
		return "ref to undefined classId %d" % class_id
	var layout: Dictionary = _layouts[class_id]
	if ref_id + layout["collections"].size() > Numeric.UINT32_MAX:
		return "refId block of %d overflows" % ref_id
	_bind(ref_id, layout)
	return ""

func _bind(ref_id: int, layout: Dictionary) -> void:
	_set_target(ref_id, [layout])
	var next := ref_id + 1
	for type in layout["collections"]:
		_set_target(next, type)
		next += 1

func _set_target(ref_id: int, target: Variant) -> void:
	_undo.append([ref_id, _targets.get(ref_id)])
	_targets[ref_id] = target

# --- encoder ------------------------------------------------------------

func _encode_op(out: ByteWriter, op: Variant, last: Array) -> String:
	if typeof(op) != TYPE_ARRAY or op.size() < 2 or not Numeric.is_integral(op[0]):
		return "not an op"
	var code := int(op[0])
	if code == 4:
		var problem := ClassTable.check_define(op)
		if problem == "":
			problem = _define(op)
		if problem != "":
			return problem
		out.u8(0x80)
		out.varint(int(op[1]))
		out.string(op[2])
		out.varint(op[3].size())
		for i in op[3].size():
			out.string(op[3][i])
			out.string(op[4][i])
		return ""
	if code < 0 or code > 3:
		return "unknown op code %d" % code
	if not Numeric.is_int_of(op[1], Numeric.IntKind.UINT32):
		return "target must be a uint32 refId"
	var ref_id := int(op[1])
	if not _targets.has(ref_id):
		return "unknown target refId %d" % ref_id
	var target: Variant = _targets[ref_id]
	var same := HEADER_S if ref_id == last[0] else 0
	var is_instance := typeof(target) == TYPE_ARRAY

	# Header F: a SET on an instance carries its field index.
	var field := -1
	if code == 0 and is_instance:
		if op.size() != 4 or not Numeric.is_int_of(op[2], Numeric.IntKind.UINT32):
			return "field index must be a uint32"
		field = int(op[2])
		if field >= target[0]["types"].size():
			return "field %d out of range" % field
	var f := 0 if field < 0 else mini(field, F_ESCAPE)
	out.u8((code << 5) | same | f)
	if same == 0:
		out.varint(ref_id)
	if f == F_ESCAPE:
		out.varint(field - F_ESCAPE)

	var carried := [null]
	var problem := _encode_payload(out, op, code, target, field, carried)
	if problem != "":
		return problem
	last[0] = ref_id if carried[0] == null else carried[0]
	return ""

func _encode_payload(out: ByteWriter, op: Array, code: int, target: Variant, field: int, carried: Array) -> String:
	if typeof(target) == TYPE_ARRAY:
		if code != 0:
			return "op %d on a schema instance" % code
		return _encode_value(out, target[0]["types"][field], op[3], carried)
	var type = target
	match code:
		0:
			if not type.is_array() or op.size() != 4:
				return "SET on a collection that isn't an array"
			var bad := _encode_index(out, op[2])
			return bad if bad != "" else _encode_element(out, type, op[3], carried)
		1:
			if type.is_set():
				if op.size() != 3:
					return "a set ADD takes 3 elements"
				return _encode_element(out, type, op[2], carried)
			if op.size() != 4:
				return "ADD takes 4 elements"
			var bad := Scalars.write(out, type.key, op[2]) if type.is_map() else _encode_index(out, op[2])
			return bad if bad != "" else _encode_element(out, type, op[3], carried)
		2:
			if op.size() != 3:
				return "REMOVE takes 3 elements"
			if type.is_map():
				return Scalars.write(out, type.key, op[2])
			if type.kind == StateType.Kind.SET:
				return Scalars.write(out, type.element, op[2])
			# An array index, or a schema set's element refId.
			return _encode_index(out, op[2])
		_:
			return "" if op.size() == 2 else "CLEAR takes 2 elements"

func _encode_value(out: ByteWriter, type: Variant, value: Variant, carried: Array) -> String:
	if type.kind == StateType.Kind.SCHEMA:
		return _encode_ref(out, value, carried)
	if type.kind == StateType.Kind.PRIMITIVE or type.kind == StateType.Kind.INT:
		return Scalars.write(out, type.element, value)
	return "a collection field has no value"

func _encode_element(out: ByteWriter, type: Variant, value: Variant, carried: Array) -> String:
	if type.holds_schemas():
		return _encode_ref(out, value, carried)
	return Scalars.write(out, type.element, value)

func _encode_ref(out: ByteWriter, value: Variant, carried: Array) -> String:
	if typeof(value) != TYPE_ARRAY or value.size() != 2 \
			or not Numeric.is_int_of(value[0], Numeric.IntKind.UINT32) \
			or not Numeric.is_int_of(value[1], Numeric.IntKind.UINT32):
		return "expected a ref [classId, refId]"
	var problem := _bind_ref(int(value[0]), int(value[1]))
	if problem != "":
		return problem
	out.varint(int(value[0]))
	out.varint(int(value[1]))
	carried[0] = int(value[1])
	return ""

func _encode_index(out: ByteWriter, index: Variant) -> String:
	if not Numeric.is_int_of(index, Numeric.IntKind.UINT32):
		return "index must be a uint32"
	out.varint(int(index))
	return ""

# --- decoder ------------------------------------------------------------

func _decode_op(input: ByteReader, last: Array) -> Variant:
	var header := input.u8()
	var code := header >> 5
	var same := header & HEADER_S != 0
	var f := header & 0x0f
	if code == 4:
		if same or f != 0:
			return _fail(input, "DEFINE with S or F set")
		return _decode_define(input)
	if code > 4:
		return _fail(input, "unknown op code %d" % code)

	var ref_id: int = last[0] if same else input.varint()
	if input.failed():
		return null
	if not _targets.has(ref_id):
		return _fail(input, "unknown target refId %d" % ref_id)
	var target: Variant = _targets[ref_id]

	if typeof(target) == TYPE_ARRAY:
		if code != 0:
			return _fail(input, "op %d on a schema instance" % code)
		var field := F_ESCAPE + input.varint() if f == F_ESCAPE else f
		if input.failed():
			return null
		var types: Array = target[0]["types"]
		if field >= types.size():
			return _fail(input, "field %d out of range" % field)
		var value: Variant = _decode_value(input, types[field])
		if input.failed():
			return null
		last[0] = value[1] if typeof(value) == TYPE_ARRAY else ref_id
		return [0, ref_id, field, value]

	if f != 0:
		return _fail(input, "F must be 0 on a collection op")
	var type = target
	match code:
		0:
			if not type.is_array():
				return _fail(input, "SET on a non-array collection")
			var index := input.varint()
			var value: Variant = _decode_element(input, type)
			if input.failed():
				return null
			last[0] = value[1] if typeof(value) == TYPE_ARRAY else ref_id
			return [0, ref_id, index, value]
		1:
			if type.is_set():
				var element: Variant = _decode_element(input, type)
				if input.failed():
					return null
				last[0] = element[1] if typeof(element) == TYPE_ARRAY else ref_id
				return [1, ref_id, element]
			var key: Variant = Scalars.read(input, type.key) if type.is_map() else input.varint()
			var value: Variant = _decode_element(input, type)
			if input.failed():
				return null
			last[0] = value[1] if typeof(value) == TYPE_ARRAY else ref_id
			return [1, ref_id, key, value]
		2:
			var removed: Variant
			if type.is_map():
				removed = Scalars.read(input, type.key)
			elif type.kind == StateType.Kind.SET:
				removed = Scalars.read(input, type.element)
			else:
				removed = input.varint()  # array index, or schema set refId
			if input.failed():
				return null
			last[0] = ref_id
			return [2, ref_id, removed]
	last[0] = ref_id
	return [3, ref_id]

func _fail(input: ByteReader, message: String) -> Variant:
	input.fail(message)
	return null

func _decode_ref(input: ByteReader) -> Variant:
	var class_id := input.varint()
	var ref_id := input.varint()
	if input.failed():
		return null
	var problem := _bind_ref(class_id, ref_id)
	if problem != "":
		input.fail(problem)
		return null
	return [class_id, ref_id]

func _decode_value(input: ByteReader, type: Variant) -> Variant:
	if type.kind == StateType.Kind.SCHEMA:
		return _decode_ref(input)
	if type.kind != StateType.Kind.PRIMITIVE and type.kind != StateType.Kind.INT:
		input.fail("a collection field has no value")
		return null
	return Scalars.read(input, type.element)

func _decode_element(input: ByteReader, type: Variant) -> Variant:
	if type.holds_schemas():
		return _decode_ref(input)
	return Scalars.read(input, type.element)

func _decode_define(input: ByteReader) -> Variant:
	var class_id := input.varint()
	var name := input.string()
	var count := input.count()
	var fields := []
	var types := []
	for i in count:
		if input.failed():
			break
		fields.append(input.string())
		types.append(input.string())
	if input.failed():
		return null
	var op := [4, class_id, name, fields, types]
	var problem := ClassTable.check_define(op)
	if problem == "":
		problem = _define(op)
	if problem != "":
		return _fail(input, problem)
	return op
