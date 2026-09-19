extends RefCounted
## A room's state as a receiver sees it: decodes STATE_SNAPSHOT and
## STATE_PATCH bodies with the room's codec and applies them to a replica.
##
## Every snapshot starts a new stream (§11.9): a new codec session, a new
## decoder and a new root object. Hold on to the stream, not to `state`,
## and connect to the root's signals in `replaced`, which is emitted before
## the snapshot is applied, so its content arrives through them.
##
##     var stream := StateStream.new(SchemaCodec.new(), registry, preload("game_state.gd"))
##     stream.replaced.connect(func(state): state.players.added.connect(_spawn))
##     stream.apply_snapshot(body)

const Result = preload("../protocol/result.gd")
const StateDecoder = preload("state_decoder.gd")

## A snapshot started a new replica. Emitted before its ops apply.
signal replaced(state: Object)
## An instance of a class this client doesn't have was ignored (§11.7).
signal unknown_class(name: String)
## Emitted after every applied frame, once its signals have fired.
signal applied(state: Object)

## The replica; null before the first snapshot.
var state: Object = null
var _codec
var _registry
var _root_script: Script
var _session = null
var _decoder = null


func _init(codec, registry, root_script: Script) -> void:
	_codec = codec
	_registry = registry
	_root_script = root_script
	registry.register(root_script)


func apply_snapshot(body: PackedByteArray):
	var root: Object = _root_script.new()
	_session = _codec.create_session()
	_decoder = StateDecoder.new(root, _registry)
	_decoder.unknown_class.connect(unknown_class.emit)
	state = root
	replaced.emit(root)
	return _apply(body)


## A patch before any snapshot is NO_SNAPSHOT (a desync, §11.9).
func apply_patch(body: PackedByteArray):
	if _decoder == null:
		return Result.failure(Result.NO_SNAPSHOT, "STATE_PATCH before the first STATE_SNAPSHOT")
	return _apply(body)


func _apply(body: PackedByteArray):
	var ops = _session.decode_ops(body)
	if not ops.ok:
		return ops
	var result = _decoder.apply(ops.value)
	if result.ok:
		applied.emit(state)
	return result
