extends RefCounted
## Replica tests (PROTOCOL.md §11) with hand-written classes in the shape
## the generator emits (tests/fixtures). Each test returns "" or a reason.

const Checks = preload("checks.gd")
const Registry = preload("res://addons/bungohan/replica/schema_registry.gd")
const SchemaCodec = preload("res://addons/bungohan/protocol/schema_codec.gd")
const StateDecoder = preload("res://addons/bungohan/replica/state_decoder.gd")
const StateStream = preload("res://addons/bungohan/replica/state_stream.gd")
const Unit = preload("fixtures/unit.gd")
const Vec = preload("fixtures/vec.gd")
const World = preload("fixtures/world.gd")

# Server class table: World 0, Unit 1, Vec 2. World's collections: units 1,
# order 2, scores 3. A Unit at R: pos is a ref, tags R+1.
const DEFINES := [
	[4, 0, "World", ["tick", "units", "order", "scores"],
		["float64", "schemaMap<uint32,Unit>", "schemaArray<Unit>", "map<string,fixed:1>"]],
	[4, 1, "Unit", ["name", "pos", "hp", "tags"], ["string", "schema<Vec>", "uint8", "set<string>"]],
	[4, 2, "Vec", ["x", "y"], ["fixed:2", "fixed:2"]],
]


static func run() -> Checks:
	var checks := Checks.new("replica")
	var tests := new()
	for name in ["snapshot", "created_silent", "move", "drop_and_reuse", "clear", "unknown_class",
			"skip_and_mismatch", "malformed", "stream"]:
		checks.record(name, tests.call("test_" + name))
	return checks


static func registry(with_all := true):
	var r := Registry.new()
	r.register(World)
	if with_all:
		r.register(Unit)
		r.register(Vec)
	return r


## A unit at refId r (its Vec at r + 2), placed by `place`.
static func spawn(place: Array, r: int, name: String, x: int) -> Array:
	return [place, [0, r, 0, name], [0, r, 1, [2, r + 2]], [0, r + 2, 0, x], [0, r, 2, 100], [1, r + 1, "new"]]


static func snapshot() -> Array:
	return DEFINES + [[0, 0, 0, 1.5]] + spawn([1, 1, 7, [1, 4]], 4, "ann", 150)


func test_snapshot() -> String:
	var root := World.new()
	var decoder := StateDecoder.new(root, registry())
	var events := []
	root.tick_changed.connect(func(v, old): events.append("tick %s (was %s)" % [v, old]))
	root.units.added.connect(func(unit, key): events.append("added %d %s x=%s tags=%d" % [key, unit.name, unit.pos.x, unit.tags.size()]))
	var result = decoder.apply(snapshot())
	if not result.ok:
		return str(result)
	var problem := Checks.difference(events, ["tick 1.5 (was 0.0)", "added 7 ann x=1.5 tags=1"], "events")
	if problem != "":
		return problem
	var unit = root.units.at(7)
	if unit.name != "ann" or unit.pos.x != 1.5 or unit.hp != 100:
		return "content: %s %s %s" % [unit.name, unit.pos.x, unit.hp]
	return "" if unit.pos.y == 0.0 else "a local default must be reset to zero"


func test_created_silent() -> String:
	var root := World.new()
	var decoder := StateDecoder.new(root, registry())
	var fired := [0]
	root.units.added.connect(func(unit, _key): unit.name_changed.connect(func(_v, _p): fired[0] += 1))
	decoder.apply(snapshot())
	if fired[0] != 0:
		return "listeners attached in added see only later frames"
	decoder.apply([[0, 4, 0, "bea"]])
	return "" if fired[0] == 1 else "a later change fires once, fired %d" % fired[0]


func test_move() -> String:
	var root := World.new()
	var decoder := StateDecoder.new(root, registry())
	decoder.apply(snapshot())
	var before = root.units.at(7)
	var result = decoder.apply([[2, 1, 7], [1, 1, 8, [1, 4]]])
	if not result.ok or not is_same(before, root.units.at(8)):
		return "identity lost across the move"
	decoder.apply([[0, 4, 0, "moved"]])
	return "" if before.name == "moved" else "the moved instance stopped receiving ops"


func test_drop_and_reuse() -> String:
	var root := World.new()
	var decoder := StateDecoder.new(root, registry())
	decoder.apply(snapshot())
	var old = root.units.at(7)
	decoder.apply([[2, 1, 7]])
	var stale = decoder.apply([[0, 4, 0, "ghost"]])
	if stale.code != "UNKNOWN_REF":
		return "the dropped refId should be unknown, got " + str(stale)
	var result = decoder.apply(spawn([1, 1, 9, [1, 4]], 4, "cid", 2))
	if not result.ok:
		return str(result)
	if is_same(old, root.units.at(9)):
		return "a reused block must create a fresh object"
	return "" if root.units.at(9).name == "cid" else "new content missing"


func test_clear() -> String:
	var root := World.new()
	var decoder := StateDecoder.new(root, registry())
	decoder.apply(snapshot() + [[1, 2, 0, [1, 4]]])
	decoder.apply([[3, 1]])
	if root.order.at(0).name != "ann":
		return "still held by the array"
	decoder.apply([[3, 2]])
	return "" if decoder.apply([[0, 4, 0, "x"]]).code == "UNKNOWN_REF" else "should be dropped"


func test_unknown_class() -> String:
	var root := World.new()
	var decoder := StateDecoder.new(root, registry(false))
	var unknown := []
	decoder.unknown_class.connect(func(name): unknown.append(name))
	decoder.apply(snapshot())
	var result = decoder.apply(spawn([1, 1, 8, [1, 10]], 10, "bo", 3))
	if not result.ok or root.units.size() != 0:
		return "the unknown class must be ignored: " + str(result)
	if unknown != ["Unit"]:
		return "reported %s" % [unknown]
	var array = decoder.apply([[1, 2, 0, [1, 20]]])
	return "" if array.code == "UNKNOWN_CLASS" else "an unknown array element is an error"


func test_skip_and_mismatch() -> String:
	var extra := [4, 0, "World", ["tick", "units", "order", "scores", "wind"],
		["float64", "schemaMap<uint32,Unit>", "schemaArray<Unit>", "map<string,fixed:1>", "float32"]]
	var root := World.new()
	var result = StateDecoder.new(root, registry()).apply([extra, [0, 0, 4, 2.5], [0, 0, 0, 3.0]])
	if not result.ok or root.tick != 3.0:
		return "known fields must still apply: " + str(result)
	var clash = StateDecoder.new(World.new(), registry()).apply([[4, 0, "World", ["tick"], ["float32"]]])
	return "" if clash.code == "SCHEMA_MISMATCH" else "float32 vs float64: " + str(clash)


func test_malformed() -> String:
	var decoder := StateDecoder.new(World.new(), registry())
	decoder.apply(DEFINES)
	var cases := [
		[[0, 0, 0, "x"], "MALFORMED_OP"],
		[[1, 3, "k", 0.5], "MALFORMED_OP"],
		[[3, 99], "UNKNOWN_REF"],
		[[1, 0, 1, 1], "MALFORMED_OP"],
	]
	for c in cases:
		var result = decoder.apply([c[0]])
		if result.code != c[1]:
			return "%s: expected %s, got %s" % [c[0], c[1], result]
	return ""


func test_stream() -> String:
	var codec := SchemaCodec.new()
	var stream := StateStream.new(codec, registry(), World)
	if stream.apply_patch(PackedByteArray()).code != "NO_SNAPSHOT":
		return "a patch before a snapshot is NO_SNAPSHOT"
	var body: PackedByteArray = codec.create_session().encode_ops(snapshot()).value
	var roots := []
	stream.replaced.connect(func(state): roots.append(state))
	stream.apply_snapshot(body)
	var first = stream.state
	var result = stream.apply_snapshot(body)
	if not result.ok or is_same(first, stream.state) or roots.size() != 2:
		return "a new root per snapshot: " + str(result)
	return "" if stream.state.units.at(7).name == "ann" else "content"
