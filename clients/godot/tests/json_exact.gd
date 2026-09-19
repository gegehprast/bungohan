extends RefCounted
## A JSON parser whose numbers are exact. Godot's JSON.parse_string() and
## String.to_float() are not correctly rounded (3.4028234663852886e38 comes
## out one ulp high, 2.2250738585072014e-308 as 0), and the conformance
## vectors depend on exact doubles. Integer literals become ints; every
## other number is decoded with round-half-to-even from its exact decimal
## value. Objects keep their key order.
##
## Only the test runners need this: the protocol itself never parses text.

const Numeric = preload("res://addons/bungohan/protocol/numeric.gd")

const LIMB_BITS := 24
const LIMB := 1 << 24
const LIMB_MASK := (1 << 24) - 1

var _text := ""
var _at := 0
var error := ""


## The parsed value, or null with `error` set.
static func parse(text: String) -> Variant:
	var parser = new()
	parser._text = text
	var value: Variant = parser._value()
	parser._skip()
	if parser.error == "" and parser._at < text.length():
		parser.error = "trailing characters at %d" % parser._at
	if parser.error != "":
		push_error("JSON: " + parser.error)
		return null
	return value


func _skip() -> void:
	while _at < _text.length():
		var c := _text.unicode_at(_at)
		if c == 32 or c == 9 or c == 10 or c == 13:
			_at += 1
		else:
			return


func _value() -> Variant:
	_skip()
	if _at >= _text.length():
		error = "unexpected end"
		return null
	var c := _text.unicode_at(_at)
	if c == 123:  # {
		_at += 1
		var map := {}
		_skip()
		if _text.unicode_at(_at) == 125:
			_at += 1
			return map
		while error == "":
			_skip()
			var key: Variant = _string()
			_skip()
			if _text.unicode_at(_at) != 58:
				error = "expected : at %d" % _at
				return null
			_at += 1
			map[key] = _value()
			_skip()
			var d := _text.unicode_at(_at)
			_at += 1
			if d == 125:
				return map
			if d != 44:
				error = "expected , or } at %d" % (_at - 1)
		return null
	if c == 91:  # [
		_at += 1
		var list := []
		_skip()
		if _text.unicode_at(_at) == 93:
			_at += 1
			return list
		while error == "":
			list.append(_value())
			_skip()
			var d := _text.unicode_at(_at)
			_at += 1
			if d == 93:
				return list
			if d != 44:
				error = "expected , or ] at %d" % (_at - 1)
		return null
	if c == 34:
		return _string()
	if _text.substr(_at, 4) == "true":
		_at += 4
		return true
	if _text.substr(_at, 5) == "false":
		_at += 5
		return false
	if _text.substr(_at, 4) == "null":
		_at += 4
		return null
	return _number()


func _string() -> String:
	if _text.unicode_at(_at) != 34:
		error = "expected a string at %d" % _at
		return ""
	_at += 1
	var out := ""
	var start := _at
	while _at < _text.length():
		var c := _text.unicode_at(_at)
		if c == 34:
			out += _text.substr(start, _at - start)
			_at += 1
			return out
		if c == 92:
			out += _text.substr(start, _at - start)
			_at += 1
			var e := _text.unicode_at(_at)
			_at += 1
			match e:
				34: out += "\""
				92: out += "\\"
				47: out += "/"
				98: out += String.chr(8)
				102: out += String.chr(12)
				110: out += "\n"
				114: out += "\r"
				116: out += "\t"
				117:
					var code := _text.substr(_at, 4).hex_to_int()
					_at += 4
					if code >= 0xd800 and code <= 0xdbff and _text.substr(_at, 2) == "\\u":
						var low := _text.substr(_at + 2, 4).hex_to_int()
						if low >= 0xdc00 and low <= 0xdfff:
							code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
							_at += 6
					# A Godot String holds neither U+0000 nor a lone surrogate:
					# both read as U+FFFD, which is what encoders send for them
					# (PROTOCOL.md §1.3).
					if code == 0 or (code >= 0xd800 and code <= 0xdfff):
						code = 0xfffd
					out += String.chr(code)
				_:
					error = "bad escape at %d" % _at
					return ""
			start = _at
			continue
		_at += 1
	error = "unterminated string"
	return ""


func _number() -> Variant:
	var start := _at
	var negative := false
	if _text.unicode_at(_at) == 45:
		negative = true
		_at += 1
	var digits := ""
	var exponent := 0
	var is_integer := true
	while _at < _text.length() and _is_digit(_text.unicode_at(_at)):
		digits += _text[_at]
		_at += 1
	if _at < _text.length() and _text.unicode_at(_at) == 46:
		is_integer = false
		_at += 1
		while _at < _text.length() and _is_digit(_text.unicode_at(_at)):
			digits += _text[_at]
			exponent -= 1
			_at += 1
	if _at < _text.length() and (_text.unicode_at(_at) == 101 or _text.unicode_at(_at) == 69):
		is_integer = false
		_at += 1
		var sign := 1
		if _text.unicode_at(_at) == 43:
			_at += 1
		elif _text.unicode_at(_at) == 45:
			sign = -1
			_at += 1
		var e := 0
		var any := false
		while _at < _text.length() and _is_digit(_text.unicode_at(_at)):
			e = mini(e * 10 + _text.unicode_at(_at) - 48, 100000)
			_at += 1
			any = true
		if not any:
			error = "bad exponent at %d" % start
			return null
		exponent += sign * e
	if digits == "":
		error = "bad number at %d" % start
		return null
	var trimmed := digits.lstrip("0")
	if is_integer and trimmed.length() <= 18:
		var n := 0 if trimmed == "" else trimmed.to_int()
		return -n if negative else n
	return decimal_to_float(trimmed, exponent, negative)


static func _is_digit(c: int) -> bool:
	return c >= 48 and c <= 57


## The double nearest to ±digits × 10^exponent (ties to even).
static func decimal_to_float(digits: String, exponent: int, negative: bool) -> float:
	# Drop trailing zeros into the exponent.
	var end := digits.length()
	while end > 0 and digits.unicode_at(end - 1) == 48:
		end -= 1
		exponent += 1
	digits = digits.substr(0, end)
	if digits == "":
		return -0.0 if negative else 0.0
	if digits.length() + exponent > 310:
		return -INF if negative else INF
	if digits.length() + exponent < -330:
		return -0.0 if negative else 0.0
	var result: float
	# Clinger's fast path: an exact mantissa and an exact power of ten,
	# combined by one correctly rounded operation.
	if digits.length() <= 15 and absi(exponent) <= 22:
		var mantissa := float(digits.to_int())
		var power := 1.0
		for i in absi(exponent):
			power *= 10.0
		result = mantissa * power if exponent >= 0 else mantissa / power
	else:
		result = Numeric.float_from_bits(_exact_bits(digits, exponent))
	return -result if negative else result


## IEEE 754 bits of the positive value digits × 10^exponent, correctly
## rounded, by exact big-integer division.
static func _exact_bits(digits: String, exponent: int) -> int:
	var n := _from_decimal(digits)
	var d := [1]
	if exponent >= 0:
		n = _mul_pow10(n, exponent)
	else:
		d = _mul_pow10(d, -exponent)
	# Choose s so that q = floor(n · 2^s / d) has 54 bits.
	var s := 53 - (_bit_length(n) - _bit_length(d))
	var qr := _divide(n, d, s)
	if qr[0] < (1 << 53):
		s += 1
		qr = _divide(n, d, s)
	var q: int = qr[0]
	var sticky: bool = qr[1]
	# value = q · 2^-s. Units of the result's last bit: 2^u, u ≥ -1074.
	var u := maxi(1 - s, -1074)
	var drop := u + s
	if drop > 60:
		return 0
	var m := q >> drop
	var half := (q >> (drop - 1)) & 1
	if drop > 1 and q & ((1 << (drop - 1)) - 1) != 0:
		sticky = true
	if half == 1 and (sticky or m & 1 == 1):
		m += 1
	if m < (1 << 52):
		return m  # subnormal (or zero)
	if m == (1 << 53):
		m >>= 1
		u += 1
	var biased := u + 1075
	if biased >= 2047:
		return 0x7ff0000000000000
	return (biased << 52) | (m - (1 << 52))


## [floor(n · 2^s / d), remainder != 0] for a quotient below 2^55.
static func _divide(n: Array, d: Array, s: int) -> Array:
	var a := _shl(n, s) if s >= 0 else n.duplicate()
	var b := d.duplicate() if s >= 0 else _shl(d, -s)
	var q := 0
	for bit in range(55, -1, -1):
		var t := _shl(b, bit)
		if _cmp(a, t) >= 0:
			a = _sub(a, t)
			q |= 1 << bit
	return [q, not _is_zero(a)]


# Big integers: little-endian Arrays of 24-bit limbs.

static func _from_decimal(digits: String) -> Array:
	var n := [0]
	var i := 0
	while i < digits.length():
		var chunk := digits.substr(i, 6)
		n = _mul_small(n, int(pow(10, chunk.length())))
		n = _add_small(n, chunk.to_int())
		i += 6
	return n


static func _mul_pow10(n: Array, e: int) -> Array:
	while e >= 6:
		n = _mul_small(n, 1000000)
		e -= 6
	if e > 0:
		n = _mul_small(n, int(pow(10, e)))
	return n


static func _mul_small(n: Array, m: int) -> Array:
	var out := []
	var carry := 0
	for limb in n:
		var v: int = limb * m + carry
		out.append(v & LIMB_MASK)
		carry = v >> LIMB_BITS
	while carry > 0:
		out.append(carry & LIMB_MASK)
		carry >>= LIMB_BITS
	return out


static func _add_small(n: Array, m: int) -> Array:
	var out := n.duplicate()
	var carry := m
	var i := 0
	while carry > 0:
		if i == out.size():
			out.append(0)
		var v: int = out[i] + carry
		out[i] = v & LIMB_MASK
		carry = v >> LIMB_BITS
		i += 1
	return out


static func _shl(n: Array, bits: int) -> Array:
	var limbs := bits / LIMB_BITS
	var rest := bits % LIMB_BITS
	var out := []
	out.resize(limbs)
	out.fill(0)
	var carry := 0
	for limb in n:
		var v: int = (limb << rest) | carry
		out.append(v & LIMB_MASK)
		carry = v >> LIMB_BITS
	if carry > 0:
		out.append(carry)
	return _trim(out)


static func _sub(a: Array, b: Array) -> Array:
	var out := []
	var borrow := 0
	for i in a.size():
		var v: int = a[i] - borrow - (b[i] if i < b.size() else 0)
		borrow = 0
		if v < 0:
			v += LIMB
			borrow = 1
		out.append(v)
	return _trim(out)


static func _cmp(a: Array, b: Array) -> int:
	var x := _trim(a)
	var y := _trim(b)
	if x.size() != y.size():
		return 1 if x.size() > y.size() else -1
	for i in range(x.size() - 1, -1, -1):
		if x[i] != y[i]:
			return 1 if x[i] > y[i] else -1
	return 0


static func _trim(n: Array) -> Array:
	var out := n
	while out.size() > 1 and out[out.size() - 1] == 0:
		out = out.slice(0, out.size() - 1)
	return out


static func _is_zero(n: Array) -> bool:
	for limb in n:
		if limb != 0:
			return false
	return true


static func _bit_length(n: Array) -> int:
	var x := _trim(n)
	var top: int = x[x.size() - 1]
	var bits := (x.size() - 1) * LIMB_BITS
	while top > 0:
		bits += 1
		top >>= 1
	return bits
