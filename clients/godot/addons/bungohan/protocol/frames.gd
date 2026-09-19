extends RefCounted
## frame = type:u8  header:varint × N(type)  body (PROTOCOL.md §3). One
## WebSocket binary message is one frame.

const ByteWriter = preload("byte_writer.gd")
const Numeric = preload("numeric.gd")
const Result = preload("result.gd")

enum Direction { CLIENT, SERVER }

# Client → server.
const CLIENT_ROOM_MESSAGE := 0x00
const CLIENT_ROOM_MESSAGE_RAW := 0x01
const CLIENT_JOIN := 0x02
const CLIENT_LEAVE := 0x03
const CLIENT_PING := 0x04

# Server → client.
const SERVER_ROOM_MESSAGE := 0x00
const SERVER_ROOM_MESSAGE_RAW := 0x01
const SERVER_STATE_SNAPSHOT := 0x02
const SERVER_STATE_PATCH := 0x03
const SERVER_JOIN_SUCCESS := 0x04
const SERVER_JOIN_ERROR := 0x05
const SERVER_CLIENT_JOINED := 0x06
const SERVER_CLIENT_LEFT := 0x07
const SERVER_LEAVE := 0x08
const SERVER_ERROR := 0x09
const SERVER_PONG := 0x0a

const _CLIENT_HEADERS := [2, 1, 1, 1, 2]
const _SERVER_HEADERS := [2, 1, 1, 1, 2, 1, 1, 1, 2, 1, 1]


## A parsed frame. body is a copy of the frame's remaining bytes.
class Frame:
	extends RefCounted
	var type: int
	var header: Array
	var body: PackedByteArray

	func _init(frame_type: int, frame_header: Array, frame_body: PackedByteArray) -> void:
		type = frame_type
		header = frame_header
		body = frame_body


## The number of header varints of a frame type, or -1 for a type this
## version doesn't know (a client drops those, §9.2).
static func header_count(direction: int, type: int) -> int:
	var table: Array = _CLIENT_HEADERS if direction == Direction.CLIENT else _SERVER_HEADERS
	return table[type] if type >= 0 and type < table.size() else -1


static func encode(type: int, header: Array, body: PackedByteArray = PackedByteArray()) -> PackedByteArray:
	var writer := ByteWriter.new()
	writer.u8(type)
	for value in header:
		writer.varint(value)
	writer.append(body)
	return writer.bytes


## Parses a frame (value: Frame). An empty message, an unknown type or a
## header that can't be read is DECODE_FAILED; use header_count() first to
## tell an unknown type apart.
static func decode(data: PackedByteArray, direction: int):
	if data.is_empty():
		return Result.failure(Result.DECODE_FAILED, "empty frame")
	var type := data[0]
	var count := header_count(direction, type)
	if count < 0:
		return Result.failure(Result.DECODE_FAILED, "unknown frame type %d" % type)
	var at := 1
	var header := []
	for i in count:
		var value := 0
		var ended := false
		for k in 5:
			if at >= data.size():
				break
			var b := data[at]
			at += 1
			value |= (b & 0x7f) << (7 * k)
			if b & 0x80 == 0:
				ended = true
				break
		if not ended or value > Numeric.UINT32_MAX:
			return Result.failure(Result.DECODE_FAILED, "bad frame header")
		header.append(value)
	return Result.success(Frame.new(type, header, data.slice(at)))
