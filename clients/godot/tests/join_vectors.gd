extends RefCounted
## `join` conformance vectors (PROTOCOL.md §6.2.1, §14): building the JOIN
## frame gives exactly the case's bytes, and, with the interop server,
## sending those bytes on a fresh connection gets the case's reply and, on
## success, the room's echo of what it received.

const BungohanClient = preload("res://addons/bungohan/net/bungohan_client.gd")
const Checks = preload("checks.gd")
const Frames = preload("res://addons/bungohan/protocol/frames.gd")
const MsgPack = preload("res://addons/bungohan/protocol/msgpack.gd")
const TypedOptions = preload("res://addons/bungohan/protocol/typed_options.gd")

const PROTOCOL := "bungohan.v1"
const TIMEOUT_MS := 5000


static func encode(c: Dictionary) -> String:
	if not c.has("request"):
		return ""
	var declares: Dictionary = c["declares"]
	var create = Checks.message_of(declares["create"]) if declares.has("create") else null
	var join = Checks.message_of(declares["join"]) if declares.has("join") else null
	var r: Dictionary = c["request"]
	var options := TypedOptions.new(join, r.get("join", {}), create, r.get("create", {}))
	var body = BungohanClient.encode_join(int(r["mode"]), r["target"], options, r["contractHash"])
	if not body.ok:
		return "encoding failed: %s" % body
	var frame := Frames.encode(Frames.CLIENT_JOIN, [int(r["requestId"])], body.value)
	return Checks.same_hex(Checks.from_hex(c["hex"]), frame, "JOIN bytes")


## Sends the case's bytes to the interop server's `options` room type.
static func server(c: Dictionary, url: String) -> String:
	var bytes := Checks.from_hex(c["hex"])
	var sent = Frames.decode(bytes, Frames.Direction.CLIENT)
	if not sent.ok:
		return "the case's JOIN doesn't parse"
	var request_id: int = sent.value.header[0]
	var peer := WebSocketPeer.new()
	peer.supported_protocols = PackedStringArray([PROTOCOL])
	if peer.connect_to_url(url) != OK:
		return "could not connect to " + url
	var problem := _wait_open(peer)
	if problem != "":
		return problem
	peer.put_packet(bytes)

	var reply = _next(peer, func(frame):
		return (frame.type == Frames.SERVER_JOIN_SUCCESS or frame.type == Frames.SERVER_JOIN_ERROR) \
			and frame.header[0] == request_id)
	if reply == null:
		peer.close()
		return "timed out waiting for the JOIN reply"
	var expected: String = c["reply"]
	var outcome := ""
	if expected != "JOIN_SUCCESS":
		if reply.type != Frames.SERVER_JOIN_ERROR:
			outcome = "expected JOIN_ERROR %s, got JOIN_SUCCESS" % expected
		else:
			var error = MsgPack.decode(reply.body)
			if not error.ok or typeof(error.value) != TYPE_ARRAY or error.value.is_empty():
				outcome = "malformed JOIN_ERROR body"
			elif typeof(error.value[0]) != TYPE_STRING or error.value[0] != expected:
				outcome = "JOIN_ERROR %s, expected %s" % [error.value[0], expected]
			elif peer.get_ready_state() != WebSocketPeer.STATE_OPEN:
				outcome = "the connection should stay open"
		peer.close()
		return outcome
	if reply.type != Frames.SERVER_JOIN_SUCCESS:
		peer.close()
		return "expected JOIN_SUCCESS, got JOIN_ERROR %s" % Checks.show(MsgPack.decode(reply.body).value)
	var room_ref: int = reply.header[1]
	var echo = _next(peer, func(frame):
		return frame.type == Frames.SERVER_ROOM_MESSAGE_RAW and frame.header[0] == room_ref)
	peer.close()
	if echo == null:
		return "timed out waiting for the room's echo"
	var message = MsgPack.decode(echo.body)
	if not message.ok or typeof(message.value) != TYPE_ARRAY or message.value.size() < 2:
		return "malformed echo"
	if typeof(message.value[0]) != TYPE_STRING or message.value[0] != "options":
		return "echo type %s" % Checks.show(message.value[0])
	var received = c["received"] if c.has("received") else {
		"join": c["request"].get("join"),
		"create": c["request"].get("create"),
	}
	return Checks.difference(message.value[1], received, "received")


static func _wait_open(peer: WebSocketPeer) -> String:
	var deadline := Time.get_ticks_msec() + TIMEOUT_MS
	while Time.get_ticks_msec() < deadline:
		peer.poll()
		var state := peer.get_ready_state()
		if state == WebSocketPeer.STATE_OPEN:
			return ""
		if state == WebSocketPeer.STATE_CLOSED:
			return "the connection closed: %d %s" % [peer.get_close_code(), peer.get_close_reason()]
		OS.delay_msec(2)
	return "the connection did not open"


## The next server frame `wanted` accepts, or null after the timeout.
static func _next(peer: WebSocketPeer, wanted: Callable):
	var deadline := Time.get_ticks_msec() + TIMEOUT_MS
	while Time.get_ticks_msec() < deadline:
		peer.poll()
		while peer.get_available_packet_count() > 0:
			var frame = Frames.decode(peer.get_packet(), Frames.Direction.SERVER)
			if frame.ok and wanted.call(frame.value):
				return frame.value
		if peer.get_ready_state() == WebSocketPeer.STATE_CLOSED:
			return null
		OS.delay_msec(2)
	return null
