extends RefCounted
## Every conformance vector (PROTOCOL.md §14). Codec cases run in both
## directions: encode → exact bytes, and bytes → decoded values. Server-side
## `behavior` cases need the interop server (BUNGOHAN_INTEROP_URL, set by
## `bun run test:godot`); without it they are the only cases skipped.
## Run by run_vectors.gd.

const Checks = preload("checks.gd")
const Contract = preload("res://addons/bungohan/protocol/contract.gd")
const Frames = preload("res://addons/bungohan/protocol/frames.gd")
const MsgPack = preload("res://addons/bungohan/protocol/msgpack.gd")
const MsgpackCodec = preload("res://addons/bungohan/protocol/msgpack_codec.gd")
const Numeric = preload("res://addons/bungohan/protocol/numeric.gd")
const BehaviorTests = preload("behavior_tests.gd")
const Net = preload("net_support.gd")
const ReplicaVectors = preload("replica_vectors.gd")
const ByteReader = preload("res://addons/bungohan/protocol/byte_reader.gd")
const ByteWriter = preload("res://addons/bungohan/protocol/byte_writer.gd")
const SchemaCodec = preload("res://addons/bungohan/protocol/schema_codec.gd")

var _codecs := {"schema": SchemaCodec.new(), "messagepack": MsgpackCodec.new()}


static func run() -> Checks:
	return new()._run()


func _run() -> Checks:
	var checks := Checks.new("conformance vectors")
	var interop_url := Net.interop_url()
	var dir := Checks.repo_root().path_join("conformance/v1")
	var files := DirAccess.get_files_at(dir)
	files.sort()
	if files.is_empty():
		checks.record("vector files", "none in " + dir)
		return checks
	for file in files:
		if not file.ends_with(".json"):
			continue
		var vectors: Variant = Checks.load_json(dir.path_join(file))
		var cases: Array = vectors["cases"]
		for i in cases.size():
			var c: Dictionary = cases[i]
			var kind: String = c["kind"]
			var label := "%s #%d %s%s" % [file, i, kind, (": " + c["description"]) if c.has("description") else ""]
			match kind:
				"varint":
					checks.record(label, _varint(c, false))
				"zigzag":
					checks.record(label, _varint(c, true))
				"fixed", "int", "float32":
					checks.record(label, _numeric(c, kind))
				"frame":
					checks.record(label, _frame_case(c))
				"messagepack":
					checks.record(label, _messagepack(c))
				"message":
					checks.record(label, _message(c))
				"state":
					checks.record(label, _state(c))
				"replica":
					checks.record(label, ReplicaVectors.run(c))
				"behavior":
					if c.get("side", "client") == "server":
						if interop_url == "":
							checks.skip()
						else:
							checks.record(label, BehaviorTests.server_case(c, interop_url))
					else:
						checks.record(label, BehaviorTests.client_case(c))
				_:
					checks.record(label, "unknown case kind " + kind)
	return checks


func _varint(c: Dictionary, signed: bool) -> String:
	var bytes := Checks.from_hex(c["hex"])
	var input := ByteReader.new(bytes)
	var value := input.varint()
	if c.get("error", false):
		return "" if input.failed() or not input.done() else "decoding should fail"
	if input.failed() or not input.done():
		return "decode failed or left bytes: " + input.error
	var expected: int = c["value"]
	var actual := Numeric.unzigzag(value) if signed else value
	if actual != expected:
		return "decoded %d, expected %d" % [actual, expected]
	if c.get("encode", true) == false:
		return ""
	var writer := ByteWriter.new()
	if signed:
		writer.zigzag(expected)
	else:
		writer.varint(expected)
	return Checks.same_hex(bytes, writer.bytes, "encoded")


func _numeric(c: Dictionary, kind: String) -> String:
	var value: float = float(c["value"])
	var actual: float
	match kind:
		"fixed":
			actual = Numeric.fixed_encode(value, int(c["decimals"]))
		"int":
			actual = Numeric.int_encode(value, Numeric.int_kind_of(c["type"]))
		_:
			actual = Numeric.float32(value)
	return Checks.difference(actual, c["wire"], kind)


func _frame_case(c: Dictionary) -> String:
	var direction := Frames.Direction.CLIENT if c["direction"] == "client" else Frames.Direction.SERVER
	var bytes := Checks.from_hex(c["hex"])
	var parsed = Frames.decode(bytes, direction)
	if c.get("error", false):
		return "" if not parsed.ok else "parsing should fail"
	var body := Checks.from_hex(c["bodyHex"])
	if c.has("body"):
		var encoded = MsgPack.encode(c["body"])
		if not encoded.ok:
			return "body encode failed: " + encoded.message
		var problem := Checks.same_hex(body, encoded.value, "body")
		if problem != "":
			return problem
		var decoded = MsgPack.decode(body)
		if not decoded.ok:
			return "body decode failed: " + decoded.message
		problem = Checks.difference(decoded.value, c["body"], "decoded body")
		if problem != "":
			return problem
	var built := Frames.encode(int(c["type"]), c["header"], body)
	var built_problem := Checks.same_hex(bytes, built, "built frame")
	if built_problem != "":
		return built_problem
	if not parsed.ok:
		return "parse failed: " + parsed.message
	if parsed.value.type != int(c["type"]):
		return "type %d" % parsed.value.type
	var header_problem := Checks.difference(parsed.value.header, c["header"], "header")
	if header_problem != "":
		return header_problem
	return Checks.same_hex(body, parsed.value.body, "body")


func _messagepack(c: Dictionary) -> String:
	var bytes := Checks.from_hex(c["hex"])
	var encoded = MsgPack.encode(c["value"])
	if not encoded.ok:
		return "encode failed: " + encoded.message
	var problem := Checks.same_hex(bytes, encoded.value, "encoded")
	if problem != "":
		return problem
	var decoded = MsgPack.decode(bytes)
	if not decoded.ok:
		return "decode failed: " + decoded.message
	return Checks.difference(decoded.value, c["decoded"] if c.has("decoded") else c["value"], "decoded")


func _message(c: Dictionary) -> String:
	var def := Checks.message_of(c["message"])
	var hexes: Dictionary = c["hex"]
	for codec_name in hexes:
		var codec = _codecs[codec_name]
		var bytes := Checks.from_hex(hexes[codec_name])
		var decoded = codec.decode_message(def, bytes)
		if c.get("error", false):
			if decoded.ok:
				return codec_name + ": decoding should fail"
			continue
		var encoded = codec.encode_message(def, c["payload"])
		if not encoded.ok:
			return codec_name + ": encode failed: " + encoded.message
		var problem := Checks.same_hex(bytes, encoded.value, codec_name + " bytes")
		if problem != "":
			return problem
		if not decoded.ok:
			return codec_name + ": decode failed: " + decoded.message
		problem = Checks.difference(decoded.value, c["decoded"] if c.has("decoded") else c["payload"], codec_name + " decoded")
		if problem != "":
			return problem
	return ""


func _state(c: Dictionary) -> String:
	var codec = _codecs[c["codec"]]
	var encoder = codec.create_session()
	var clients: Array = c.get("clients", ["a"])
	var decoders := {}
	for name in clients:
		decoders[name] = codec.create_session()
	var frames: Array = c["frames"]
	for i in frames.size():
		var frame: Dictionary = frames[i]
		var to: Array = frame.get("to", clients)
		if frame.get("error", false):
			if frame.has("ops") and encoder.encode_ops(frame["ops"]).ok:
				return "frame %d: encoding should fail" % i
			if frame.has("hex"):
				var error_bytes := Checks.from_hex(frame["hex"])
				for name in to:
					if decoders[name].decode_ops(error_bytes).ok:
						return "frame %d, %s: decoding should fail" % [i, name]
			return ""  # an error ends the case
		var bytes := Checks.from_hex(frame["hex"])
		if frame.get("encode", true) != false:
			var encoded = encoder.encode_ops(frame["ops"])
			if not encoded.ok:
				return "frame %d: encode failed: %s" % [i, encoded.message]
			var problem := Checks.same_hex(bytes, encoded.value, "frame %d bytes" % i)
			if problem != "":
				return problem
		var expected: Variant = frame["decoded"] if frame.has("decoded") else frame["ops"]
		for name in to:
			var decoded = decoders[name].decode_ops(bytes)
			if not decoded.ok:
				return "frame %d, %s: decode failed: %s" % [i, name, decoded.message]
			var problem := Checks.difference(decoded.value, expected, "frame %d, %s ops" % [i, name])
			if problem != "":
				return problem
	return ""
