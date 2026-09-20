extends RefCounted
## End-to-end against the real server (`packages/testing/src/interop`), over
## a real WebSocket, through the generated bindings: joining, typed messages
## both ways, a replica compared field by field with the server's own view
## of its state, raw messages, a kick, a reconnection after an unexpected
## drop, and the two ways a join is refused up front (contract hash, state
## codec).
##
## Skipped without BUNGOHAN_INTEROP_URL; `bun run test:godot` starts the
## server and sets it.

const Bindings = preload("interop/bindings.gd")
const BungohanClient = preload("res://addons/bungohan/net/bungohan_client.gd")
const Checks = preload("checks.gd")
const Constants = preload("res://addons/bungohan/net/constants.gd")
const MsgpackCodec = preload("res://addons/bungohan/protocol/msgpack_codec.gd")
const Net = preload("net_support.gd")

var _url := ""


static func run() -> Checks:
	return new()._run()


func _run() -> Checks:
	var checks := Checks.new("interop (real server)")
	_url = Net.interop_url()
	if _url == "":
		checks.skip()
		return checks
	checks.record("joins, exchanges typed messages and mirrors the server's state", _state_case())
	checks.record("raw messages round-trip", _raw_case())
	checks.record("a kick ends the room with LEAVE 4000", _kick_case())
	checks.record("reconnects after an unexpected drop and gets a fresh snapshot", _reconnect_case())
	checks.record("a wrong contract hash fails the join with CONTRACT_MISMATCH", _contract_case())
	checks.record("an unknown state codec fails the join with CODEC_MISMATCH", _codec_case())
	checks.record("PING measures a round trip", _ping_case())
	checks.record("a room without reconnection hands out no token", _no_token_case())
	return checks


## The generated bindings, as a join's runtime inputs.
func _settings(contract_hash: String = "") -> Dictionary:
	return {
		"contract_hash": contract_hash if contract_hash != "" else Bindings.InteropContract.HASH,
		"server_messages": Bindings.InteropContract.SERVER,
		"registry": Bindings.create_registry(),
		"state": Bindings.Interop_State,
	}


func _client(options: Dictionary = {}):
	var merged := {"url": _url, "ping_interval_ms": 0}
	merged.merge(options, true)
	return BungohanClient.new(merged)


## Joins a room type and pumps until the join settles. Returns the Result.
func _join(client, settings: Dictionary, room_type := "interop"):
	var box := Net.Box.new()
	var runner := _Runner.new()
	runner.box = box
	runner.client = client
	runner.settings = settings
	runner.room_type = room_type
	runner.call("join")
	var problem := Net.until(client, func(): return box.done, "the join")
	if problem != "":
		return null
	return box.value


func _state_case() -> String:
	var client = _client()
	var joined = _join(client, _settings())
	if joined == null:
		return "the join never settled"
	if not joined.ok:
		return "join failed: %s: %s" % [joined.code, joined.message]
	var room = joined.value
	var outcome := _state_checks(client, room)
	client.disconnect_from_server()
	client.poll()
	return outcome


func _state_checks(client, room) -> String:
	# A message sent from the server's onJoin, i.e. before the caller held
	# the room: it must still reach this handler.
	var welcome := []
	room.on_message("welcome", func(payload): welcome.append(Bindings.WelcomeMessage.from_payload(payload)))
	var dump := []
	room.on_message("dump", func(payload): dump.append(Bindings.DumpMessage.from_payload(payload)))
	var echoed := []
	room.on_message("echoed", func(payload): echoed.append(Bindings.EchoedMessage.from_payload(payload)))
	var problem := Net.until(client, func(): return not welcome.is_empty(), "the welcome message")
	if problem != "":
		return problem
	if welcome[0].session_id != room.session_id:
		return "welcome.sessionId %s, expected %s" % [welcome[0].session_id, room.session_id]

	var state = room.state
	if state == null:
		return "the replica should be an Interop.State"
	if state.label != "interop":
		return "state.label %s" % state.label
	if not state.players.has_key(room.session_id):
		return "the replica should hold our player"

	# Typed messages, whose effect the server puts back in the state.
	var sends := [
		Bindings.SetNameMessage.new(), Bindings.MoveMessage.new(), Bindings.MoveMessage.new(),
		Bindings.AddTagMessage.new(), Bindings.AddTagMessage.new(), Bindings.BumpMessage.new(),
	]
	sends[0].name = "ada"
	sends[1].dx = 1.25
	sends[1].dy = -3.5
	sends[2].dx = 0.5
	sends[2].dy = 0.25
	sends[3].tag = "red"
	sends[4].tag = "blue"
	sends[5].by = 7
	sends[5].alive = false
	sends[5].note = "hi"
	for msg in sends:
		var sent = room.send(msg)
		if not sent.ok:
			return "send failed: %s: %s" % [sent.code, sent.message]
	problem = Net.until(client,
		func(): return state.turn == 2 and state.players.at(room.session_id).score == 7,
		"the state to catch up")
	if problem != "":
		return problem

	var player = state.players.at(room.session_id)
	problem = Checks.difference(player.name, "ada", "player.name")
	if problem != "":
		return problem
	problem = Checks.difference(player.x, 1.75, "player.x")
	if problem != "":
		return problem
	problem = Checks.difference(player.y, -3.25, "player.y")
	if problem != "":
		return problem
	if player.alive:
		return "player.alive should be false"
	var tags: Array = player.tags.values()
	tags.sort()
	problem = Checks.difference(tags, ["blue", "red"], "player.tags")
	if problem != "":
		return problem
	problem = Checks.difference(state.log.to_array(), ["name:ada", "note:hi"], "state.log")
	if problem != "":
		return problem

	# An optional the sender left out must decode as absent.
	var echo := Bindings.EchoMessage.new()
	echo.text = "hello"
	echo.count = 0
	room.send(echo)
	problem = Net.until(client, func(): return not echoed.is_empty(), "the echo")
	if problem != "":
		return problem
	if echoed[0].text != "hello":
		return "echoed.text %s" % echoed[0].text
	if echoed[0].note != null:
		return "echoed.note should be absent, was %s" % [echoed[0].note]

	# The server's own view of its state, compared to the replica.
	room.send(Bindings.RequestDumpMessage.new())
	problem = Net.until(client, func(): return not dump.is_empty(), "the dump")
	if problem != "":
		return problem
	return _compare(dump[0], state)


## Every field of the server's dump against the replica.
func _compare(dump, state) -> String:
	var problem := Checks.difference(dump.turn, state.turn, "dump.turn vs replica")
	if problem != "":
		return problem
	problem = Checks.difference(dump.label, state.label, "dump.label vs replica")
	if problem != "":
		return problem
	problem = Checks.difference(dump.log, state.log.to_array(), "dump.log vs replica")
	if problem != "":
		return problem
	if dump.players.size() != state.players.size():
		return "dump has %d player(s), the replica %d" % [dump.players.size(), state.players.size()]
	for entry in dump.players:
		if not state.players.has_key(entry.id):
			return "the replica lacks player " + entry.id
		var player = state.players.at(entry.id)
		for check in [
			[entry.name, player.name, "name"], [entry.x, player.x, "x"], [entry.y, player.y, "y"],
			[entry.score, player.score, "score"], [entry.alive, player.alive, "alive"],
		]:
			problem = Checks.difference(check[1], check[0], "%s.%s" % [entry.id, check[2]])
			if problem != "":
				return problem
		var expected: Array = entry.tags.duplicate()
		expected.sort()
		var actual: Array = player.tags.values()
		actual.sort()
		problem = Checks.difference(actual, expected, "%s.tags" % entry.id)
		if problem != "":
			return problem
	return ""


func _raw_case() -> String:
	var client = _client()
	var joined = _join(client, _settings())
	if joined == null or not joined.ok:
		return "join failed"
	var room = joined.value
	var got := []
	room.raw_message.connect(func(type, payload): got.append([type, payload]))
	room.send_raw("ping", [1, "two", true])
	var problem := Net.until(client, func(): return not got.is_empty(), "the raw reply")
	if problem == "":
		problem = Checks.difference(got[0], ["pong", [1, "two", true]], "raw reply")
	client.disconnect_from_server()
	client.poll()
	return problem


func _kick_case() -> String:
	var client = _client()
	var joined = _join(client, _settings())
	if joined == null or not joined.ok:
		return "join failed"
	var room = joined.value
	var codes := []
	room.left.connect(func(code): codes.append(code))
	var kick := Bindings.KickMeMessage.new()
	kick.reason = "bye"
	room.send(kick)
	var problem := Net.until(client, func(): return not codes.is_empty(), "the kick")
	if problem == "":
		if codes[0] != Constants.LEAVE_KICKED:
			problem = "leave code %d, expected %d" % [codes[0], Constants.LEAVE_KICKED]
		elif room.status != Constants.RoomStatus.LEFT:
			problem = "the room should be left"
		elif client.state != Constants.ConnectionState.CONNECTED:
			# The connection is untouched by a kick (§7.1).
			problem = "the connection should stay open"
	client.disconnect_from_server()
	client.poll()
	return problem


func _reconnect_case() -> String:
	var client = _client({
		"reconnection": {"enabled": true, "max_attempts": 5, "delay_ms": 20, "delay_max_ms": 50},
	})
	var joined = _join(client, _settings())
	if joined == null or not joined.ok:
		return "join failed"
	var room = joined.value
	var problem := _reconnect_checks(client, room)
	client.disconnect_from_server()
	client.poll()
	return problem


func _reconnect_checks(client, room) -> String:
	var state = room.state
	var rename := Bindings.SetNameMessage.new()
	rename.name = "grace"
	room.send(rename)
	var move := Bindings.MoveMessage.new()
	move.dx = 2.5
	move.dy = 2.5
	room.send(move)
	var session_id: String = room.session_id
	var problem := Net.until(client,
		func(): return state.players.at(session_id) != null and state.players.at(session_id).name == "grace",
		"the name")
	if problem != "":
		return problem

	var token = room.reconnection_token
	if token == null:
		return "the room should allow reconnection"
	var snapshots: int = room.snapshots()
	var replaced := []
	room.state_replaced.connect(func(_s): replaced.append(1))

	# The server drops the whole connection, without a LEAVE.
	room.send(Bindings.DropMeMessage.new())
	problem = Net.until(client,
		func(): return room.status == Constants.RoomStatus.JOINED and room.snapshots() > snapshots,
		"the seat to resume with a fresh snapshot")
	if problem != "":
		return problem

	if room.session_id != session_id:
		return "the sessionId should survive a reconnection"
	if room.reconnection_token == token:
		return "the token should be replaced on every rejoin"
	if replaced.is_empty():
		return "the snapshot should have replaced the replica"
	var restored = room.state
	if restored == state:
		return "the replica should be a new object"
	problem = Checks.difference(restored.players.at(session_id).name, "grace", "the restored name")
	if problem != "":
		return problem
	return Checks.difference(restored.players.at(session_id).x, 2.5, "the restored x")


func _contract_case() -> String:
	var client = _client()
	var joined = _join(client, _settings("deadbeef"))
	var problem := ""
	if joined == null:
		problem = "the join never settled"
	elif joined.ok:
		problem = "the join should have failed"
	elif joined.code != Constants.CONTRACT_MISMATCH:
		problem = "error code %s, expected %s" % [joined.code, Constants.CONTRACT_MISMATCH]
	elif client.state != Constants.ConnectionState.CONNECTED:
		problem = "the connection should stay open"
	client.disconnect_from_server()
	client.poll()
	return problem


func _codec_case() -> String:
	# The server's rooms use `schema`; a client with only the other codec
	# must leave the seat and fail locally (§6.4).
	var client = _client({"state_codecs": [MsgpackCodec.new()]})
	var joined = _join(client, _settings())
	var problem := ""
	if joined == null:
		problem = "the join never settled"
	elif joined.ok:
		problem = "the join should have failed"
	elif joined.code != Constants.CODEC_MISMATCH:
		problem = "error code %s, expected %s" % [joined.code, Constants.CODEC_MISMATCH]
	client.disconnect_from_server()
	client.poll()
	return problem


func _ping_case() -> String:
	var client = _client({"ping_interval_ms": 10})
	var joined = _join(client, _settings())
	if joined == null or not joined.ok:
		return "join failed"
	var problem := Net.until(client, func(): return client.latency >= 0.0, "a round trip measurement")
	client.disconnect_from_server()
	client.poll()
	return problem


## A room with allow_reconnection false sends a null token (§6.4).
func _no_token_case() -> String:
	var client = _client()
	var joined = _join(client, _settings(), "solo")
	var problem := ""
	if joined == null or not joined.ok:
		problem = "join failed"
	elif joined.value.reconnection_token != null:
		problem = "expected no token, got %s" % [joined.value.reconnection_token]
	client.disconnect_from_server()
	client.poll()
	return problem


## Starts the coroutine that awaits a join, so the pump can drive it.
class _Runner:
	extends RefCounted
	var box
	var client
	var settings: Dictionary
	var room_type := "interop"

	func join() -> void:
		box.finish(await client.join_or_create(room_type, null, settings))
