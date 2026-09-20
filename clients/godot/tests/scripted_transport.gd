extends "res://addons/bungohan/net/client_transport.gd"
## A transport with no socket: the test plays the server. It records what
## the client sends, answers what it chooses, and injects arbitrary frames,
## which is what the `behavior` vectors need (PROTOCOL.md §14: a connection
## holding one joined room at roomRef 1).
##
## Everything it reports is queued and delivered from the socket's poll(),
## i.e. from BungohanClient.poll(), like the real transport.

const Constants = preload("res://addons/bungohan/net/constants.gd")


class ScriptedSocket:
	extends RefCounted

	var pending: Array = []
	var closed := false
	## The close the client asked for: [code, reason], or empty.
	var closed_by: Array = []
	var sent: Array = []
	var respond: Callable

	var _on_open: Callable
	var _on_message: Callable
	var _on_close: Callable

	func _init(on_open: Callable, on_message: Callable, on_close: Callable, protocol: String) -> void:
		_on_open = on_open
		_on_message = on_message
		_on_close = on_close
		# Reported, never inline: a transport may only report through the
		# handlers after open() has returned.
		pending.append(func(): _on_open.call(protocol))

	func send(data: PackedByteArray) -> bool:
		if closed:
			return false
		sent.append(data)
		if respond.is_valid():
			for reply in respond.call(data):
				deliver(reply)
		return true

	func close(code: int, reason: String) -> void:
		if closed:
			return
		closed_by = [code, reason]
		finish(code, reason)

	func poll() -> void:
		while not pending.is_empty():
			var action: Callable = pending.pop_front()
			action.call()

	## Delivers one frame to the client (the next poll handles it).
	func deliver(frame: PackedByteArray) -> void:
		if closed:
			return
		pending.append(func(): _on_message.call(frame))

	func finish(code: int, reason: String) -> void:
		if closed:
			return
		closed = true
		pending.append(func(): _on_close.call(code, reason))


## Answers one frame the client sent, with an Array of frames.
var respond: Callable = Callable()
## The protocol the "server" selected.
var protocol := Constants.VERSION
var socket = null


func open(_url: String, _protocols: PackedStringArray, on_open: Callable,
		on_message: Callable, on_close: Callable):
	socket = ScriptedSocket.new(on_open, on_message, on_close, protocol)
	socket.respond = respond
	return Result.success(socket)


## Delivers one frame to the client.
func inject(frame: PackedByteArray) -> void:
	if socket != null:
		socket.deliver(frame)


## Closes the connection from the network side.
func drop(code: int, reason: String) -> void:
	if socket != null:
		socket.finish(code, reason)


func is_open() -> bool:
	return socket != null and not socket.closed


func get_transport_name() -> String:
	return "scripted"
