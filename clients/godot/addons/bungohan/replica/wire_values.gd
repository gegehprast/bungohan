extends RefCounted
## Converts wire values (as ops carry them) to the values fields hold:
## float for float64, float32 and fixed:n (divided, §12.1), int for the
## integer kinds, String, bool.

const Numeric = preload("../protocol/numeric.gd")
const StateType = preload("../protocol/state_type.gd")

const Scalar = StateType.Scalar


## [ok, value] for a field value or collection element. fixed:n must be an
## int32 on the wire; integer kinds must be integers in range.
static func decode(type: Array, wire: Variant) -> Array:
	match type[0]:
		Scalar.STRING:
			return [typeof(wire) == TYPE_STRING, wire]
		Scalar.BOOL:
			return [typeof(wire) == TYPE_BOOL, wire]
		Scalar.FLOAT64, Scalar.FLOAT32:
			if not Numeric.is_number(wire):
				return [false, null]
			return [true, float(wire)]
		Scalar.FIXED:
			if not Numeric.is_int_of(wire, Numeric.IntKind.INT32):
				return [false, null]
			return [true, Numeric.fixed_decode(int(wire), type[1])]
	if not Numeric.is_int_of(wire, StateType.int_kind(type)):
		return [false, null]
	return [true, int(wire)]


## [ok, key] for a map key or set element: exact, never quantized (§12.2).
static func key(type: Array, wire: Variant) -> Array:
	return decode(type, wire)


## The zero value of a scalar (§11.5), as a field holds it.
static func zero(type: Array) -> Variant:
	match type[0]:
		Scalar.STRING:
			return ""
		Scalar.BOOL:
			return false
		Scalar.FLOAT64, Scalar.FLOAT32, Scalar.FIXED:
			return 0.0
	return 0


## Change detection: NaN equals NaN, -0 differs from 0, objects by identity.
static func same(a: Variant, b: Variant) -> bool:
	if typeof(a) != typeof(b):
		return false
	if typeof(a) == TYPE_FLOAT:
		return Numeric.same_value(a, b)
	return is_same(a, b) or a == b
