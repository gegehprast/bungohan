# Bungohan Godot addon (GDScript)

`addons/bungohan` implements [PROTOCOL.md](../../PROTOCOL.md) in GDScript for
Godot 4: frames, MessagePack, both state codecs, contract messages and the
state replica (`replica/state_stream.gd`). Networking (WebSocket, the join
handshake, reconnection) is not in it yet. Copy `addons/bungohan` into your
project; everything is reached with `preload`, nothing registers a global
`class_name`.

Generate bindings for your own contract and state:

```sh
bunx @bungohan/codegen --contract ./shared/contract.ts --state ./shared/state.ts \
  --lang gdscript --out ./godot/net
```

```gdscript
const Bindings = preload("res://net/bindings.gd")
const SchemaCodec = preload("res://addons/bungohan/protocol/schema_codec.gd")
const StateStream = preload("res://addons/bungohan/replica/state_stream.gd")

var stream := StateStream.new(SchemaCodec.new(), Bindings.create_registry(), Bindings.GameState)

func _ready() -> void:
	stream.replaced.connect(func(state): state.players.added.connect(_spawn))
```

Tests (this directory is a minimal Godot project):

```sh
cd clients/godot
godot-mono --headless --script tests/run_vectors.gd   # every vector except `behavior`
godot-mono --headless --script tests/run_all.gd       # + replica + generated bindings
```

`example/shooter` holds the example app's generated bindings
(`bun run codegen:example`).
