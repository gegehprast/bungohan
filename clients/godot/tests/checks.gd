extends RefCounted
## Test support shared by the runners: a result tally, hex, the vector JSON
## conventions (PROTOCOL.md §14) and value comparison.
##
## GDScript has no exceptions, so a check returns "" on success or a reason.
## A case function cut short by a script error returns null, which counts
## as a failure too.

const Contract = preload("res://addons/bungohan/protocol/contract.gd")
const Json = preload("json_exact.gd")
const Numeric = preload("res://addons/bungohan/protocol/numeric.gd")

var name := ""
var passed := 0
var skipped := 0
var failures: Array = []


func _init(suite_name: String) -> void:
	name = suite_name


func record(label: String, outcome: Variant) -> void:
	if typeof(outcome) == TYPE_STRING and outcome == "":
		passed += 1
	elif typeof(outcome) == TYPE_STRING:
		failures.append(label + ": " + outcome)
	else:
		failures.append(label + ": aborted by a script error")


func skip() -> void:
	skipped += 1


## Prints the tally; 0 if everything passed, else 1.
func report() -> int:
	var line := "%s: %d passed, %d failed" % [name, passed, failures.size()]
	if skipped > 0:
		line += ", %d skipped (behavior: needs a connection)" % skipped
	print(line)
	for failure in failures:
		print("  FAIL " + failure)
	return 0 if failures.is_empty() else 1


## The repository root: the nearest directory above res:// holding
## conformance/v1.
static func repo_root() -> String:
	var dir := ProjectSettings.globalize_path("res://").simplify_path()
	while dir != "" and dir != "/":
		if DirAccess.dir_exists_absolute(dir.path_join("conformance/v1")):
			return dir
		dir = dir.get_base_dir()
	return ""


static func load_json(path: String) -> Variant:
	var text := FileAccess.get_file_as_string(path)
	return revive(Json.parse(text))


## Replaces {"f64": "<16 hex digits>"} with the float of those bits.
static func revive(value: Variant) -> Variant:
	match typeof(value):
		TYPE_ARRAY:
			var list := []
			for item in value:
				list.append(revive(item))
			return list
		TYPE_DICTIONARY:
			if value.size() == 1 and value.has("f64") and typeof(value["f64"]) == TYPE_STRING:
				var hex: String = value["f64"]
				var bits := (hex.substr(0, 8).hex_to_int() << 32) | hex.substr(8, 8).hex_to_int()
				return Numeric.float_from_bits(bits)
			var map := {}
			for key in value:
				map[key] = revive(value[key])
			return map
	return value


static func from_hex(hex: String) -> PackedByteArray:
	var clean := hex.replace(" ", "").replace("\n", "")
	var out := PackedByteArray()
	for i in range(0, clean.length(), 2):
		out.append(clean.substr(i, 2).hex_to_int())
	return out


static func same_hex(expected: PackedByteArray, actual: PackedByteArray, what: String) -> String:
	if expected == actual:
		return ""
	return "%s: %s ≠ %s" % [what, actual.hex_encode(), expected.hex_encode()]


## Deep equality where numbers compare like JavaScript's Object.is (NaN
## equals NaN, -0 differs from 0), whether int or float. "" if equal, else
## the path of the first difference.
static func difference(actual: Variant, expected: Variant, path: String) -> String:
	var ta := typeof(actual)
	var te := typeof(expected)
	var actual_number := ta == TYPE_INT or ta == TYPE_FLOAT
	var expected_number := te == TYPE_INT or te == TYPE_FLOAT
	if actual_number or expected_number:
		if actual_number and expected_number and Numeric.same_value(float(actual), float(expected)):
			return ""
		return "%s: %s ≠ %s" % [path, show(actual), show(expected)]
	if ta == TYPE_ARRAY or te == TYPE_ARRAY:
		if ta != TYPE_ARRAY or te != TYPE_ARRAY:
			return "%s: array vs non-array (%s vs %s)" % [path, show(actual), show(expected)]
		if actual.size() != expected.size():
			return "%s: length %d ≠ %d" % [path, actual.size(), expected.size()]
		for i in expected.size():
			var problem := difference(actual[i], expected[i], "%s[%d]" % [path, i])
			if problem != "":
				return problem
		return ""
	if ta == TYPE_DICTIONARY or te == TYPE_DICTIONARY:
		if ta != TYPE_DICTIONARY or te != TYPE_DICTIONARY:
			return path + ": object vs non-object"
		for key in actual:
			if not expected.has(key):
				return "%s.%s: unexpected" % [path, key]
		for key in expected:
			if not actual.has(key):
				return "%s.%s: missing" % [path, key]
			var problem := difference(actual[key], expected[key], "%s.%s" % [path, key])
			if problem != "":
				return problem
		return ""
	if ta != te:
		return "%s: %s ≠ %s" % [path, show(actual), show(expected)]
	if ta == TYPE_PACKED_BYTE_ARRAY:
		return "" if actual == expected else path + ": bytes differ"
	if ta == TYPE_NIL or actual == expected:
		return ""
	return "%s: %s ≠ %s" % [path, show(actual), show(expected)]


static func show(value: Variant) -> String:
	if typeof(value) == TYPE_STRING:
		return "\"%s\"" % value
	if typeof(value) == TYPE_FLOAT:
		return "%.17g" % value
	return str(value)


## A declaration { name, fields: [[name, type], …] } (§14).
static func message_of(declaration: Dictionary) -> Contract.MessageDef:
	var fields := []
	for field in declaration["fields"]:
		fields.append([field[0], field_of(field[1])])
	return Contract.message(declaration["name"], fields)


static func field_of(type: Variant) -> Contract.FieldType:
	if typeof(type) == TYPE_STRING:
		if type.begins_with("fixed:"):
			return Contract.fixed(type.unicode_at(6) - 48)
		var kinds := {
			"int8": Contract.Kind.INT8, "int16": Contract.Kind.INT16, "int32": Contract.Kind.INT32,
			"uint8": Contract.Kind.UINT8, "uint16": Contract.Kind.UINT16, "uint32": Contract.Kind.UINT32,
			"float32": Contract.Kind.FLOAT32, "float64": Contract.Kind.FLOAT64,
			"string": Contract.Kind.STRING, "bool": Contract.Kind.BOOL,
		}
		return Contract.scalar(kinds[type])
	if type.has("enum"):
		return Contract.enum_of(type["enum"])
	if type.has("array"):
		return Contract.array_of(field_of(type["array"]))
	if type.has("map"):
		return Contract.map_of(field_of(type["map"]))
	if type.has("optional"):
		return Contract.optional_of(field_of(type["optional"]))
	return Contract.nested(message_of(type["nested"]))
