extends RefCounted
## The client side of the transport seam. A client needs only this much
## from a connection: open it offering protocol versions, send and receive
## whole binary messages (one message is one frame, PROTOCOL.md §3), and
## learn when it closes.
##
## The default is websocket_client_transport.gd (WebSocketPeer). Replace it
## to drive a client from injected frames (the conformance runners do), or
## to reach a server some other way.
##
## Every callback is invoked from `poll()`, i.e. from whatever called
## `BungohanClient.poll()`, so nothing of yours runs off the main thread.

const Result = preload("../protocol/result.gd")


## A connection. Subclasses override all three.
class Socket:
	extends RefCounted

	## Sends one frame; false if the connection isn't open.
	func send(_data: PackedByteArray) -> bool:
		return false

	## Closes the connection. `on_close` still fires.
	func close(_code: int, _reason: String) -> void:
		pass

	## Drives the connection and invokes the handlers. Called every poll.
	func poll() -> void:
		pass


## Starts opening a connection to `url`, offering `protocols` as WebSocket
## subprotocols, most preferred first. The Result holds a Socket. It fails
## only when a connection can't even be attempted; a server that can't be
## reached is reported later, through `on_close`.
##
## `on_open(protocol: String)`, `on_message(data: PackedByteArray)` and
## `on_close(code: int, reason: String)` are Callables. `on_close` fires
## exactly once and never before `open()` has returned.
func open(_url: String, _protocols: PackedStringArray, _on_open: Callable,
		_on_message: Callable, _on_close: Callable):
	return Result.failure(Result.DECODE_FAILED, "this transport cannot open connections")


## A short name, for diagnostics.
func get_transport_name() -> String:
	return "none"
