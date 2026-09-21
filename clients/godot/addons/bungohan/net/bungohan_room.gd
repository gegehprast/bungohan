extends RefCounted
## One joined room, client side (PROTOCOL.md §6, §7, §11). Frames reach it
## already parsed and routed by roomRef, and every signal it emits is
## emitted from BungohanClient.poll(), on the main thread.
##
##     room.message.connect(func(name, payload):
##         if name == "welcome":
##             var m = Bindings.WelcomeMessage.from_payload(payload))
##     room.state_replaced.connect(func(state): state.players.added.connect(_spawn))
##
## What the room sends before the join has handed it over (a message sent in
## the server's onJoin, …) is kept, and reaches the first listener attached
## for it, however late: an `on_message` handler or a `connect` to
## `message`, `raw_message`, `client_joined`, `client_left` or
## `error_received`, from the next poll() on (spec §7.5).

const Constants = preload("constants.gd")
const Frames = preload("../protocol/frames.gd")
const MsgPack = preload("../protocol/msgpack.gd")
const Result = preload("../protocol/result.gd")
const StateDecoder = preload("../replica/state_decoder.gd")

## At most this many unclaimed pre-join events are kept (oldest dropped).
const MAX_UNCLAIMED := 64

## A contract message arrived: its name and decoded payload (a Dictionary).
signal message(name: String, payload: Dictionary)
## An untyped message (ROOM_MESSAGE_RAW).
signal raw_message(type: String, payload: Variant)
## A fresh replica; emitted BEFORE its snapshot is applied (§11.9).
signal state_replaced(state: Object)
## After every applied state frame.
signal state_changed(state: Object)
## The room was left; `code` is a LEAVE code (§7.1).
signal left(code: int)
## An ERROR frame for this room, or a local failure (a desync, …).
signal error_received(code: String, message: String)
signal client_joined(session_id: String)
signal client_left(session_id: String)

var id := ""
var room_type := ""
var session_id := ""
## Replaced on every join and resume; keep the newest (§6.4).
var reconnection_token = null
## The room type's contract hash, from the handshake.
var contract_hash := ""
## The codec named in the handshake: "schema" or "messagepack".
var state_codec_name := ""
var status: int = Constants.RoomStatus.JOINING
## This seat's handle on the current connection (§3.1).
var room_ref := 0
## The replica: a NEW object after every snapshot. Keep the room, not this.
var state: Object = null

# The client. A WeakRef: the client holds its rooms, and a strong
# reference back would be a cycle that RefCounted never frees.
var _host_ref: WeakRef
var _settings: Dictionary
var _codec = null
var _session = null
var _decoder = null
var _client_ids := {}
var _server_names: Array = []
var _handlers := {}
var _unclaimed: Array = []
var _held = null
var _releasing := false
var _snapshots := 0


## `settings` holds the runtime inputs to the join, all optional:
## `contract_hash` (String, sent in JOIN; absent skips the check, §6.3),
## `server_messages` (Dictionary name → message script, §6.5),
## `registry` (a schema_registry.gd) and `state` (the root's Script).
func _init(host, settings: Dictionary) -> void:
	_host_ref = weakref(host)
	_settings = settings


## The contract hash to send in this room's JOIN frames, or null.
func hash_or_null():
	return _settings.get("contract_hash", null)


## Snapshots applied; 1 once the join completed.
func snapshots() -> int:
	return _snapshots


# --- sending ---------------------------------------------------------------


## Sends a generated contract message (its script knows its declaration).
## Its id comes from the handshake's table, resolved by name (§6.5).
func send(msg: Object):
	return send_payload(msg.definition(), msg.to_payload())


## Sends a contract message from its declaration and payload.
func send_payload(definition, payload: Dictionary):
	var usable = _usable()
	if not usable.ok:
		return usable
	var name: String = definition.name
	if not _client_ids.has(name):
		return Result.failure(Constants.UNKNOWN_MESSAGE,
			"\"%s\" is not a client message of this room" % name)
	if _codec == null:
		return Result.failure(Constants.NOT_JOINED, "the room has no codec yet")
	var body = _codec.encode_message(definition, payload)
	if not body.ok:
		return body
	return _send(Frames.CLIENT_ROOM_MESSAGE, [room_ref, _client_ids[name]], body.value)


## Sends an untyped MessagePack message (the server's raw handlers).
func send_raw(type: String, payload: Variant):
	var usable = _usable()
	if not usable.ok:
		return usable
	var body = MsgPack.encode([type, payload])
	if not body.ok:
		return body
	return _send(Frames.CLIENT_ROOM_MESSAGE_RAW, [room_ref], body.value)


## Leaves the room (a consented LEAVE, §7.1) and drops every listener. The
## server's acknowledgement is not waited for; the seat counts as left now.
func leave():
	if status == Constants.RoomStatus.LEFT:
		return Result.failure(Constants.NOT_JOINED, "already left")
	# While reconnecting there is no connection to send it on, and the seat
	# is simply not resumed.
	if status != Constants.RoomStatus.RECONNECTING and room_ref != 0:
		_send(Frames.CLIENT_LEAVE, [room_ref], PackedByteArray())
	mark_left(Constants.LEAVE_CONSENTED)
	return Result.success()


# --- listeners -------------------------------------------------------------


## Handles one contract message by name; `handler` takes the payload
## Dictionary. Convert it with the generated `from_payload`.
func on_message(name: String, handler: Callable) -> void:
	if not _handlers.has(name):
		_handlers[name] = []
	_handlers[name].append(handler)


## Drops every listener; done automatically when the room is left.
func remove_all_listeners() -> void:
	_handlers.clear()
	_unclaimed.clear()
	for sig in [message, raw_message, state_replaced, state_changed, left,
			error_received, client_joined, client_left]:
		for connection in sig.get_connections():
			sig.disconnect(connection["callable"])


# --- driven by the client --------------------------------------------------


## Adopts a JOIN_SUCCESS handshake (a join or a resume).
func bind_handshake(new_ref: int, handshake: Dictionary, codec) -> void:
	_codec = codec
	room_ref = new_ref
	id = handshake["room_id"]
	room_type = handshake["room_type"]
	session_id = handshake["session_id"]
	reconnection_token = handshake["reconnection_token"]
	contract_hash = handshake["contract_hash"]
	state_codec_name = handshake["state_codec"]
	_client_ids = {}
	var client_messages: Array = handshake["client_messages"]
	for i in client_messages.size():
		_client_ids[client_messages[i]] = i
	_server_names = handshake["server_messages"]
	# A first join holds its frames; a resumed seat already has its handlers.
	if _snapshots == 0:
		_held = []
	# Nothing may be decoded against the old stream: the next state frame is
	# a snapshot, which starts a new session.
	_session = null
	if status == Constants.RoomStatus.RECONNECTING:
		status = Constants.RoomStatus.JOINING


## The connection dropped; the seat will be resumed (§7.2).
func suspend() -> void:
	if status != Constants.RoomStatus.LEFT:
		status = Constants.RoomStatus.RECONNECTING


## Handles one frame for this room. On a first join, messages can arrive
## between JOIN_SUCCESS and the snapshot (§6.1), before the caller holds
## the room, so those are held in order and released afterwards.
func receive(type: int, header: Array, body: PackedByteArray) -> void:
	if _held != null:
		var first: bool = _snapshots == 0 and \
			(type == Frames.SERVER_STATE_SNAPSHOT or type == Frames.SERVER_LEAVE)
		if not first:
			_held.append([type, header, body])
			return
	_handle(type, header, body)


## Hands the kept pre-join events to the listeners attached since. A signal
## has no hook on connect, so the client calls this from every poll()
## instead: a kept event reaches a listener at the first poll after it was
## attached, never inside the call that attached it.
func claim_unclaimed() -> void:
	if _unclaimed.is_empty() or _held != null:
		return
	var kept: Array = _unclaimed
	_unclaimed = []
	# Whether each kind has a listener, looked up once per poll: an event
	# nobody ever handles stays kept, and is checked on every poll.
	var listening := {}
	for i in kept.size():
		if status == Constants.RoomStatus.LEFT:
			return
		var e: Dictionary = kept[i]
		var key: String = e["kind"] + ":" + e["name"] if e["kind"] == "message" else e["kind"]
		if not listening.has(key):
			listening[key] = _listens(e)
		if not listening[key] or not _dispatch(e):
			_unclaimed.append(e)


## Handles the frames held during a first join, in order.
func release_held() -> void:
	if _held == null:
		return
	var held: Array = _held
	_held = null
	_releasing = true
	for frame in held:
		if status == Constants.RoomStatus.LEFT:
			break
		_handle(frame[0], frame[1], frame[2])
	_releasing = false


## The room is over locally: emits `left`, then drops every listener
## (spec §7.2) and tells the client to forget it.
func mark_left(code: int) -> void:
	if status == Constants.RoomStatus.LEFT:
		return
	status = Constants.RoomStatus.LEFT
	_held = null
	var host = _host_ref.get_ref()
	if host != null:
		host.forget(self)
	left.emit(code)
	remove_all_listeners()


## Reports an error on this room.
func fail(code: String, text: String) -> void:
	error_received.emit(code, text)


# --- internals -------------------------------------------------------------


func _usable():
	match status:
		Constants.RoomStatus.LEFT:
			return Result.failure(Constants.NOT_JOINED, "the room has been left")
		Constants.RoomStatus.RECONNECTING:
			return Result.failure(Constants.NOT_CONNECTED, "reconnecting")
	return Result.success()


func _handle(type: int, header: Array, body: PackedByteArray) -> void:
	match type:
		Frames.SERVER_STATE_SNAPSHOT:
			_snapshot(body)
		Frames.SERVER_STATE_PATCH:
			_patch(body)
		Frames.SERVER_ROOM_MESSAGE:
			_contract_message(header[1] if header.size() > 1 else -1, body)
		Frames.SERVER_ROOM_MESSAGE_RAW:
			var array = _decode_array(body, 2, "ROOM_MESSAGE_RAW")
			if array == null:
				return
			if typeof(array[0]) != TYPE_STRING:
				_drop("raw message: type is not a string")
				return
			_offer({"kind": "raw", "name": array[0], "value": array[1]})
		Frames.SERVER_CLIENT_JOINED, Frames.SERVER_CLIENT_LEFT:
			var decoded = _decode(body)
			if typeof(decoded) != TYPE_STRING:
				_drop("frame %d: sessionId is not a string" % type)
				return
			var kind := "client_joined" if type == Frames.SERVER_CLIENT_JOINED else "client_left"
			_offer({"kind": kind, "name": decoded})
		Frames.SERVER_LEAVE:
			# No frame for this roomRef follows a LEAVE (§7.1).
			mark_left(header[1] if header.size() > 1 else Constants.LEAVE_KICKED)
		Frames.SERVER_ERROR:
			var error = _decode_array(body, 2, "ERROR")
			if error == null:
				return
			_offer({"kind": "error", "name": str(error[0]), "value": str(error[1])})
		_:
			_drop("frame %d: not a room frame" % type)


## Every snapshot starts a fresh stream: new session, new replica (§11.9).
func _snapshot(body: PackedByteArray) -> void:
	if _codec == null:
		_desync(Constants.DESYNC, "STATE_SNAPSHOT before the join")
		return
	_session = _codec.create_session()
	_snapshots += 1
	if status == Constants.RoomStatus.JOINING:
		status = Constants.RoomStatus.JOINED
	var root_script = _settings.get("state", null)
	if root_script == null:
		state = null
		_decoder = null
	else:
		var registry = _settings.get("registry", null)
		if registry == null:
			registry = preload("../replica/schema_registry.gd").new()
		registry.register(root_script)
		var root: Object = root_script.new()
		_decoder = StateDecoder.new(root, registry)
		# Weakly: the room holds the decoder, so a bound Callable back to
		# the room would be a cycle RefCounted never frees.
		var me := weakref(self)
		_decoder.unknown_class.connect(func(name: String) -> void:
			var room = me.get_ref()
			if room != null:
				room._unknown_class(name))
		state = root
		state_replaced.emit(root)
	_apply_state(body)


func _patch(body: PackedByteArray) -> void:
	if _session == null:
		_desync(Constants.DESYNC, "STATE_PATCH before a snapshot")
		return
	_apply_state(body)


func _apply_state(body: PackedByteArray) -> void:
	if _session == null:
		return
	var ops = _session.decode_ops(body)
	if not ops.ok:
		_desync(Constants.DESYNC, ops.message)
		return
	if _decoder != null:
		var applied = _decoder.apply(ops.value)
		if not applied.ok:
			_desync(Constants.DESYNC, applied.message)
			return
	if state != null:
		state_changed.emit(state)


## An instance of a class this client has none registered for was left out
## of the replica (§11.7). Loud, but not a desync.
func _unknown_class(name: String) -> void:
	var text := "the server sent \"%s\", a schema class this client has not registered; " % name \
		+ "its instances are missing from room.state. Register it through the join's " \
		+ "`registry` (the generated bindings' create_registry() has every class)"
	_log_error("room %s: %s" % [room_type, text])
	_offer({"kind": "error", "name": Constants.UNKNOWN_CLASS, "value": text})


func _desync(code: String, text: String) -> void:
	_session = null
	fail(code, text)
	var host = _host_ref.get_ref()
	if host != null:
		host.desync(self, code, text)


func _contract_message(id_value: int, body: PackedByteArray) -> void:
	# Ids resolve by name through the handshake's table (§6.5); an id or a
	# name this client can't map is dropped, not fatal.
	if id_value < 0 or id_value >= _server_names.size():
		_drop("message: unknown message id %d" % id_value)
		return
	var name: String = _server_names[id_value]
	var table: Dictionary = _settings.get("server_messages", {})
	if not table.has(name):
		_drop("message \"%s\": no declaration in this client's contract" % name)
		return
	if _codec == null:
		_drop("message \"%s\": the room has no codec yet" % name)
		return
	var payload = _codec.decode_message(table[name].definition(), body)
	if not payload.ok:
		_drop("message \"%s\": %s" % [name, payload.message])
		return
	_offer({"kind": "message", "name": name, "value": payload.value})


## Delivers an event to its listeners. With none, a pre-join event is kept
## for a handler registered later.
func _offer(e: Dictionary) -> void:
	if _dispatch(e):
		return
	if _held != null or _releasing:
		_unclaimed.append(e)
		if _unclaimed.size() > MAX_UNCLAIMED:
			_unclaimed.remove_at(0)
	elif e["kind"] == "message":
		_warn("no handler for message \"%s\"" % e["name"])


## False if the event found no listener.
func _dispatch(e: Dictionary) -> bool:
	match e["kind"]:
		"message":
			var handled := false
			if _handlers.has(e["name"]):
				var list: Array = _handlers[e["name"]]
				if not list.is_empty():
					handled = true
					for handler in list.duplicate():
						handler.call(e["value"])
			if message.get_connections().size() > 0:
				handled = true
				message.emit(e["name"], e["value"])
			return handled
		"raw":
			if raw_message.get_connections().is_empty():
				return false
			raw_message.emit(e["name"], e["value"])
			return true
		"client_joined":
			if client_joined.get_connections().is_empty():
				return false
			client_joined.emit(e["name"])
			return true
		"client_left":
			if client_left.get_connections().is_empty():
				return false
			client_left.emit(e["name"])
			return true
		_:
			if error_received.get_connections().is_empty():
				return false
			error_received.emit(e["name"], e["value"])
			return true


## Whether an event would find a listener now.
func _listens(e: Dictionary) -> bool:
	match e["kind"]:
		"message":
			return not _handlers.get(e["name"], []).is_empty() \
				or not message.get_connections().is_empty()
		"raw":
			return not raw_message.get_connections().is_empty()
		"client_joined":
			return not client_joined.get_connections().is_empty()
		"client_left":
			return not client_left.get_connections().is_empty()
		_:
			return not error_received.get_connections().is_empty()


func _decode(body: PackedByteArray) -> Variant:
	var decoded = MsgPack.decode(body)
	if decoded.ok:
		return decoded.value
	_drop("frame body: " + decoded.message)
	return null


## The known leading elements of an array body (§9.1).
func _decode_array(body: PackedByteArray, required: int, what: String) -> Variant:
	var value = _decode(body)
	if typeof(value) == TYPE_ARRAY and (value as Array).size() >= required:
		return value
	if value != null:
		_drop("%s: expected an array of %d or more" % [what, required])
	return null


func _drop(reason: String) -> void:
	var host = _host_ref.get_ref()
	if host != null:
		host.count_drop()
	_warn("dropped " + reason)


## The client's methods, safe once the client itself has been freed.
func _send(type: int, header: Array, body: PackedByteArray):
	var host = _host_ref.get_ref()
	if host == null:
		return Result.failure(Constants.NOT_CONNECTED, "the client is gone")
	return host.send_frame(type, header, body)


func _warn(text: String) -> void:
	var host = _host_ref.get_ref()
	if host != null:
		host.warn(text)


func _log_error(text: String) -> void:
	var host = _host_ref.get_ref()
	if host != null:
		host.log_error(text)
