extends RefCounted
## Typed join and create options (PROTOCOL.md §6.2.1): each a
## `schema`-encoded message (§13.1.6), whatever the room's codec, sent in
## the JOIN body as a MessagePack bin, or null when it encodes to zero
## bytes. Generated contract scripts build these (`join_options(…)`,
## `create_options(…)`) with typed parameters; pass the result as a join's
## `options`.

const Contract = preload("res://addons/bungohan/protocol/contract.gd")
const Result = preload("res://addons/bungohan/protocol/result.gd")
const SchemaCodec = preload("res://addons/bungohan/protocol/schema_codec.gd")

# JOIN modes (§6.2); the protocol core doesn't depend on the net layer.
const _JOIN_OR_CREATE := 0
const _CREATE := 1
const _JOIN := 2
const _JOIN_BY_ID := 3

static var _no_options = null
static var _schema = null

var _join_definition
var _join: Dictionary
var _create_definition
var _create: Dictionary


## Options from declarations and payloads. A null declaration is
## no_options(): the message a declaration the contract leaves out stands
## for.
func _init(join_definition = null, join: Dictionary = {},
		create_definition = null, create: Dictionary = {}) -> void:
	_join_definition = join_definition if join_definition != null else no_options()
	_join = join
	_create_definition = create_definition if create_definition != null else no_options()
	_create = create


## Options from generated message objects; null is no_options().
static func from_messages(join, create = null):
	return new(
		join.definition() if join != null else null,
		join.to_payload() if join != null else {},
		create.definition() if create != null else null,
		create.to_payload() if create != null else {})


## The message with no fields, which encodes to zero bytes.
static func no_options():
	if _no_options == null:
		_no_options = Contract.message("noOptions", [])
	return _no_options


## The five JOIN body elements (§6.2): the join options in modes 0–3, the
## create options only in modes 0 and 1. Modes 4 and 5 ignore options, so
## they get the body without them. A Result holding an Array.
func body(mode: int, target: String, contract_hash):
	var creates := mode == _JOIN_OR_CREATE or mode == _CREATE
	var reads := creates or mode == _JOIN or mode == _JOIN_BY_ID
	if not reads:
		return Result.success([mode, target, null, contract_hash])
	var join = encode(_join_definition, _join)
	if not join.ok:
		return join
	var create = null
	if creates:
		var encoded = encode(_create_definition, _create)
		if not encoded.ok:
			return encoded
		create = encoded.value
	return Result.success([mode, target, join.value, contract_hash, create])


## One options element: a Result holding the encoded bytes, or null for
## zero bytes.
static func encode(definition, payload: Dictionary):
	if _schema == null:
		_schema = SchemaCodec.new()
	var encoded = _schema.encode_message(definition, payload)
	if not encoded.ok:
		return encoded
	var bytes: PackedByteArray = encoded.value
	return Result.success(null if bytes.is_empty() else bytes)
