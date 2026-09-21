# Bungohan Godot addon (GDScript)

`addons/bungohan` implements [PROTOCOL.md](../../PROTOCOL.md) in GDScript for
Godot 4: frames, MessagePack, both state codecs, contract messages, the state
replica (`replica/state_stream.gd`), and the networking layer below —
connecting, the join handshake, typed and raw messages, leaving, kicks, ping
and reconnection (`net/`). Copy `addons/bungohan` into your project;
everything is reached with `preload`, nothing registers a global `class_name`.

Generate bindings for your own contract and state:

```sh
bunx @bungohan/codegen --contract ./shared/contract.ts --state ./shared/state.ts \
  --lang gdscript --out ./godot/net
```

## Everything happens in `poll()`

The client drives the socket, dispatches frames, emits every signal and
resumes every `await` inside `poll()`, which you call once a frame from
`_process`. Nothing ever runs off the main thread, so a signal handler may
touch nodes freely.

```gdscript
extends Node

const Bindings = preload("res://net/bindings.gd")
const BungohanClient = preload("res://addons/bungohan/net/bungohan_client.gd")

var _client
var _room


func _ready() -> void:
	_client = BungohanClient.new({"url": "ws://127.0.0.1:6060"})

	var settings := {
		"contract_hash": Bindings.GameContract.HASH,   # never a message id
		"server_messages": Bindings.GameContract.SERVER,
		"registry": Bindings.create_registry(),
		"state": Bindings.GameState,
	}

	var connected = await _client.connect_to_server()
	if not connected.ok:
		return
	var joined = await _client.join_or_create("game", null, settings)
	if not joined.ok:
		push_error("%s: %s" % [joined.code, joined.message])
		return
	_room = joined.value

	# Typed, by name: the id comes from the handshake.
	_room.on_message("welcome", func(payload):
		var welcome = Bindings.WelcomeMessage.from_payload(payload)
		print(welcome.session_id))

	# A snapshot always brings a NEW replica, so attach here, not once.
	_room.state_replaced.connect(func(state):
		state.players.added.connect(_spawn))

	_room.left.connect(func(code): print("left: ", code))


func _process(_delta: float) -> void:
	if _client != null:
		_client.poll()                       # the one thing you must call
	if _room != null:
		var input = Bindings.InputMessage.new()
		input.up = Input.is_action_pressed("ui_up")
		_room.send(input)


func _exit_tree() -> void:
	if _client != null:
		_client.disconnect_from_server()
```

**Join and create options.** If the contract declares typed options
(PROTOCOL.md §6.2.1), the generated contract script builds them with typed
parameters, and the join takes the result:

```gdscript
var lobby = Bindings.LobbyMessage.new()   # create options
lobby.map = "ice"
var seat = Bindings.SeatMessage.new()     # join options
seat.name = "ann"
await _client.join_or_create("game", Bindings.GameContract.create_options(lobby, seat), settings)
await _client.join_by_id(room_id, Bindings.GameContract.join_options(seat), settings)
```

They are encoded as `schema` messages whatever the room's codec, and the
server decodes them against the same declarations before the room sees
them; options that don't fit fail the join with `INVALID_OPTIONS`. Without
declared options, `options` is any MessagePack value.

`await` works because `_process` keeps polling: the client resolves a join
from inside `poll()`, which resumes whatever is awaiting it. A script that
does not run `_process` (a `SceneTree` tool script, a test) must poll in its
own loop instead.

Nothing crashes on bad input: every fallible call returns a
`protocol/result.gd` with `ok`, `code` and `message`. Codes are the
`JOIN_ERROR` codes of PROTOCOL.md §8.1 plus the local ones in
`net/constants.gd` (`CONNECTION_LOST`, `CODEC_MISMATCH`, `UNKNOWN_MESSAGE`,
`DESYNC`, …). Reconnection is automatic: an unexpected close resumes every
seat with its stored token, backing off (1 s, 2 s, 4 s, … capped at 30 s), and
each room gets a fresh snapshot, so keep the room, never `room.state`.

To reach the server some other way — a relay, a replay, injected frames —
implement `net/client_transport.gd` (open, and a socket with `send`, `close`
and `poll`) and pass it as `"transport"`. It must offer the `bungohan.v1`
subprotocol (PROTOCOL.md §2.1).

## Applying state frames without the client

The replica works on its own, for a custom transport or a recorded stream:

```gdscript
const SchemaCodec = preload("res://addons/bungohan/protocol/schema_codec.gd")
const StateStream = preload("res://addons/bungohan/replica/state_stream.gd")

var stream := StateStream.new(SchemaCodec.new(), Bindings.create_registry(), Bindings.GameState)

func _ready() -> void:
	stream.replaced.connect(func(state): state.players.added.connect(_spawn))
```

## Tests

This directory is a minimal Godot project.

```sh
bun run test:godot                                     # starts the interop server first
cd clients/godot
godot-mono --headless --script tests/run_vectors.gd    # conformance vectors
godot-mono --headless --script tests/run_all.gd        # + replica + bindings + interop
godot-mono --headless --script tests/run_interop.gd    # end-to-end only
```

The server-side `behavior` vectors and the interop suite need a live server
(`BUNGOHAN_INTEROP_URL`), which `bun run test:godot` starts; without it they
are skipped and everything else still runs.

`example/shooter` holds the example app's generated bindings
(`bun run codegen:example`), and `tests/interop` the test server's
(`bun run codegen:interop`).
