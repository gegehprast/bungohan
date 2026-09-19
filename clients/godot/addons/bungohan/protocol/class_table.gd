extends RefCounted
## A stream's class table, built from its DEFINEs: a new class must take the
## next id, a known one must be restated identically (PROTOCOL.md §11.2).
##
## Ops are Arrays in their §11.1 tuple form: [0, target, index, value],
## [1, target, key, value], [1, target, value] (sets), [2, target, key],
## [3, target], [4, classId, name, fields, types]. A ref is [classId, refId].

const Numeric = preload("numeric.gd")
const StateType = preload("state_type.gd")

## Entries: {class_id, name, fields: Array, types: Array}.
var entries: Array = []


func size() -> int:
	return entries.size()


## The entry for class_id, or null.
func get_entry(class_id: int) -> Variant:
	return entries[class_id] if class_id >= 0 and class_id < entries.size() else null


## Forgets every class from size on (rollback).
func truncate(new_size: int) -> void:
	if new_size < entries.size():
		entries.resize(new_size)


## Applies one DEFINE; a message if it is invalid ("" if it is fine).
func define(op: Array) -> String:
	var class_id: int = op[1]
	var entry := {"class_id": class_id, "name": op[2], "fields": op[3], "types": op[4]}
	var existing: Variant = get_entry(class_id)
	if existing != null:
		if _same(existing, entry):
			return ""
		return "DEFINE %d (%s) contradicts the known %s" % [class_id, op[2], existing["name"]]
	if class_id != entries.size():
		return "DEFINE %d (%s) skips ahead of class %d" % [class_id, op[2], entries.size()]
	entries.append(entry)
	return ""


## Checks a DEFINE's shape: [4, classId, name, fields, types], string lists
## of the same length, types in the grammar. "" if it is fine.
static func check_define(op: Variant) -> String:
	if typeof(op) != TYPE_ARRAY or op.size() != 5:
		return "DEFINE: bad arity"
	if not Numeric.is_int_of(op[1], Numeric.IntKind.UINT32):
		return "DEFINE: bad classId"
	if typeof(op[2]) != TYPE_STRING or typeof(op[3]) != TYPE_ARRAY or typeof(op[4]) != TYPE_ARRAY:
		return "DEFINE: bad shape"
	if op[3].size() != op[4].size():
		return "DEFINE: fields and types differ in length"
	for field in op[3]:
		if typeof(field) != TYPE_STRING:
			return "DEFINE: a field name is not a string"
	for type in op[4]:
		if typeof(type) != TYPE_STRING or StateType.parse(type) == null:
			return "DEFINE %s: type \"%s\" is outside the grammar" % [op[1], type]
	return ""


static func _same(a: Dictionary, b: Dictionary) -> bool:
	if a["name"] != b["name"] or a["fields"].size() != b["fields"].size():
		return false
	for i in a["fields"].size():
		if a["fields"][i] != b["fields"][i] or a["types"][i] != b["types"][i]:
			return false
	return true
