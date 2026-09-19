extends RefCounted
## Contract messages (PROTOCOL.md §10): field types and message
## declarations. Generated code builds these; so can a hand-written client:
##
##     var move = Contract.message("playerMove", [["x", Contract.fixed(2)], ["y", Contract.fixed(2)]])
##
## A payload is a Dictionary of field name → value. An absent optional is a
## missing key (or null); inside an array or map it is null.

## The first six match Numeric.IntKind.
enum Kind { INT8, INT16, INT32, UINT8, UINT16, UINT32, FLOAT32, FLOAT64, FIXED, STRING, BOOL, ENUM, ARRAY, MAP, OPTIONAL, NESTED }


class FieldType:
	extends RefCounted
	var kind: int
	## Decimal places of a fixed:n field.
	var decimals := 0
	## An enum's values (Strings or numbers), in index order.
	var enum_values: Array = []
	## The element type of an array, map or optional.
	var of: FieldType = null
	## The message of a nested field.
	var message: MessageDef = null

	func _init(field_kind: int) -> void:
		kind = field_kind

	func is_int() -> bool:
		return kind <= Kind.UINT32

	## The index of value among the enum's values, or -1. Numbers compare
	## by value (1 matches 1.0); a String never matches a number.
	func enum_index_of(value: Variant) -> int:
		var t := typeof(value)
		for i in enum_values.size():
			var candidate: Variant = enum_values[i]
			var c := typeof(candidate)
			if t == TYPE_STRING and c == TYPE_STRING:
				if candidate == value:
					return i
			elif (t == TYPE_INT or t == TYPE_FLOAT) and (c == TYPE_INT or c == TYPE_FLOAT):
				if float(candidate) == float(value):
					return i
		return -1


class MessageDef:
	extends RefCounted
	var name: String
	## [[field name, FieldType], …] in declaration (wire) order.
	var fields: Array
	# The schema codec's flag layout (§13.1.6), computed once.
	var bits: Array = []
	var value_bits: Array = []
	var flag_bytes := 0
	var last_mask := 0xff

	func _init(message_name: String, message_fields: Array) -> void:
		name = message_name
		fields = message_fields
		var used := 0
		for field in fields:
			var type: FieldType = field[1]
			var bit := -1
			var value_bit := -1
			if type.kind == Kind.BOOL:
				bit = used
				used += 1
			elif type.kind == Kind.OPTIONAL:
				bit = used
				used += 1
				if type.of.kind == Kind.BOOL:
					value_bit = used
					used += 1
			bits.append(bit)
			value_bits.append(value_bit)
		flag_bytes = (used + 7) / 8
		var rest := used % 8
		last_mask = 0xff if rest == 0 else (1 << rest) - 1


static func scalar(kind: int) -> FieldType:
	return FieldType.new(kind)


static func int8() -> FieldType:
	return FieldType.new(Kind.INT8)


static func int16() -> FieldType:
	return FieldType.new(Kind.INT16)


static func int32() -> FieldType:
	return FieldType.new(Kind.INT32)


static func uint8() -> FieldType:
	return FieldType.new(Kind.UINT8)


static func uint16() -> FieldType:
	return FieldType.new(Kind.UINT16)


static func uint32() -> FieldType:
	return FieldType.new(Kind.UINT32)


static func float32() -> FieldType:
	return FieldType.new(Kind.FLOAT32)


static func float64() -> FieldType:
	return FieldType.new(Kind.FLOAT64)


static func string() -> FieldType:
	return FieldType.new(Kind.STRING)


static func bool_() -> FieldType:
	return FieldType.new(Kind.BOOL)


static func fixed(decimals: int) -> FieldType:
	var type := FieldType.new(Kind.FIXED)
	type.decimals = decimals
	return type


## An enum of Strings and/or numbers, sent as the value's index.
static func enum_of(values: Array) -> FieldType:
	var type := FieldType.new(Kind.ENUM)
	type.enum_values = values.duplicate()
	return type


static func array_of(of: FieldType) -> FieldType:
	var type := FieldType.new(Kind.ARRAY)
	type.of = of
	return type


static func map_of(of: FieldType) -> FieldType:
	var type := FieldType.new(Kind.MAP)
	type.of = of
	return type


static func optional_of(of: FieldType) -> FieldType:
	var type := FieldType.new(Kind.OPTIONAL)
	type.of = of
	return type


static func nested(def: MessageDef) -> FieldType:
	var type := FieldType.new(Kind.NESTED)
	type.message = def
	return type


static func message(name: String, fields: Array) -> MessageDef:
	return MessageDef.new(name, fields)
