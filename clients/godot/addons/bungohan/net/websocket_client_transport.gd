extends "client_transport.gd"
## The default transport: Godot's WebSocketPeer, driven from the client's
## poll, so every callback arrives on the main thread.
##
## Sockets are duck-typed rather than derived from client_transport.gd's
## Socket: it documents the three methods, and any object with them works.

const Constants = preload("constants.gd")


class WebSocketSocket:
	extends RefCounted

	## OK, or why connect_to_url refused the URL outright.
	var connect_error := OK

	var _peer := WebSocketPeer.new()
	var _on_open: Callable
	var _on_message: Callable
	var _on_close: Callable
	var _opened := false
	var _finished := false

	func _init(url: String, protocols: PackedStringArray, on_open: Callable,
			on_message: Callable, on_close: Callable, buffer_size: int) -> void:
		_on_open = on_open
		_on_message = on_message
		_on_close = on_close
		_peer.supported_protocols = protocols
		_peer.inbound_buffer_size = buffer_size
		_peer.outbound_buffer_size = buffer_size
		_peer.max_queued_packets = 4096
		connect_error = _peer.connect_to_url(url)

	func send(data: PackedByteArray) -> bool:
		if not _opened or _finished:
			return false
		return _peer.send(data, WebSocketPeer.WRITE_MODE_BINARY) == OK

	func close(code: int, reason: String) -> void:
		if _finished:
			return
		# WebSocket only allows 1000 and 3000–4999 to be sent.
		var sendable := code if code == Constants.CLOSE_NORMAL or (code >= 3000 and code <= 4999) \
			else Constants.CLOSE_NORMAL
		_peer.close(sendable, reason.substr(0, 60))

	func poll() -> void:
		if _finished:
			return
		_peer.poll()
		if _peer.get_ready_state() == WebSocketPeer.STATE_OPEN and not _opened:
			_opened = true
			_on_open.call(_peer.get_selected_protocol())
		# Drained whatever the state is, not only while OPEN: a server that
		# closes on a protocol violation sends ERROR and then the close
		# (§8.2), and the frame is still buffered once the peer is CLOSING.
		while not _finished and _peer.get_available_packet_count() > 0:
			# A text message is passed on as its bytes; the frame parser
			# drops it as an unknown frame (§2.3).
			_on_message.call(_peer.get_packet())
		if _finished or _peer.get_ready_state() != WebSocketPeer.STATE_CLOSED:
			return
		_finished = true
		var code := _peer.get_close_code()
		# -1 is "no close frame": an abnormal closure (§8.3).
		_on_close.call(Constants.CLOSE_ABNORMAL if code < 0 else code, _peer.get_close_reason())


## Largest message accepted, in bytes; also the send buffer's size.
var buffer_size := 4 * 1024 * 1024


func open(url: String, protocols: PackedStringArray, on_open: Callable,
		on_message: Callable, on_close: Callable):
	var socket := WebSocketSocket.new(url, protocols, on_open, on_message, on_close, buffer_size)
	if socket.connect_error != OK:
		return Result.failure(Constants.CONNECTION_FAILED,
			"connect_to_url(%s) failed: %d" % [url, socket.connect_error])
	return Result.success(socket)


func get_transport_name() -> String:
	return "websocket"
