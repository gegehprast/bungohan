extends RefCounted
## Strict UTF-8 (PROTOCOL.md §1.3).
##
## Godot's own decoding is lenient: get_string_from_utf8() replaces invalid
## bytes with U+FFFD, stops at a NUL, and drops a leading byte order mark.
## So bytes are validated here first (overlong forms, surrogates, truncated
## sequences and code points above U+10FFFF are rejected), and a string with
## a NUL or a leading BOM is decoded by hand.
##
## Engine limit: a Godot String cannot hold U+0000 (String.chr(0) is
## U+FFFD). Encoders never send one (PROTOCOL.md §1.3), but a valid string
## containing NUL still decodes, with U+FFFD in its place.


## The decoded String, or null if the bytes aren't valid UTF-8.
static func decode(bytes: PackedByteArray, from: int, to: int) -> Variant:
	if not is_valid(bytes, from, to):
		return null
	var slice := bytes.slice(from, to)
	var manual := slice.size() >= 3 and slice[0] == 0xef and slice[1] == 0xbb and slice[2] == 0xbf
	if not manual:
		manual = slice.find(0) >= 0
	if not manual:
		return slice.get_string_from_utf8()
	return _decode_manually(slice)


## UTF-8 bytes of a string. The protocol writes an unpaired surrogate and
## U+0000 as U+FFFD (ef bf bd, PROTOCOL.md §1.3). Godot does the first
## itself, and the second holds by construction: a Godot String can't hold
## U+0000 (String.chr(0) is already U+FFFD). The 010 vectors check both.
static func encode(text: String) -> PackedByteArray:
	return text.to_utf8_buffer()


## True if bytes[from, to) is well-formed UTF-8 (Unicode Table 3-7).
static func is_valid(bytes: PackedByteArray, from: int, to: int) -> bool:
	var i := from
	while i < to:
		var b := bytes[i]
		if b < 0x80:
			i += 1
			continue
		var need := 0
		var lo := 0x80
		var hi := 0xbf
		if b >= 0xc2 and b <= 0xdf:
			need = 1
		elif b == 0xe0:
			need = 2
			lo = 0xa0
		elif b >= 0xe1 and b <= 0xec:
			need = 2
		elif b == 0xed:
			need = 2
			hi = 0x9f
		elif b >= 0xee and b <= 0xef:
			need = 2
		elif b == 0xf0:
			need = 3
			lo = 0x90
		elif b >= 0xf1 and b <= 0xf3:
			need = 3
		elif b == 0xf4:
			need = 3
			hi = 0x8f
		else:
			return false
		if to - i <= need:
			return false
		var second := bytes[i + 1]
		if second < lo or second > hi:
			return false
		for k in range(2, need + 1):
			var next := bytes[i + k]
			if next < 0x80 or next > 0xbf:
				return false
		i += need + 1
	return true


static func _decode_manually(bytes: PackedByteArray) -> String:
	var out := ""
	var i := 0
	while i < bytes.size():
		var b := bytes[i]
		var code := 0
		var extra := 0
		if b < 0x80:
			code = b
		elif b < 0xe0:
			code = b & 0x1f
			extra = 1
		elif b < 0xf0:
			code = b & 0x0f
			extra = 2
		else:
			code = b & 0x07
			extra = 3
		for k in range(1, extra + 1):
			code = (code << 6) | (bytes[i + k] & 0x3f)
		out += String.chr(0xfffd if code == 0 else code)
		i += extra + 1
	return out
