extends RefCounted
## Protocol-level constants a client needs (PROTOCOL.md §2, §6, §7, §8) and
## the error codes this client reports.

## The WebSocket subprotocol this client speaks (§2.1).
const VERSION := "bungohan.v1"

# The `mode` of a JOIN body (§6.2).
const JOIN_OR_CREATE := 0
const JOIN_CREATE := 1
const JOIN_JOIN := 2
const JOIN_BY_ID := 3
const JOIN_RECONNECT := 4
const JOIN_CONSUME_RESERVATION := 5

# The `code` of a LEAVE frame (§7.1).
const LEAVE_CONSENTED := 1000
## Used locally when a seat can't be resumed.
const LEAVE_DISCONNECTED := 1001
const LEAVE_KICKED := 4000
const LEAVE_SERVER_SHUTDOWN := 4001
const LEAVE_ROOM_DISPOSED := 4002

# WebSocket close codes this protocol uses (§8.3).
const CLOSE_NORMAL := 1000
const CLOSE_GOING_AWAY := 1001
## The server does not speak this protocol version (§2.2).
const CLOSE_PROTOCOL_ERROR := 1002
const CLOSE_ABNORMAL := 1006
const CLOSE_POLICY_VIOLATION := 1008
const CLOSE_TOO_LARGE := 1009

# Where a client's connection is.
enum ConnectionState { DISCONNECTED, CONNECTING, CONNECTED, RECONNECTING }

# Where a room is in its life.
enum RoomStatus { JOINING, JOINED, RECONNECTING, LEFT }

# JOIN_ERROR codes (§8.1).
const INVALID_OPTIONS := "INVALID_OPTIONS"
const SERVER_SHUTTING_DOWN := "SERVER_SHUTTING_DOWN"
const ROOM_TYPE_NOT_DEFINED := "ROOM_TYPE_NOT_DEFINED"
const CONTRACT_MISMATCH := "CONTRACT_MISMATCH"
const ROOM_NOT_FOUND := "ROOM_NOT_FOUND"
const ROOM_LOCKED := "ROOM_LOCKED"
const ROOM_FULL := "ROOM_FULL"
const ALREADY_JOINED := "ALREADY_JOINED"
const AUTH_FAILED := "AUTH_FAILED"
const JOIN_FAILED := "JOIN_FAILED"
const INVALID_TOKEN := "INVALID_TOKEN"
const RESERVATION_NOT_FOUND := "RESERVATION_NOT_FOUND"
const RESERVATION_EXPIRED := "RESERVATION_EXPIRED"

# Local codes.
const CONNECTION_FAILED := "CONNECTION_FAILED"
const CONNECTION_LOST := "CONNECTION_LOST"
const RECONNECTION_FAILED := "RECONNECTION_FAILED"
const NOT_CONNECTED := "NOT_CONNECTED"
const PROTOCOL_ERROR := "PROTOCOL_ERROR"
const CODEC_MISMATCH := "CODEC_MISMATCH"
const INVALID_MESSAGE := "INVALID_MESSAGE"
const UNKNOWN_MESSAGE := "UNKNOWN_MESSAGE"
const NOT_JOINED := "NOT_JOINED"
const LEFT := "LEFT"
const TIMEOUT := "TIMEOUT"
const DESYNC := "DESYNC"
const SERVER_ERROR := "SERVER_ERROR"
const UNKNOWN_CLASS := "UNKNOWN_CLASS"

const _JOIN_ERRORS := [
	INVALID_OPTIONS, SERVER_SHUTTING_DOWN, ROOM_TYPE_NOT_DEFINED, CONTRACT_MISMATCH,
	ROOM_NOT_FOUND, ROOM_LOCKED, ROOM_FULL, ALREADY_JOINED, AUTH_FAILED, JOIN_FAILED,
	INVALID_TOKEN, RESERVATION_NOT_FOUND, RESERVATION_EXPIRED,
]


## A JOIN_ERROR code as a client code. One this version doesn't know (a
## newer server) becomes JOIN_FAILED, with the original kept separately.
static func from_join_error(code: String) -> String:
	return code if _JOIN_ERRORS.has(code) else JOIN_FAILED


## Reads a decoded JOIN_SUCCESS body (§6.4) into a Dictionary, or returns
## an empty one if it is malformed. Elements after the eighth are ignored.
static func parse_handshake(body: Variant) -> Dictionary:
	if typeof(body) != TYPE_ARRAY or (body as Array).size() < 8:
		return {}
	var array: Array = body
	for i in [0, 1, 2, 4, 5]:
		if typeof(array[i]) != TYPE_STRING:
			return {}
	if array[3] != null and typeof(array[3]) != TYPE_STRING:
		return {}
	var client_messages := _strings(array[6])
	var server_messages := _strings(array[7])
	if client_messages == null or server_messages == null:
		return {}
	return {
		"room_id": array[0],
		"room_type": array[1],
		"session_id": array[2],
		"reconnection_token": array[3],
		"contract_hash": array[4],
		"state_codec": array[5],
		"client_messages": client_messages,
		"server_messages": server_messages,
	}


static func _strings(value: Variant) -> Variant:
	if typeof(value) != TYPE_ARRAY:
		return null
	for item in value:
		if typeof(item) != TYPE_STRING:
			return null
	return value
