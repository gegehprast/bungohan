extends RefCounted
## A parsed state field type (PROTOCOL.md §11.2), e.g.
## "schemaMap<uint32,Enemy>".
##
##     field     = primitive | int | "schema<" Name ">"
##               | "map<" key "," primitive ">" | "set<" key ">" | "array<" primitive ">"
##               | "schemaMap<" key "," Name ">" | "schemaSet<" Name ">" | "schemaArray<" Name ">"

enum Kind { PRIMITIVE, INT, SCHEMA, MAP, SET, ARRAY, SCHEMA_MAP, SCHEMA_SET, SCHEMA_ARRAY }

## Scalar kinds; the last six match Numeric.IntKind + INT8.
enum Scalar { FLOAT64, FLOAT32, FIXED, STRING, BOOL, INT8, INT16, INT32, UINT8, UINT16, UINT32 }

const _SCALARS := {
	"float64": Scalar.FLOAT64, "float32": Scalar.FLOAT32, "string": Scalar.STRING, "bool": Scalar.BOOL,
	"int8": Scalar.INT8, "int16": Scalar.INT16, "int32": Scalar.INT32,
	"uint8": Scalar.UINT8, "uint16": Scalar.UINT16, "uint32": Scalar.UINT32,
}

## The type string as it appears in a DEFINE.
var text := ""
var kind := Kind.PRIMITIVE
## A map's key: [Scalar, decimals].
var key: Array = []
## A primitive or integer field's type, a primitive collection's element
## type, or a set's element (key) type: [Scalar, decimals].
var element: Array = []
## The class name of schema fields and schema collections.
var schema := ""


## Parses a type string; null if it isn't in the grammar.
static func parse(type_text: String):
	var parsed = new()
	parsed.text = type_text
	var s := parse_scalar(type_text)
	if not s.is_empty():
		parsed.kind = Kind.INT if s[0] >= Scalar.INT8 else Kind.PRIMITIVE
		parsed.element = s
		return parsed
	var open := type_text.find("<")
	if open <= 0 or not type_text.ends_with(">"):
		return null
	var head := type_text.substr(0, open)
	var inner := type_text.substr(open + 1, type_text.length() - open - 2)
	var comma := inner.find(",")
	var key_text := "" if comma < 0 else inner.substr(0, comma)
	var rest := "" if comma < 0 else inner.substr(comma + 1)
	match head:
		"schema", "schemaSet", "schemaArray":
			if inner == "":
				return null
			parsed.kind = {"schema": Kind.SCHEMA, "schemaSet": Kind.SCHEMA_SET, "schemaArray": Kind.SCHEMA_ARRAY}[head]
			parsed.schema = inner
			return parsed
		"set":
			var e := parse_scalar(inner)
			if e.is_empty() or not is_key(e):
				return null
			parsed.kind = Kind.SET
			parsed.element = e
			return parsed
		"array":
			var e := parse_scalar(inner)
			if e.is_empty() or not is_primitive(e):
				return null
			parsed.kind = Kind.ARRAY
			parsed.element = e
			return parsed
		"map":
			var k := parse_scalar(key_text)
			var v := parse_scalar(rest)
			if comma <= 0 or k.is_empty() or not is_key(k) or v.is_empty() or not is_primitive(v):
				return null
			parsed.kind = Kind.MAP
			parsed.key = k
			parsed.element = v
			return parsed
		"schemaMap":
			var k := parse_scalar(key_text)
			if comma <= 0 or k.is_empty() or not is_key(k) or rest == "":
				return null
			parsed.kind = Kind.SCHEMA_MAP
			parsed.key = k
			parsed.schema = rest
			return parsed
	return null


## [Scalar, decimals], or [] if text isn't a scalar type.
static func parse_scalar(scalar_text: String) -> Array:
	if _SCALARS.has(scalar_text):
		return [_SCALARS[scalar_text], 0]
	if scalar_text.length() == 7 and scalar_text.begins_with("fixed:"):
		var digit := scalar_text.unicode_at(6) - 48
		if digit >= 0 and digit <= 9:
			return [Scalar.FIXED, digit]
	return []


static func is_int_scalar(s: Array) -> bool:
	return s[0] >= Scalar.INT8


## float64, float32, fixed:n, string or bool.
static func is_primitive(s: Array) -> bool:
	return s[0] < Scalar.INT8


## string, float64 or an integer kind.
static func is_key(s: Array) -> bool:
	return s[0] == Scalar.STRING or s[0] == Scalar.FLOAT64 or s[0] >= Scalar.INT8


## The Numeric.IntKind of an integer scalar.
static func int_kind(s: Array) -> int:
	return s[0] - Scalar.INT8


## Collections own a refId (PROTOCOL.md §11.3).
func is_collection() -> bool:
	return kind != Kind.PRIMITIVE and kind != Kind.INT and kind != Kind.SCHEMA


func is_array() -> bool:
	return kind == Kind.ARRAY or kind == Kind.SCHEMA_ARRAY


func is_set() -> bool:
	return kind == Kind.SET or kind == Kind.SCHEMA_SET


func is_map() -> bool:
	return kind == Kind.MAP or kind == Kind.SCHEMA_MAP


## Elements are schema instances (refs).
func holds_schemas() -> bool:
	return kind == Kind.SCHEMA_MAP or kind == Kind.SCHEMA_SET or kind == Kind.SCHEMA_ARRAY
