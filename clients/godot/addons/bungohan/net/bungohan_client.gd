extends RefCounted
## A Bungohan client (PROTOCOL.md §6, §7): joins rooms, exchanges contract
## and raw messages, keeps a state replica per room, and reconnects with
## the stored token.
##
## Everything happens in poll(), which the game calls once a frame from
## _process. The transport is driven there, frames are parsed there, and
## every signal and every awaited join resumes there, so nothing of yours
## ever runs off the main thread.
##
##     var client = BungohanClient.new({"url": "ws://127.0.0.1:6060"})
##     func _process(_delta: float) -> void:
##         client.poll()
##     func _ready() -> void:
##         await client.connect_to_server()
##         var joined = await client.join_or_create("game", {}, settings)
##         if joined.ok:
##             joined.value.send(Bindings.InputMessage.new())

const Constants = preload("constants.gd")
const Frames = preload("../protocol/frames.gd")
const MsgPack = preload("../protocol/msgpack.gd")
const MsgpackCodec = preload("../protocol/msgpack_codec.gd")
const Result = preload("../protocol/result.gd")
const Room = preload("bungohan_room.gd")
const SchemaCodec = preload("../protocol/schema_codec.gd")
const WebSocketClientTransport = preload("websocket_client_transport.gd")

## Largest header varint (§1.1).
const MAX_VARINT := 0xffffffff
## Client-initiated close used to force a re-sync (§11.10).
const RESYNC_CLOSE := 4000

## An open connection closed (whether or not a reconnection follows).
signal disconnected
## A reconnection opened a new connection; seats resume next.
signal reconnected
## Connection-level errors: ERROR frames, failed reconnection.
signal error_received(code: String, message: String)

## Where the connection is (Constants.ConnectionState).
var state: int = Constants.ConnectionState.DISCONNECTED
## Last measured round trip in milliseconds, or -1 (§7.5).
var latency := -1.0
## Frames dropped under the §9.2 rules. Diagnostics.
var dropped_frames := 0

var _url: String
var _reconnection: Dictionary
var _transport
var _codecs := {}
var _ping_interval_ms: float
var _join_timeout_ms: float
var _log: Callable
var _now: Callable

var _socket = null
var _socket_open := false
## Deferred work, run at the start of the next poll.
var _inbox: Array = []
var _by_ref := {}
var _resuming: Array = []
var _pending := {}
var _connecting: Array = []
var _next_request := 1
var _next_nonce := 1
var _attempt := 0
var _retry_at := INF
var _next_ping_at := INF
var _ping_nonce := 0
var _ping_sent_at := 0.0
var _polling := false
## Bumped for every connection, so a stale socket's events are ignored.
var _generation := 0


## A join or connect whose outcome may arrive before anyone awaits it, so
## the result is kept as well as signalled:
##
##     if not waiter.done:
##         await waiter.settled
##     return waiter.result
class Waiter:
	extends RefCounted
	signal settled(result)
	var done := false
	var result = null

	func resolve(value) -> void:
		if done:
			return
		done = true
		result = value
		settled.emit(value)


## `options` keys, all optional but `url`:
## `url`, `token` (sent as ?token=), `transport`, `state_codecs` (Array,
## default schema + messagepack), `ping_interval_ms` (5000, 0 disables),
## `join_timeout_ms` (10000, 0 disables), `reconnection`
## ({enabled, max_attempts, delay_ms, delay_max_ms, factor}), `log`
## (Callable(level, message)) and `now` (Callable() -> float ms).
func _init(options: Dictionary) -> void:
	_url = _with_token(options.get("url", ""), options.get("token", null))
	var reconnection: Dictionary = options.get("reconnection", {})
	_reconnection = {
		"enabled": reconnection.get("enabled", true),
		"max_attempts": reconnection.get("max_attempts", 10),
		"delay_ms": float(reconnection.get("delay_ms", 1000.0)),
		"delay_max_ms": float(reconnection.get("delay_max_ms", 30000.0)),
		"factor": float(reconnection.get("factor", 2.0)),
	}
	_transport = options.get("transport", null)
	if _transport == null:
		_transport = WebSocketClientTransport.new()
	var codecs: Array = options.get("state_codecs", [SchemaCodec.new(), MsgpackCodec.new()])
	for codec in codecs:
		_codecs[codec.get_name()] = codec
	_ping_interval_ms = float(options.get("ping_interval_ms", 5000.0))
	_join_timeout_ms = float(options.get("join_timeout_ms", 10000.0))
	_log = options.get("log", func(_level: String, _message: String) -> void: pass)
	_now = options.get("now", func() -> float: return float(Time.get_ticks_msec()))


## Rooms that have had a snapshot, including resuming ones.
func rooms() -> Array:
	var list: Array = []
	for room in _by_ref.values():
		if room.snapshots() > 0:
			list.append(room)
	list.append_array(_resuming)
	return list


# --- the pump --------------------------------------------------------------


## Drives the transport, dispatches everything it reported, and runs
## everything that has fallen due (pings, join timeouts, reconnection
## attempts). Call it once a frame. A call from inside one of the signals
## it emits does nothing, so a listener can't recurse into the pump.
func poll() -> void:
	if _polling:
		return
	_polling = true
	if _socket != null:
		_socket.poll()
	while not _inbox.is_empty():
		var work: Array = _inbox
		_inbox = []
		for action in work:
			action.call()
	_timers()
	_polling = false


func _timers() -> void:
	var now: float = _now.call()
	if now >= _retry_at:
		_retry_at = INF
		_open()
	if now >= _next_ping_at:
		_next_ping_at = now + _ping_interval_ms if _ping_interval_ms > 0 else INF
		_send_ping(now)
	if _pending.is_empty():
		return
	var due: Array = []
	for request_id in _pending:
		if now >= _pending[request_id]["deadline"]:
			due.append(request_id)
	for request_id in due:
		_settle(request_id, Result.failure(Constants.TIMEOUT, "the server did not answer the join"))


# --- connection ------------------------------------------------------------


## Opens the connection; resolves once it is open (or has failed). A first
## connect that never opens fails with CONNECTION_FAILED and is not retried.
func connect_to_server():
	if state == Constants.ConnectionState.CONNECTED:
		return Result.success()
	var waiter := Waiter.new()
	_connecting.append(waiter)
	if state == Constants.ConnectionState.DISCONNECTED:
		state = Constants.ConnectionState.CONNECTING
		_open()
	if not waiter.done:
		await waiter.settled
	return waiter.result


## Leaves every room (consented) and closes. No reconnection follows.
func disconnect_from_server() -> void:
	leave_all()
	_retry_at = INF
	var socket = _socket
	var was_open := _socket_open
	_socket = null
	_socket_open = false
	_set_disconnected(Constants.CONNECTION_LOST, "client disconnected")
	if socket != null:
		socket.close(Constants.CLOSE_NORMAL, "client disconnect")
	if was_open:
		disconnected.emit()


func leave_all() -> void:
	for room in _by_ref.values().duplicate():
		room.leave()
	for room in _resuming.duplicate():
		room.leave()
	for request_id in _pending.keys().duplicate():
		if _pending.has(request_id):
			_pending[request_id]["room"].leave()


# --- joins -----------------------------------------------------------------


func join_or_create(room_type: String, options: Variant = null, settings: Dictionary = {}):
	return await _join(Constants.JOIN_OR_CREATE, room_type, options, settings, null)


func create(room_type: String, options: Variant = null, settings: Dictionary = {}):
	return await _join(Constants.JOIN_CREATE, room_type, options, settings, null)


func join(room_type: String, options: Variant = null, settings: Dictionary = {}):
	return await _join(Constants.JOIN_JOIN, room_type, options, settings, null)


func join_by_id(room_id: String, options: Variant = null, settings: Dictionary = {}):
	return await _join(Constants.JOIN_BY_ID, room_id, options, settings, null)


## Resumes a held seat with a token kept from an earlier connection (§7.3).
## Automatic reconnection needs no call.
func reconnect(room_id: String, reconnection_token: String, settings: Dictionary = {}):
	return await _join(Constants.JOIN_RECONNECT, reconnection_token, null, settings, room_id)


func consume_reservation(reservation_id: String, settings: Dictionary = {}):
	return await _join(Constants.JOIN_CONSUME_RESERVATION, reservation_id, null, settings, null)


func _join(mode: int, target: String, options: Variant, settings: Dictionary, room_id):
	var connected = await connect_to_server()
	if not connected.ok:
		return connected
	var room = Room.new(self, settings)
	return await _request(room, mode, target, options, room_id, false)


func _request(room, mode: int, target: String, options: Variant, room_id, resume: bool):
	var waiter := _start_request(room, mode, target, options, room_id, resume)
	if not waiter.done:
		await waiter.settled
	return waiter.result


## Sends the JOIN and records the pending join. Synchronous on purpose:
## a resume after a reconnection starts one without awaiting it.
func _start_request(room, mode: int, target: String, options: Variant, room_id,
		resume: bool) -> Waiter:
	var request_id := _next_request
	_next_request = 1 if request_id >= MAX_VARINT else request_id + 1
	var waiter := Waiter.new()
	_pending[request_id] = {
		"room": room,
		"room_id": room_id,
		"resume": resume,
		"waiter": waiter,
		"deadline": (_now.call() + _join_timeout_ms) if _join_timeout_ms > 0 else INF,
	}
	var body = MsgPack.encode([mode, target, options, room.hash_or_null()])
	var sent = send_frame(Frames.CLIENT_JOIN, [request_id], body.value) if body.ok else body
	if not sent.ok:
		_settle(request_id, sent)
	return waiter


## Resolves a pending join. A failure after JOIN_SUCCESS (a timeout, …)
## gives back the seat the server already assigned.
func _settle(request_id: int, result) -> void:
	if not _pending.has(request_id):
		return
	var pending: Dictionary = _pending[request_id]
	_pending.erase(request_id)
	if not result.ok:
		var room = pending["room"]
		if _by_ref.get(room.room_ref) == room and room.status != Constants.RoomStatus.LEFT:
			send_frame(Frames.CLIENT_LEAVE, [room.room_ref], PackedByteArray())
			_by_ref.erase(room.room_ref)
		if pending["resume"]:
			# A seat that couldn't be resumed is gone.
			room.fail(result.code, result.message)
			room.mark_left(Constants.LEAVE_DISCONNECTED)
	pending["waiter"].resolve(result)


func _join_success(request_id: int, room_ref: int, body: PackedByteArray) -> void:
	if not _pending.has(request_id):
		_warn("dropped JOIN_SUCCESS for unknown request %d" % request_id)
		# The server seated us; don't keep a seat nobody uses.
		send_frame(Frames.CLIENT_LEAVE, [room_ref], PackedByteArray())
		return
	var pending: Dictionary = _pending[request_id]
	var decoded = MsgPack.decode(body)
	var handshake: Dictionary = Constants.parse_handshake(decoded.value) if decoded.ok else {}
	if handshake.is_empty():
		send_frame(Frames.CLIENT_LEAVE, [room_ref], PackedByteArray())
		_settle(request_id, Result.failure(Constants.INVALID_MESSAGE, "malformed JOIN_SUCCESS"))
		return
	var codec_name: String = handshake["state_codec"]
	if not _codecs.has(codec_name):
		# No fallback to another codec (§6.4): leave, fail locally.
		send_frame(Frames.CLIENT_LEAVE, [room_ref], PackedByteArray())
		_settle(request_id, Result.failure(Constants.CODEC_MISMATCH,
			"the room uses state codec \"%s\", which this client can't decode" % codec_name))
		return
	if pending["room_id"] != null and pending["room_id"] != handshake["room_id"]:
		send_frame(Frames.CLIENT_LEAVE, [room_ref], PackedByteArray())
		_settle(request_id, Result.failure(Constants.INVALID_TOKEN,
			"the token belongs to room %s, not %s" % [handshake["room_id"], pending["room_id"]]))
		return
	pending["room"].bind_handshake(room_ref, handshake, _codecs[codec_name])
	_by_ref[room_ref] = pending["room"]
	# The join completes with the first STATE_SNAPSHOT (§6.1).


# --- frames ----------------------------------------------------------------


## Sends raw frame bytes on the current connection. For tools and
## conformance tests; ordinary code uses the room's methods.
func send_frame_bytes(frame: PackedByteArray) -> bool:
	if _socket == null or not _socket_open:
		return false
	return _socket.send(frame)


func send_frame(type: int, header: Array, body: PackedByteArray):
	if _socket == null or not _socket_open:
		return Result.failure(Constants.NOT_CONNECTED, "not connected")
	if not _socket.send(Frames.encode(type, header, body)):
		return Result.failure(Constants.NOT_CONNECTED, "the connection is closed")
	return Result.success()


func _receive(generation: int, data: PackedByteArray) -> void:
	if generation != _generation:
		return
	if data.is_empty():
		_drop("empty frame")
		return
	var type := data[0]
	# An unknown frame type is dropped, not fatal: a newer server may send
	# frames this client predates. A frame is one whole transport message,
	# so skipping it is always safe (§9.2).
	if Frames.header_count(Frames.Direction.SERVER, type) < 0:
		_drop("frame: unknown frame type %d" % type)
		return
	var parsed = Frames.decode(data, Frames.Direction.SERVER)
	if not parsed.ok:
		_drop("frame %d: %s" % [type, parsed.message])
		return
	var header: Array = parsed.value.header
	var body: PackedByteArray = parsed.value.body
	var first: int = header[0] if header.size() > 0 else 0
	match type:
		Frames.SERVER_JOIN_SUCCESS:
			_join_success(first, header[1] if header.size() > 1 else 0, body)
			return
		Frames.SERVER_JOIN_ERROR:
			var error := _error_body(body)
			_settle(first, Result.failure(Constants.from_join_error(error[0]), error[1]))
			return
		Frames.SERVER_PONG:
			_pong(first)
			return
		Frames.SERVER_ERROR:
			if first == 0:
				var error := _error_body(body)
				error_received.emit(Constants.SERVER_ERROR, "%s: %s" % [error[0], error[1]])
				return
	if not _by_ref.has(first):
		# Normally the LEAVE(1000) acknowledging our own LEAVE (§7.1):
		# dropped silently, not a compatibility drop.
		return
	var room = _by_ref[first]
	room.receive(type, header, body)
	if type == Frames.SERVER_STATE_SNAPSHOT:
		_joined(room)


## A room's snapshot arrived: complete its pending join, if any.
func _joined(room) -> void:
	if room.status != Constants.RoomStatus.LEFT:
		for request_id in _pending.keys().duplicate():
			if _pending.has(request_id) and _pending[request_id]["room"] == room:
				# Emitting resumes the awaiting code inline, so it has
				# registered its handlers before the held frames below.
				_settle(request_id, Result.success(room))
				break
	room.release_held()


## [code, message], reading only the known elements (§9.1).
func _error_body(body: PackedByteArray) -> Array:
	var decoded = MsgPack.decode(body)
	if decoded.ok and typeof(decoded.value) == TYPE_ARRAY and (decoded.value as Array).size() >= 2:
		return [str(decoded.value[0]), str(decoded.value[1])]
	return [Constants.INVALID_MESSAGE, "malformed error body"]


# --- connection lifecycle --------------------------------------------------


func _open() -> void:
	_generation += 1
	var generation := _generation
	# Weakly: the client holds the socket, and the socket holds these
	# Callables, so binding them to self would be a cycle RefCounted never
	# frees (PROTOCOL.md §15).
	var me := weakref(self)
	var opened = _transport.open(_url, PackedStringArray([Constants.VERSION]),
		func(_protocol: String) -> void:
			var client = me.get_ref()
			if client != null:
				client._inbox.append(func() -> void: client._opened(generation)),
		func(data: PackedByteArray) -> void:
			var client = me.get_ref()
			if client != null:
				client._inbox.append(func() -> void: client._receive(generation, data)),
		func(code: int, reason: String) -> void:
			var client = me.get_ref()
			if client != null:
				client._inbox.append(func() -> void: client._lost(generation, code, reason)))
	if not opened.ok:
		_failed_attempt(opened.code, opened.message)
		return
	_socket = opened.value
	_socket_open = false


func _opened(generation: int) -> void:
	if generation != _generation:
		return
	_socket_open = true
	var was_reconnecting := state == Constants.ConnectionState.RECONNECTING
	state = Constants.ConnectionState.CONNECTED
	_attempt = 0
	_next_ping_at = (_now.call() + _ping_interval_ms) if _ping_interval_ms > 0 else INF
	for waiter in _connecting.duplicate():
		waiter.resolve(Result.success())
	_connecting.clear()
	if not was_reconnecting:
		return
	reconnected.emit()
	# Resume every held seat with its current token (§7.3).
	for room in _resuming.duplicate():
		_resuming.erase(room)
		if room.reconnection_token == null:
			room.mark_left(Constants.LEAVE_DISCONNECTED)
			continue
		# Started, not awaited: its outcome reaches the room itself.
		_start_request(room, Constants.JOIN_RECONNECT, room.reconnection_token,
			null, room.id, true)


## The connection closed, or never opened.
func _lost(generation: int, code: int, reason: String) -> void:
	if generation != _generation:
		return
	_generation += 1
	_socket = null
	var was_open := _socket_open
	_socket_open = false
	_next_ping_at = INF

	# Joins in flight on this connection can't complete. Resumes go back to
	# waiting and are retried on the next connection.
	for request_id in _pending.keys().duplicate():
		if not _pending.has(request_id):
			continue
		var pending: Dictionary = _pending[request_id]
		if pending["resume"]:
			_pending.erase(request_id)
			_resuming.append(pending["room"])
			pending["room"].suspend()
			pending["waiter"].resolve(
				Result.failure(Constants.CONNECTION_LOST, "connection closed"))
		else:
			_settle(request_id, Result.failure(Constants.CONNECTION_LOST, "connection closed"))

	if state == Constants.ConnectionState.CONNECTING:
		# A first connect that never opened: report it, don't retry.
		_set_disconnected(Constants.CONNECTION_FAILED, "closed with %d %s" % [code, reason])
		return

	var terminal: bool = code == Constants.CLOSE_PROTOCOL_ERROR \
		or code == Constants.CLOSE_POLICY_VIOLATION \
		or (code == Constants.CLOSE_NORMAL and was_open)
	if terminal or not _reconnection["enabled"]:
		var error_code := Constants.PROTOCOL_ERROR if code == Constants.CLOSE_PROTOCOL_ERROR \
			else (Constants.CONNECTION_LOST if was_open else Constants.CONNECTION_FAILED)
		var text := reason if code == Constants.CLOSE_PROTOCOL_ERROR and reason != "" \
			else "connection closed (%d%s)" % [code, (": " + reason) if reason != "" else ""]
		_set_disconnected(error_code, text)
		if code == Constants.CLOSE_PROTOCOL_ERROR:
			error_received.emit(error_code, text)
		if was_open:
			disconnected.emit()
		return

	# Unexpected: keep every seat that has a token and try again.
	for room in _by_ref.values().duplicate():
		_by_ref.erase(room.room_ref)
		if room.status == Constants.RoomStatus.JOINING:
			# Seated but never joined (no snapshot): nothing to resume.
			room.mark_left(Constants.LEAVE_DISCONNECTED)
			continue
		room.suspend()
		_resuming.append(room)
	state = Constants.ConnectionState.RECONNECTING
	if was_open:
		disconnected.emit()
	_failed_attempt(Constants.CONNECTION_FAILED, "closed with %d" % code)


## Schedules the next attempt, or gives up after max_attempts.
func _failed_attempt(code: String, text: String) -> void:
	if state == Constants.ConnectionState.CONNECTING:
		_set_disconnected(code, text)
		return
	state = Constants.ConnectionState.RECONNECTING
	if _attempt >= int(_reconnection["max_attempts"]):
		var text2 := "gave up after %d reconnection attempts" % _attempt
		_set_disconnected(Constants.RECONNECTION_FAILED, text2)
		error_received.emit(Constants.RECONNECTION_FAILED, text2)
		return
	var wait: float = min(_reconnection["delay_ms"] * pow(_reconnection["factor"], _attempt),
		_reconnection["delay_max_ms"])
	_attempt += 1
	_retry_at = _now.call() + wait


## Ends everything: rooms left, pending joins and connects failed.
func _set_disconnected(code: String, text: String) -> void:
	state = Constants.ConnectionState.DISCONNECTED
	_attempt = 0
	_retry_at = INF
	_next_ping_at = INF
	for request_id in _pending.keys().duplicate():
		_settle(request_id, Result.failure(code, text))
	var rooms_left: Array = _by_ref.values().duplicate()
	rooms_left.append_array(_resuming)
	_by_ref.clear()
	_resuming.clear()
	for room in rooms_left:
		room.mark_left(Constants.LEAVE_DISCONNECTED)
	for waiter in _connecting.duplicate():
		waiter.resolve(Result.failure(code, text))
	_connecting.clear()


# --- ping ------------------------------------------------------------------


func _send_ping(now: float) -> void:
	var nonce := _next_nonce
	_next_nonce = 1 if nonce >= MAX_VARINT else nonce + 1
	# rtt: whole ms, sub-ms rounds up to 1, 0 = none yet (§5.1).
	var rtt := 0 if latency < 0 else int(min(MAX_VARINT, max(1, ceil(latency))))
	if not send_frame(Frames.CLIENT_PING, [nonce, rtt], PackedByteArray()).ok:
		return
	_ping_nonce = nonce
	_ping_sent_at = now


func _pong(nonce: int) -> void:
	if _ping_nonce == 0 or _ping_nonce != nonce:
		return
	_ping_nonce = 0
	latency = _now.call() - _ping_sent_at


# --- the room host ---------------------------------------------------------


func forget(room) -> void:
	if _by_ref.get(room.room_ref) == room:
		_by_ref.erase(room.room_ref)
	_resuming.erase(room)
	for request_id in _pending.keys().duplicate():
		if not _pending.has(request_id):
			continue
		var pending: Dictionary = _pending[request_id]
		if pending["room"] == room and not pending["resume"]:
			_settle(request_id, Result.failure(Constants.LEFT, "left before the join completed"))


## The replica no longer matches the server's (§11.10). Protocol v1 has no
## "send me a snapshot" frame, so re-sync through reconnection: drop the
## connection, resume every seat with its token, and each room gets a fresh
## snapshot.
func desync(room, code: String, text: String) -> void:
	log_error("state desync in room %s; re-syncing: %s (%s)" % [room.id, text, code])
	var socket = _socket
	if socket == null:
		return
	_lost(_generation, RESYNC_CLOSE, "desync")
	socket.close(RESYNC_CLOSE, "desync")


## Runs `action` at the start of the next poll.
func defer(action: Callable) -> void:
	_inbox.append(action)


func warn(text: String) -> void:
	_warn(text)


func log_error(text: String) -> void:
	_log.call("error", text)


func count_drop() -> void:
	dropped_frames += 1


# --- helpers ---------------------------------------------------------------


func _drop(reason: String) -> void:
	dropped_frames += 1
	_warn("dropped " + reason)


func _warn(text: String) -> void:
	_log.call("warn", text)


## Appends ?token=, keeping any query the URL has (§2.1).
static func _with_token(url: String, token) -> String:
	if token == null:
		return url
	var hash_at := url.find("#")
	var base := url if hash_at < 0 else url.substr(0, hash_at)
	var fragment := "" if hash_at < 0 else url.substr(hash_at)
	var separator := "&" if base.find("?") >= 0 else "?"
	return base + separator + "token=" + str(token).uri_encode() + fragment
