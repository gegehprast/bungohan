extends RefCounted
## The outcome of an operation that can fail. Nothing in the protocol core
## crashes on bad input; it returns one of these instead.
##
## Codes: ENCODE_FAILED, DECODE_FAILED (codecs, frames, MessagePack), and the
## replica's MALFORMED_OP, UNKNOWN_REF, UNKNOWN_CLASS, SCHEMA_MISMATCH and
## NO_SNAPSHOT (PROTOCOL.md §11.10).

const ENCODE_FAILED := "ENCODE_FAILED"
const DECODE_FAILED := "DECODE_FAILED"
const MALFORMED_OP := "MALFORMED_OP"
const UNKNOWN_REF := "UNKNOWN_REF"
const UNKNOWN_CLASS := "UNKNOWN_CLASS"
const SCHEMA_MISMATCH := "SCHEMA_MISMATCH"
const NO_SNAPSHOT := "NO_SNAPSHOT"

var ok: bool = true
var value: Variant = null
var code: String = ""
var message: String = ""


static func success(result_value: Variant = null):
	var result = new()
	result.value = result_value
	return result


static func failure(error_code: String, error_message: String):
	var result = new()
	result.ok = false
	result.code = error_code
	result.message = error_message
	return result


func _to_string() -> String:
	return "Ok(%s)" % [value] if ok else "Fail(%s: %s)" % [code, message]
