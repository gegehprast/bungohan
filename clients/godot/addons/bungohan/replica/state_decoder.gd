extends RefCounted
## Applies state ops to a replica (PROTOCOL.md §11): the class table and
## matching by name, refIds and blocks, zero-value resets, holder counts
## with end-of-frame drops, unknown classes, and signals deferred until the
## frame is applied. One decoder per stream (per snapshot); state_stream.gd
## manages that for you.

const ArraySchema = preload("array_schema.gd")
const ClassTable = preload("../protocol/class_table.gd")
const Collection = preload("collection.gd")
const MapSchema = preload("map_schema.gd")
const Numeric = preload("../protocol/numeric.gd")
const Result = preload("../protocol/result.gd")
const SchemaBase = preload("schema.gd")
const SetSchema = preload("set_schema.gd")
const StateType = preload("../protocol/state_type.gd")
const WireValues = preload("wire_values.gd")

## An instance of a class this receiver has no class for was dropped with
## its subtree. Once per class name per stream, after the frame.
signal unknown_class(name: String)

const _ROOT_HOLDERS := 1 << 60

var root: Object
var _registry
var _refs := {}  # refId → schema instance or collection
var _ignored := {}  # refId → true
var _classes := {}  # classId → binding {name, fields, types, parsed, local_class, local_index}
var _ref_of := {}  # instance → refId
var _binding_of := {}  # instance → binding
var _holders := {}  # instance → count
var _unknown_reported := {}
var _root_bound := false
# Per frame.
var _queue: Array = []
var _created := {}
var _released: Array = []
var _ignored_marker := RefCounted.new()


func _init(root_instance: Object, registry) -> void:
	root = root_instance
	_registry = registry


## Applies one frame's ops. On error, the ops before the failing one stay
## applied, and the replica can no longer be trusted (a desync).
func apply(ops: Array):
	_queue = []
	_created = {}
	_released = []
	var result = Result.success()
	for op in ops:
		result = _apply_op(op)
		if not result.ok:
			break
	for instance in _released:
		if _holders.has(instance) and _holders[instance] <= 0:
			_drop(instance)
	var queue := _queue
	_queue = []
	for callable in queue:
		callable.call()
	return result


func _apply_op(op: Variant):
	if typeof(op) != TYPE_ARRAY or op.size() < 2 or not Numeric.is_integral(op[0]) or not Numeric.is_integral(op[1]):
		return _malformed("op must start with [code, id]", op)
	match int(op[0]):
		4:
			return _op_define(op)
		0:
			return _op_set(op)
		1:
			return _op_add(op)
		2:
			return _op_remove(op)
		3:
			return _op_clear(op)
	return _malformed("unknown op code", op)


# --- ops --------------------------------------------------------------------


func _op_define(op: Array):
	var problem := ClassTable.check_define(op)
	if problem != "":
		return _malformed(problem, op)
	var parsed := []
	for text in op[4]:
		parsed.append(StateType.parse(text))
	var binding := {
		"name": op[2], "fields": op[3], "types": op[4], "parsed": parsed,
		"local_class": _registry.by_name(op[2]), "local_index": null,
	}
	_classes[int(op[1])] = binding
	if not _root_bound and _registry.class_of(root) != null and _registry.class_of(root).name == op[2]:
		var bound = _bind(root, binding, 0)
		if not bound.ok:
			return bound
		_holders[root] = _ROOT_HOLDERS
		_created.erase(root)  # the root's listeners always fire
		_root_bound = true
	return Result.success()


func _op_set(op: Array):
	var ref_id := int(op[1])
	if op.size() != 4 or not _is_index(op[2]):
		return _malformed("bad SET", op)
	var index := int(op[2])
	if _ignored.has(ref_id):
		return _ignore_value(op[3])
	if not _refs.has(ref_id):
		return _unknown_ref(ref_id)
	var target: Object = _refs[ref_id]

	if target is SchemaBase:
		var binding: Dictionary = _binding_of[target]
		if index >= binding["parsed"].size():
			return _malformed("field %d out of range" % index, op)
		var type = binding["parsed"][index]
		var local: int = binding["local_index"][index]
		var cls = _registry.class_of(target)
		if type.kind == StateType.Kind.SCHEMA:
			var value: Variant = op[3]
			if not _is_ref(value):
				return _malformed("a schema field needs a ref", op)
			if local < 0:
				return _ignore_value(value)
			var child: Variant = target.get(cls.fields[local]["member"])
			if not (child is SchemaBase):
				return _ignore_value(value)
			if _ref_of.has(child) and _ref_of[child] == int(value[1]):
				return Result.success()
			if not _classes.has(int(value[0])):
				return _unknown_class_id(int(value[0]))
			var bound = _bind(child, _classes[int(value[0])], int(value[1]))
			if not bound.ok:
				return bound
			_retain(child)
			return Result.success()
		if type.is_collection():
			return _malformed("SET on a collection field", op)
		if local < 0:
			return Result.success()
		if not _apply_field(target, cls.fields[local], op[3], _queue_for(target)):
			return _malformed("bad value for %s field \"%s\"" % [type.text, binding["fields"][index]], op)
		return Result.success()

	if target is ArraySchema:
		var decoded := _decode_element(target, op[3], op)
		if not decoded[0].ok:
			return decoded[0]
		if is_same(decoded[1], _ignored_marker):
			return Result.success()
		var replaced: Array = target._r_replace(index, decoded[1], _queue_of(target))
		if not replaced[0]:
			return _malformed("replace out of range", op)
		_release(replaced[1])
		_retain(decoded[1])
		return Result.success()
	return _malformed("SET target is not a schema or an array", op)


func _op_add(op: Array):
	var ref_id := int(op[1])
	if op.size() != 3 and op.size() != 4:
		return _malformed("bad ADD", op)
	var value: Variant = op[op.size() - 1]
	if _ignored.has(ref_id):
		return _ignore_value(value)
	if not _refs.has(ref_id):
		return _unknown_ref(ref_id)
	var target: Object = _refs[ref_id]
	if not (target is Collection):
		return _malformed("ADD on a schema", op)
	var decoded := _decode_element(target, value, op)
	if not decoded[0].ok:
		return decoded[0]
	var element: Variant = decoded[1]
	var ignored := is_same(element, _ignored_marker)
	var queue: Variant = _queue_of(target)

	if target is SetSchema:
		if op.size() != 3:
			return _malformed("a set ADD has no key", op)
		if not ignored and target._r_add(element, queue):
			_retain(element)
		return Result.success()
	if op.size() != 4:
		return _malformed("ADD needs a key", op)
	if target is MapSchema:
		var key := WireValues.key(target.type.key, op[2])
		if not key[0]:
			return _malformed("bad map key", op)
		if ignored:
			return Result.success()
		var upserted: Array = target._r_upsert(key[1], element, queue)
		if not is_same(upserted[1], element):
			_release(upserted[1])
			_retain(element)
		return Result.success()
	if target is ArraySchema:
		if not _is_index(op[2]):
			return _malformed("bad array index", op)
		if ignored:
			# Skipping would shift every later index out of step.
			return Result.failure(Result.UNKNOWN_CLASS, "array element of a class unknown to this client")
		if not target._r_insert(int(op[2]), element, queue):
			return _malformed("insert out of range", op)
		_retain(element)
		return Result.success()
	return _malformed("unsupported ADD target", op)


func _op_remove(op: Array):
	var ref_id := int(op[1])
	if op.size() != 3:
		return _malformed("bad REMOVE", op)
	if _ignored.has(ref_id):
		return Result.success()
	if not _refs.has(ref_id):
		return _unknown_ref(ref_id)
	var target: Object = _refs[ref_id]
	if not (target is Collection):
		return _malformed("REMOVE on a schema", op)
	var queue: Variant = _queue_of(target)
	if target is MapSchema:
		var key := WireValues.key(target.type.key, op[2])
		if not key[0]:
			return _malformed("bad map key", op)
		var deleted: Array = target._r_delete(key[1], queue)
		if deleted[0]:
			_release(deleted[1])
	elif target is ArraySchema:
		if not _is_index(op[2]):
			return _malformed("bad array index", op)
		var removed: Array = target._r_remove(int(op[2]), queue)
		if not removed[0]:
			return _malformed("remove out of range", op)
		_release(removed[1])
	elif target.type.holds_schemas():
		if not Numeric.is_int_of(op[2], Numeric.IntKind.UINT32):
			return _malformed("a schema set REMOVE takes a refId", op)
		var element: Variant = _refs.get(int(op[2]))
		if element is SchemaBase and target._r_delete(element, queue):
			_release(element)
	else:
		var element := WireValues.key(target.type.element, op[2])
		if not element[0]:
			return _malformed("bad set element", op)
		target._r_delete(element[1], queue)
	return Result.success()


func _op_clear(op: Array):
	var ref_id := int(op[1])
	if op.size() != 2:
		return _malformed("bad CLEAR", op)
	if _ignored.has(ref_id):
		return Result.success()
	if not _refs.has(ref_id):
		return _unknown_ref(ref_id)
	var target: Object = _refs[ref_id]
	if not (target is Collection):
		return _malformed("CLEAR on a schema", op)
	for value in target._r_clear(_queue_of(target)):
		_release(value)
	return Result.success()


# --- helpers ----------------------------------------------------------------


## Stores a wire value in a primitive field; queues its signal on change.
func _apply_field(instance: Object, field: Dictionary, wire: Variant, queue: Variant) -> bool:
	var decoded := WireValues.decode(field["parsed"].element, wire)
	if not decoded[0]:
		return false
	var member: String = field["member"]
	var previous: Variant = instance.get(member)
	instance.set(member, decoded[1])
	if queue != null and field["signal"] != "" and not WireValues.same(previous, decoded[1]):
		queue.append(instance.emit_signal.bind(field["signal"], decoded[1], previous))
	return true


## [Result, element]: a primitive, or a ref → an instance (or the ignored marker).
func _decode_element(collection: Object, value: Variant, op: Array) -> Array:
	var type = collection.type
	if not type.holds_schemas():
		var decoded := WireValues.key(type.element, value) if type.is_set() else WireValues.decode(type.element, value)
		if not decoded[0]:
			return [_malformed("bad %s element" % type.text, op), null]
		return [Result.success(), decoded[1]]
	if not _is_ref(value):
		return [_malformed("expected [classId, refId]", op), null]
	var class_id := int(value[0])
	var ref_id := int(value[1])
	if _refs.has(ref_id):
		var existing: Object = _refs[ref_id]
		if existing is SchemaBase:
			return [Result.success(), existing]
		return [_malformed("ref is a collection", op), null]
	# An ignored refId only stays ignored if its class is unknown here:
	# blocks are reused (§11.4), so it may now name a visible instance.
	if not _classes.has(class_id):
		return [_unknown_class_id(class_id), null]
	var binding: Dictionary = _classes[class_id]
	if binding["local_class"] == null:
		_ignore(binding, ref_id)
		_report_unknown(binding["name"])
		return [Result.success(), _ignored_marker]
	var instance: Object = binding["local_class"].schema_script.new()
	var bound = _bind(instance, binding, ref_id)
	if not bound.ok:
		return [bound, null]
	return [Result.success(), instance]


## Registers instance as ref_id (its collections as ref_id+1 …, in server
## field order) and resets it to zero values, since the server omits zeros.
func _bind(instance: Object, binding: Dictionary, ref_id: int):
	var cls = _registry.class_of(instance)
	if cls == null:
		return Result.failure(Result.UNKNOWN_CLASS, "instance of an unregistered script")
	var mapped = _local_fields(binding, cls)
	if not mapped.ok:
		return mapped
	var local: Array = mapped.value

	# A nested instance rebound to a new refId (the server replaced the
	# nested object, §11.5): forget its old block, count holders afresh, and
	# release what its collections held. Its nested fields are rebound by the
	# SETs that follow.
	if _ref_of.has(instance) and _ref_of[instance] != ref_id and _binding_of.has(instance):
		var old: Dictionary = _binding_of[instance]
		_unregister(_ref_of[instance], old)
		_holders[instance] = 0
		var held := []
		for index in old["local_index"] if old["local_index"] != null else []:
			if index < 0:
				continue
			var collection: Variant = instance.get(cls.fields[index]["member"])
			if collection is Collection:
				held.append_array(collection._schemas())
		for element in held:
			_release(element)
	_ignored.erase(ref_id)  # a stale mark from an earlier use of this block
	_refs[ref_id] = instance
	_ref_of[instance] = ref_id
	_binding_of[instance] = binding
	if not _holders.has(instance):
		_holders[instance] = 0
	_created[instance] = true

	for field in cls.fields:
		var type = field["parsed"]
		if type.is_collection():
			var collection: Variant = instance.get(field["member"])
			if collection is Collection:
				collection._reset()
		elif type.kind != StateType.Kind.SCHEMA:
			instance.set(field["member"], WireValues.zero(type.element))

	var next := ref_id + 1
	for index in binding["parsed"].size():
		if not binding["parsed"][index].is_collection():
			continue
		var collection_ref := next
		next += 1
		var local_index: int = local[index]
		var child: Variant = instance.get(cls.fields[local_index]["member"]) if local_index >= 0 else null
		if child is Collection:
			child._owner_ref = weakref(instance)
			_refs[collection_ref] = child
			_ignored.erase(collection_ref)
		else:
			_refs.erase(collection_ref)
			_ignored[collection_ref] = true
	return Result.success()


## Maps server field indices to local ones, checking that shared fields agree.
func _local_fields(binding: Dictionary, cls):
	if binding["local_index"] != null:
		return Result.success(binding["local_index"])
	var local := []
	for i in binding["fields"].size():
		var index: int = cls.index_of(binding["fields"][i])
		if index >= 0 and cls.fields[index]["type"] != binding["types"][i]:
			return Result.failure(Result.SCHEMA_MISMATCH, "%s.%s: server sends %s, local field is %s" % [
				binding["name"], binding["fields"][i], binding["types"][i], cls.fields[index]["type"]])
		local.append(index)
	binding["local_index"] = local
	return Result.success(local)


func _report_unknown(name: String) -> void:
	if _unknown_reported.has(name):
		return
	_unknown_reported[name] = true
	# About data, not an op: queued, so the frame is applied first.
	_queue.append(unknown_class.emit.bind(name))


func _ignore(binding: Dictionary, ref_id: int) -> void:
	_ignored[ref_id] = true
	var next := ref_id + 1
	for type in binding["parsed"]:
		if type.is_collection():
			_ignored[next] = true
			next += 1


## A value placed into an ignored target: a new ref it creates is ignored too.
func _ignore_value(value: Variant):
	if not _is_ref(value):
		return Result.success()
	var ref_id := int(value[1])
	if _refs.has(ref_id) or _ignored.has(ref_id):
		return Result.success()
	if not _classes.has(int(value[0])):
		return _unknown_class_id(int(value[0]))
	_ignore(_classes[int(value[0])], ref_id)
	return Result.success()


func _retain(value: Variant) -> void:
	if not (value is SchemaBase):
		return
	var count: int = _holders.get(value, 0)
	if count < _ROOT_HOLDERS:
		_holders[value] = count + 1


func _release(value: Variant) -> void:
	if not (value is SchemaBase):
		return
	var count: int = _holders.get(value, 0)
	if count >= _ROOT_HOLDERS:
		return
	_holders[value] = count - 1
	if count - 1 <= 0:
		_released.append(value)


func _unregister(ref_id: int, binding: Dictionary) -> void:
	_refs.erase(ref_id)
	var next := ref_id + 1
	for type in binding["parsed"]:
		if type.is_collection():
			_refs.erase(next)
			_ignored.erase(next)
			next += 1


## Forgets an instance and releases everything it holds.
func _drop(instance: Object) -> void:
	if not _ref_of.has(instance) or not _binding_of.has(instance):
		return
	var binding: Dictionary = _binding_of[instance]
	_unregister(_ref_of[instance], binding)
	_ref_of.erase(instance)
	_binding_of.erase(instance)
	_holders.erase(instance)
	var cls = _registry.class_of(instance)
	var children := []
	for local in binding["local_index"] if binding["local_index"] != null else []:
		if local < 0:
			continue
		var child: Variant = instance.get(cls.fields[local]["member"])
		if child is SchemaBase:
			children.append(child)
		elif child is Collection:
			children.append_array(child._schemas())
	for child in children:
		if not _holders.has(child):
			continue
		_holders[child] -= 1
		if _holders[child] <= 0:
			_drop(child)


func _queue_for(instance: Object) -> Variant:
	return null if _created.has(instance) else _queue


func _queue_of(collection: Object) -> Variant:
	var owner: Object = collection._owner()
	return _queue if owner == null else _queue_for(owner)


func _is_index(value: Variant) -> bool:
	return Numeric.is_integral(value) and float(value) >= 0 and float(value) <= 2147483647.0


func _is_ref(value: Variant) -> bool:
	return typeof(value) == TYPE_ARRAY and value.size() == 2 \
		and Numeric.is_int_of(value[0], Numeric.IntKind.UINT32) \
		and Numeric.is_int_of(value[1], Numeric.IntKind.UINT32)


func _malformed(message: String, op: Variant):
	return Result.failure(Result.MALFORMED_OP, "%s: %s" % [message, op])


func _unknown_ref(ref_id: int):
	return Result.failure(Result.UNKNOWN_REF, "unknown refId %d" % ref_id)


func _unknown_class_id(class_id: int):
	return Result.failure(Result.UNKNOWN_CLASS, "classId %d not defined" % class_id)
