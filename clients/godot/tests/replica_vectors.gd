extends RefCounted
## `replica` vectors (PROTOCOL.md §14): builds the case's classes as
## schema scripts at run time, applies each frame to a replica, and compares
## the tree with the frame's `expect`, including which objects are the same
## one (`"$"` labels). Called by vector_tests.gd.

const ArraySchema = preload("res://addons/bungohan/replica/array_schema.gd")
const Checks = preload("checks.gd")
const MapSchema = preload("res://addons/bungohan/replica/map_schema.gd")
const Registry = preload("res://addons/bungohan/replica/schema_registry.gd")
const SchemaBase = preload("res://addons/bungohan/replica/schema.gd")
const SetSchema = preload("res://addons/bungohan/replica/set_schema.gd")
const StateDecoder = preload("res://addons/bungohan/replica/state_decoder.gd")
const StateType = preload("res://addons/bungohan/protocol/state_type.gd")
const WireValues = preload("res://addons/bungohan/replica/wire_values.gd")

## Class name → {script, fields: [[name, type], …]} of the running case. A
## generated script's _init() calls build(), which reads it.
static var _classes := {}

var _objects := {}  # label → object
var _labels := {}  # object → label


## Fills a new instance of a generated class: nested instances, empty
## collections, zero values (the decoder resets them anyway).
static func build(instance: Object, class_name_: String) -> void:
	var fields: Array = _classes[class_name_]["fields"]
	for i in fields.size():
		var type = StateType.parse(fields[i][1])
		var value: Variant
		if type.kind == StateType.Kind.SCHEMA:
			value = _classes[type.schema]["script"].new()
		elif type.is_map():
			value = MapSchema.new(type.text)
		elif type.is_set():
			value = SetSchema.new(type.text)
		elif type.is_array():
			value = ArraySchema.new(type.text)
		else:
			value = WireValues.zero(type.element)
		instance.set("f%d" % i, value)


## A schema script in the shape the generator emits; members are f0, f1, …
static func _script_for(decl: Dictionary) -> GDScript:
	var fields := []
	var members := ""
	for i in decl["fields"].size():
		var field: Array = decl["fields"][i]
		fields.append([field[0], field[1], "f%d" % i])
		members += "var f%d\n" % i
	var script := GDScript.new()
	script.source_code = "\n".join([
		'extends "res://addons/bungohan/replica/schema.gd"',
		'const Builder = preload("res://tests/replica_vectors.gd")',
		"const SCHEMA_NAME := %s" % var_to_str(decl["name"]),
		"const FIELDS := %s" % var_to_str(fields),
		members,
		"func _init() -> void:",
		"\tBuilder.build(self, SCHEMA_NAME)",
		"",
	])
	var error := script.reload()
	assert(error == OK, "generated class %s does not compile" % decl["name"])
	return script


## "" if the case passes, else the first problems found.
static func run(c: Dictionary) -> String:
	_classes = {}
	var registry := Registry.new()
	for decl in c["classes"]:
		_classes[decl["name"]] = {"fields": decl["fields"]}
	for decl in c["classes"]:
		var script := _script_for(decl)
		_classes[decl["name"]]["script"] = script
		registry.register(script)
	var root: Object = _classes[c["root"]]["script"].new()
	var decoder := StateDecoder.new(root, registry)
	var check := new()
	var frames: Array = c["frames"]
	for i in frames.size():
		var frame: Dictionary = frames[i]
		var result = decoder.apply(frame["ops"])
		if not result.ok:
			return "frame %d: %s" % [i, result.message]
		if not frame.has("expect"):
			continue
		var problems: Array = check._compare(registry, root, frame["expect"], "frame %d: $" % i)
		if not problems.is_empty():
			return "; ".join(problems)
	return ""


func _compare(registry, actual: Variant, expected: Variant, path: String) -> Array:
	if actual is SchemaBase:
		return _compare_instance(registry, actual, expected, path)
	if actual is MapSchema:
		return _compare_map(registry, actual, expected, path)
	if actual is SetSchema:
		return _compare_set(registry, actual, expected, path)
	if actual is ArraySchema:
		var elements: Array = actual.to_array()
		if typeof(expected) != TYPE_ARRAY or elements.size() != expected.size():
			return ["%s: %d elements, expected %s" % [path, elements.size(), Checks.show(expected)]]
		var problems := []
		for i in elements.size():
			problems.append_array(_compare(registry, elements[i], expected[i], "%s[%d]" % [path, i]))
		return problems
	var problem := Checks.difference(actual, expected, path)
	return [] if problem == "" else [problem]


func _compare_instance(registry, actual: Object, expected: Variant, path: String) -> Array:
	if typeof(expected) != TYPE_DICTIONARY:
		return ["%s: expected %s, got an instance" % [path, Checks.show(expected)]]
	var problems := []
	var label: Variant = expected.get("$")
	if typeof(label) == TYPE_STRING:
		if _objects.has(label) and not is_same(_objects[label], actual):
			problems.append("%s: \"%s\" is a different object than before" % [path, label])
		elif _labels.has(actual) and _labels[actual] != label:
			problems.append("%s: \"%s\" is the object labeled \"%s\"" % [path, label, _labels[actual]])
		else:
			_objects[label] = actual
			_labels[actual] = label
	var cls = registry.class_of(actual)
	for key in expected:
		if key != "$" and cls.index_of(key) < 0:
			problems.append("%s.%s: no such field" % [path, key])
	for field in cls.fields:
		if not expected.has(field["name"]):
			problems.append("%s.%s: missing from expect" % [path, field["name"]])
			continue
		var at: String = "%s.%s" % [path, field["name"]]
		problems.append_array(_compare(registry, actual.get(field["member"]), expected[field["name"]], at))
	return problems


func _compare_map(registry, actual: Object, expected: Variant, path: String) -> Array:
	if typeof(expected) != TYPE_ARRAY or actual.size() != expected.size():
		return ["%s: %d entries, expected %s" % [path, actual.size(), Checks.show(expected)]]
	var problems := []
	var keys: Array = actual.keys()
	for entry in expected:
		var found := false
		for key in keys:
			if Checks.difference(key, entry[0], "") == "":
				found = true
				var at: String = "%s[%s]" % [path, Checks.show(entry[0])]
				problems.append_array(_compare(registry, actual.at(key), entry[1], at))
				break
		if not found:
			problems.append("%s: no key %s" % [path, Checks.show(entry[0])])
	return problems


func _compare_set(registry, actual: Object, expected: Variant, path: String) -> Array:
	if typeof(expected) != TYPE_ARRAY or actual.size() != expected.size():
		return ["%s: %d elements, expected %s" % [path, actual.size(), Checks.show(expected)]]
	var problems := []
	var remaining: Array = actual.values()
	for i in expected.size():
		var match_at := -1
		for j in remaining.size():
			# Keep a try's label bindings only if it matched.
			var objects := _objects.duplicate()
			var labels := _labels.duplicate()
			if _compare(registry, remaining[j], expected[i], "%s{%d}" % [path, i]).is_empty():
				match_at = j
				break
			_objects = objects
			_labels = labels
		if match_at < 0:
			problems.append("%s: no element matches #%d" % [path, i])
		else:
			remaining.remove_at(match_at)
	return problems
