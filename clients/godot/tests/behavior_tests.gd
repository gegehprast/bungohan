extends RefCounted
## The `behavior` conformance vectors (PROTOCOL.md §14): what a receiver
## must do with each frame.
##
## Client-side cases start from a connection holding one joined room at
## roomRef 1 with no contract, which scripted_transport.gd gives without a
## socket. Server-side cases say what the SERVER must do, so they run
## against the real interop server over a real WebSocket, with the frames
## sent verbatim; without one (BUNGOHAN_INTEROP_URL) they are skipped.

const BungohanClient = preload("res://addons/bungohan/net/bungohan_client.gd")
const Checks = preload("checks.gd")
const Constants = preload("res://addons/bungohan/net/constants.gd")
const Frames = preload("res://addons/bungohan/protocol/frames.gd")
const MsgPack = preload("res://addons/bungohan/protocol/msgpack.gd")
const Net = preload("net_support.gd")
const ScriptedTransport = preload("scripted_transport.gd")


## The handshake the scripted server answers a JOIN with (§6.4).
static func _handshake() -> PackedByteArray:
	return MsgPack.encode(["compat-room", "compat", "session-1", null, "", "schema", [], []]).value


## Answers the scripted client's JOIN with a handshake and an empty snapshot.
static func _answer(frame: PackedByteArray) -> Array:
	if frame.is_empty() or frame[0] != Frames.CLIENT_JOIN:
		return []
	var parsed = Frames.decode(frame, Frames.Direction.CLIENT)
	if not parsed.ok:
		return []
	var request_id: int = parsed.value.header[0]
	return [
		Frames.encode(Frames.SERVER_JOIN_SUCCESS, [request_id, 1], _handshake()),
		# An empty body is a room with no state (§5.2).
		Frames.encode(Frames.SERVER_STATE_SNAPSHOT, [1]),
	]


## Client side, against a scripted connection.
static func client_case(c: Dictionary) -> String:
	var transport := ScriptedTransport.new()
	transport.respond = func(frame): return _answer(frame)
	var client = BungohanClient.new({
		"url": "ws://scripted/",
		"transport": transport,
		"ping_interval_ms": 0,
		"join_timeout_ms": 0,
	})
	var box := Net.Box.new()
	var runner := _Runner.new()
	runner.box = box
	runner.client = client
	runner.call("join_compat")
	var problem := Net.until(client, func(): return box.done, "the join", 5000)
	if problem != "":
		return problem
	var joined = box.value
	if not joined.ok:
		return "join failed: %s: %s" % [joined.code, joined.message]
	var room = joined.value
	if room.room_ref != 1:
		return "roomRef %d, expected 1" % room.room_ref
	# Handlers for everything an "accept" frame may carry, so that nothing
	# counts as unhandled.
	room.raw_message.connect(func(_type, _payload): pass)
	room.message.connect(func(_name, _payload): pass)
	room.error_received.connect(func(_code, _message): pass)
	room.client_joined.connect(func(_id): pass)
	room.client_left.connect(func(_id): pass)

	var before: int = client.dropped_frames
	for hex in c["frames"]:
		transport.inject(Checks.from_hex(hex))
	# Several rounds: a frame may be handled on a later poll (deferred
	# work), and nothing here waits on real time.
	for i in 4:
		client.poll()
	var dropped: int = client.dropped_frames - before
	var expected := 1 if c["expect"] == "drop" else 0
	if dropped != expected:
		return "dropped %d frame(s), expected %d" % [dropped, expected]
	if not transport.is_open():
		return "the connection should stay open"
	if room.status != Constants.RoomStatus.JOINED:
		return "the room should stay joined, was %d" % room.status
	if client.state != Constants.ConnectionState.CONNECTED:
		return "the client should stay connected, was %d" % client.state
	return ""


## Server side, against the real interop server.
static func server_case(c: Dictionary, url: String) -> String:
	# The close code is what a `violation` case is checked by (§8.2), and
	# only the transport sees it.
	var closes: Array = []
	var transport := _ClosingTransport.new()
	transport.closes = closes
	var client = BungohanClient.new({
		"url": url,
		"ping_interval_ms": 0,
		"transport": transport,
		"reconnection": {"enabled": false},
	})
	var errors: Array = []
	client.error_received.connect(func(code, message): errors.append([code, message]))
	var box := Net.Box.new()
	var runner := _Runner.new()
	runner.box = box
	runner.client = client
	runner.call("join_compat")
	var problem := Net.until(client, func(): return box.done, "the join")
	if problem != "":
		return problem
	var joined = box.value
	if not joined.ok:
		return "join failed: %s: %s" % [joined.code, joined.message]
	if joined.value.room_ref != 1:
		return "roomRef %d, expected 1" % joined.value.room_ref

	for hex in c["frames"]:
		if not client.send_frame_bytes(Checks.from_hex(hex)):
			client.disconnect_from_server()
			return "the frame was not sent"
	var outcome := ""
	if c["expect"] == "violation":
		outcome = Net.until(client,
			func(): return client.state == Constants.ConnectionState.DISCONNECTED,
			"the server to close the connection")
		if outcome == "":
			# The ERROR frame that precedes the close may be dropped by the
			# transport (§8.2, §15: Godot's peer discards it), so the close
			# code is the signal; an ERROR that did arrive must be right.
			if closes.is_empty() or closes[0] != Constants.CLOSE_POLICY_VIOLATION:
				outcome = "expected a 1008 close, got %s" % [closes]
			else:
				for error in errors:
					if not str(error[1]).begins_with("INVALID_MESSAGE"):
						outcome = "expected INVALID_MESSAGE, got %s" % [error]
						break
	else:
		Net.run_for(client, 250)
		if not errors.is_empty():
			outcome = "unexpected error: %s" % [errors[0]]
		elif client.state != Constants.ConnectionState.CONNECTED:
			outcome = "the connection should stay open, was %d" % client.state
	client.disconnect_from_server()
	client.poll()
	return outcome


## The real WebSocket transport, recording each connection's close code.
class _ClosingTransport:
	extends "res://addons/bungohan/net/websocket_client_transport.gd"
	var closes: Array = []

	func open(url: String, protocols: PackedStringArray, on_open: Callable,
			on_message: Callable, on_close: Callable):
		var recorded := func(code: int, reason: String) -> void:
			closes.append(code)
			on_close.call(code, reason)
		return super.open(url, protocols, on_open, on_message, recorded)


## Starts the coroutine that awaits a join, so the pump can drive it.
class _Runner:
	extends RefCounted
	var box
	var client

	func join_compat() -> void:
		box.finish(await client.join_or_create("compat"))
