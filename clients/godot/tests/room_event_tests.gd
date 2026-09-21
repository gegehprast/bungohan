extends RefCounted
## The unclaimed-event rule (spec §7.5): what a room sends before its caller
## holds it (here, every event kind the server can send from onJoin, between
## JOIN_SUCCESS and the snapshot) is kept and reaches the first listener
## attached for it, however late. Against scripted_transport.gd, so no
## server is needed.

const Bindings = preload("interop/bindings.gd")
const BungohanClient = preload("res://addons/bungohan/net/bungohan_client.gd")
const Checks = preload("checks.gd")
const Frames = preload("res://addons/bungohan/protocol/frames.gd")
const MsgPack = preload("res://addons/bungohan/protocol/msgpack.gd")
const Net = preload("net_support.gd")
const SchemaCodec = preload("res://addons/bungohan/protocol/schema_codec.gd")
const ScriptedTransport = preload("scripted_transport.gd")


static func run() -> Checks:
	var checks := Checks.new("room events")
	checks.record("events sent in onJoin reach listeners attached after the join resolves",
		_early_events())
	return checks


static func _early_events() -> String:
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
	runner.call("join")
	var problem := Net.until(client, func(): return box.done, "the join", 5000)
	if problem != "":
		return problem
	var joined = box.value
	if not joined.ok:
		return "join failed: %s: %s" % [joined.code, joined.message]
	var room = joined.value
	# Later than the join itself: the held frames have been released and
	# found no listener.
	for i in 3:
		client.poll()

	var got: Array = []
	room.message.connect(func(name, payload):
		got.append("%s %s" % [name, Bindings.WelcomeMessage.from_payload(payload).session_id]))
	room.raw_message.connect(func(type, payload): got.append("raw %s %s" % [type, payload]))
	room.client_joined.connect(func(id): got.append("joined " + id))
	room.client_left.connect(func(id): got.append("left " + id))
	room.error_received.connect(func(code, text): got.append("error %s %s" % [code, text]))
	if not got.is_empty():
		return "delivered inside the connecting call: %s" % [got]

	client.poll()
	problem = Checks.difference(got, [
		"welcome session-1", "raw hello 7", "joined s-2", "left s-3", "error BOOM went wrong",
	], "delivered")
	if problem != "":
		return problem

	# Delivered once: a listener attached later finds nothing kept.
	got.clear()
	room.raw_message.connect(func(type, _payload): got.append("again " + type))
	room.client_joined.connect(func(id): got.append("again " + id))
	client.poll()
	if not got.is_empty():
		return "a kept event should reach one listener only, got %s" % [got]
	# No disconnect: a scripted close queues work on a socket nobody polls
	# again, a cycle RefCounted never frees (the behavior cases don't either).
	return ""


## Answers the JOIN as a room that sends one event of each kind from its
## onJoin: after the handshake, before the snapshot (§6.1).
static func _answer(frame: PackedByteArray) -> Array:
	if frame.is_empty() or frame[0] != Frames.CLIENT_JOIN:
		return []
	var parsed = Frames.decode(frame, Frames.Direction.CLIENT)
	if not parsed.ok:
		return []
	var request_id: int = parsed.value.header[0]
	var welcome = Bindings.WelcomeMessage.new()
	welcome.session_id = "session-1"
	welcome.players = 1
	var message = SchemaCodec.new().encode_message(
		Bindings.WelcomeMessage.definition(), welcome.to_payload())
	return [
		Frames.encode(Frames.SERVER_JOIN_SUCCESS, [request_id, 1], _body(
			["early-room", "early", "session-1", null, "", "schema", [], ["welcome"]])),
		Frames.encode(Frames.SERVER_ROOM_MESSAGE, [1, 0], message.value),
		Frames.encode(Frames.SERVER_ROOM_MESSAGE_RAW, [1], _body(["hello", 7])),
		Frames.encode(Frames.SERVER_CLIENT_JOINED, [1], _body("s-2")),
		Frames.encode(Frames.SERVER_CLIENT_LEFT, [1], _body("s-3")),
		Frames.encode(Frames.SERVER_ERROR, [1], _body(["BOOM", "went wrong"])),
		# An empty body is a room with no state (§5.2).
		Frames.encode(Frames.SERVER_STATE_SNAPSHOT, [1]),
	]


static func _body(value: Variant) -> PackedByteArray:
	return MsgPack.encode(value).value


## Starts the coroutine that awaits a join, so the pump can drive it.
class _Runner:
	extends RefCounted
	var box
	var client

	func join() -> void:
		box.finish(await client.join_or_create("early", null,
			{"server_messages": Bindings.InteropContract.SERVER}))
