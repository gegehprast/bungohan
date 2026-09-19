extends RefCounted
## The generated bindings at work: the recorded shooter stream
## (clients/fixtures) applied through the generated scripts in
## example/shooter must end in the state the TypeScript client replica had;
## every codegen golden script must load; generated messages must
## round-trip through both codecs.

const Bindings = preload("res://example/shooter/bindings.gd")
const Checks = preload("checks.gd")
const MsgpackCodec = preload("res://addons/bungohan/protocol/msgpack_codec.gd")
const SchemaCodec = preload("res://addons/bungohan/protocol/schema_codec.gd")
const StateStream = preload("res://addons/bungohan/replica/state_stream.gd")

var _codecs := {"schema": SchemaCodec.new(), "messagepack": MsgpackCodec.new()}


static func run() -> Checks:
	var checks := Checks.new("generated bindings")
	var tests := new()
	for codec in ["schema", "messagepack"]:
		checks.record("shooter-stream.%s.json through the generated scripts" % codec, tests.shooter_stream(codec))
	checks.record("every golden script loads", tests.golden_loads())
	for codec in ["schema", "messagepack"]:
		checks.record("golden everything_message round-trips under " + codec, tests.round_trip(codec))
	return checks


func shooter_stream(codec_name: String) -> String:
	var recording: Dictionary = Checks.load_json(Checks.repo_root().path_join("clients/fixtures/shooter-stream.%s.json" % codec_name))
	var codec = _codecs[recording["codec"]]
	if recording["contractHash"] != Bindings.ShooterContract.HASH:
		return "contract hash differs"
	var stream := StateStream.new(codec, Bindings.create_registry(), Bindings.GameState)
	var events := {}
	var count := func(key: String) -> void: events[key] = events.get(key, 0) + 1
	var unknown := []
	stream.unknown_class.connect(func(name): unknown.append(name))
	var snapshots := 0
	var last_status := [""]

	for frame in recording["frames"]:
		var body := Checks.from_hex(frame["hex"])
		match frame["kind"]:
			"message":
				var decoded = Bindings.ShooterContract.decode_server(codec, frame["name"], body)
				if not decoded.ok:
					return "message decode failed: " + str(decoded)
				var problem := Checks.difference(decoded.value.to_payload(), frame["payload"], frame["name"])
				if problem != "":
					return problem
				if frame["name"] == "gameEnded" and (decoded.value.results.size() != 2 or decoded.value.results[0].rank != 1):
					return "typed nested results"
			"snapshot":
				var applied = stream.apply_snapshot(body)
				if not applied.ok:
					return "snapshot failed: " + str(applied)
				snapshots += 1
				if snapshots > 1:
					continue
				# Listeners attached once the join's snapshot is applied, as the
				# recording's TypeScript client did.
				var state = stream.state
				state.enemies.added.connect(func(_v, _k): count.call("enemiesAdded"))
				state.enemies.removed.connect(func(_v, _k): count.call("enemiesRemoved"))
				state.bullets.added.connect(func(_v, _k): count.call("bulletsAdded"))
				state.bullets.removed.connect(func(_v, _k): count.call("bulletsRemoved"))
				state.loot.added.connect(func(_v, _k): count.call("lootAdded"))
				state.loot.removed.connect(func(_v, _k): count.call("lootRemoved"))
				state.game_status_changed.connect(func(value, _p):
					count.call("statusChanges")
					last_status[0] = value)
				state.players.added.connect(func(player, _k):
					count.call("playersAdded")
					player.score_changed.connect(func(_v, _p): count.call("scoreChanges")))
			_:
				var applied = stream.apply_patch(body)
				if not applied.ok:
					return "patch failed: " + str(applied)
	if snapshots != 1:
		return "snapshots: %d" % snapshots
	if not unknown.is_empty():
		return "unknown classes: %s" % [unknown]
	for key in recording["events"]:
		if events.get(key, 0) != recording["events"][key]:
			return "event count %s: %d, expected %d" % [key, events.get(key, 0), recording["events"][key]]
	if events.has("statusChanges") and last_status[0] != stream.state.game_status:
		return "last status event"
	return Checks.difference(_dump_game(stream.state), recording["final"], "final state")


# --- the canonical dump (record-stream.ts), built from typed members --------


static func _sorted(map, dump: Callable) -> Array:
	var keys: Array = map.keys()
	keys.sort()
	var out := []
	for key in keys:
		out.append([key, dump.call(map.at(key))])
	return out


static func _dump_game(s) -> Dictionary:
	return {
		"$class": "GameState",
		"players": _sorted(s.players, func(p): return {
			"$class": "Player", "name": p.name, "color": p.color, "x": p.x, "y": p.y,
			"rotation": p.rotation, "score": p.score, "health": p.health,
			"isDead": p.is_dead, "isReady": p.is_ready}),
		"enemies": _sorted(s.enemies, func(e): return {"$class": "Enemy", "x": e.x, "y": e.y, "health": e.health}),
		"bullets": _sorted(s.bullets, func(b): return {"$class": "Bullet", "ownerId": b.owner_id, "x": b.x, "y": b.y}),
		"loot": _sorted(s.loot, func(l): return {"$class": "Loot", "x": l.x, "y": l.y, "value": l.value}),
		"roomCode": s.room_code, "roomName": s.room_name, "hostId": s.host_id, "gameTime": s.game_time,
		"gameStatus": s.game_status, "maxPlayers": s.max_players, "canStart": s.can_start,
	}


# --- golden scripts -----------------------------------------------------------


func _golden_dir() -> String:
	return Checks.repo_root().path_join("packages/codegen/test/golden/gdscript")


func golden_loads() -> String:
	var loaded := 0
	for sub in ["", "schemas", "messages", "contracts"]:
		var dir := _golden_dir().path_join(sub)
		for file in DirAccess.get_files_at(dir):
			if not file.ends_with(".gd"):
				continue
			var script = load(dir.path_join(file))
			if script == null or not script.can_instantiate():
				return "could not load " + dir.path_join(file)
			loaded += 1
	return "" if loaded >= 8 else "only %d golden scripts" % loaded


func round_trip(codec_name: String) -> String:
	var codec = _codecs[codec_name]
	var bindings = load(_golden_dir().path_join("bindings.gd"))
	var point = bindings.PointMessage.new()
	point.x = 1.25
	var message = bindings.EverythingMessage.new()
	message.i8 = -5
	message.u32 = 4000000000
	message.f32 = 0.1
	message.fx = -1.2345
	message.text = "héllo"
	message.flag = true
	message.color = "dark blue"
	message.level = 5
	message.list = [1, -2]
	message.names = {"a": "b"}
	message.maybe = 2.5
	message.maybe_flag = false
	message.maybe_color = "south"
	message.holes = [1, null]
	message.sparse = {"x": null, "y": true}
	message.point = point
	message.path = [point]
	message.grid = [[1.5], []]
	message.tagged = {"t": [point]}
	message.palette = ["blue"]
	message.definition_ = "d"
	message.encode_ = true
	var encoded = message.encode(codec)
	if not encoded.ok:
		return "encode failed: " + str(encoded)
	var decoded = bindings.EverythingMessage.decode(codec, encoded.value)
	if not decoded.ok:
		return "decode failed: " + str(decoded)
	var back = decoded.value
	if back.fx != -1.235 or back.u32 != 4000000000 or back.maybe_color != "south" or back.maybe_point != null:
		return "values: fx %s u32 %s" % [back.fx, back.u32]
	if back.path[0].x != 1.25 or back.tagged["t"][0].x != 1.25 or back.holes[1] != null:
		return "nested values"
	var again = back.encode(codec)
	return Checks.same_hex(encoded.value, again.value, "re-encoding")
