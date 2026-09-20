# Bungohan C# client

`Bungohan.Protocol` implements [PROTOCOL.md](../../PROTOCOL.md) for Unity and
Godot .NET: netstandard2.1, C# 9, no NuGet packages, no reflection. It covers
frames, MessagePack, both state codecs (`SchemaCodec`, `MessagePackCodec`),
contract messages, the state replica (`StateStream<TRoot>`), and the
networking layer below — connecting, the join handshake, typed and raw
messages, leaving, kicks, ping and reconnection.

- `Bungohan.Protocol/`: the library. Copy it (or its DLL) into a Unity or
  Godot project. `Net/` holds the client; the rest is the protocol core.
- `Bungohan.Bindings/`: generated bindings, compiled under the same
  constraints. `Shooter/` is the example app's (`bun run codegen:example`)
  and `Interop/` the test server's (`bun run codegen:interop`).
- `Bungohan.Protocol.Tests/`: every conformance vector, replica tests, the
  recorded shooter stream through the generated classes, and end-to-end
  tests against a real server: `bun run test:csharp` (which starts that
  server first). `dotnet run --project clients/csharp/Bungohan.Protocol.Tests`
  runs everything that needs no server.

Generate bindings for your own contract and state:

```sh
bunx @bungohan/codegen --contract ./shared/contract.ts --state ./shared/state.ts \
  --lang csharp --namespace MyGame.Net --out ./unity/Assets/Bungohan
```

## Everything happens in `Poll()`

`BungohanClient` never calls your code from a background thread. The
transport may receive on one, but the client only queues what it reports:
frames are parsed, events raised and tasks completed inside `Poll()`, on the
thread that calls it. Call it once a frame, and `await` works as usual,
because a task completed inside `Poll()` resumes its continuation there.

```csharp
using Bungohan.Protocol;
using MyGame.Net;            // generated bindings

public sealed class Net : MonoBehaviour      // or Godot: Node
{
    private BungohanClient _client;
    private BungohanRoom _room;

    private async void Start()
    {
        _client = new BungohanClient(new ClientOptions { Url = "ws://localhost:6060" });

        var settings = new JoinSettings
        {
            ContractHash = GameContract.Hash,          // never a message id
            ServerMessages = GameContract.ServerMessages,
            Registry = Schemas.CreateRegistry(),
            CreateState = () => new GameState(),
        };

        Result connected = await _client.ConnectAsync();
        if (!connected.IsOk) return;

        Result<BungohanRoom> joined = await _client.JoinOrCreateAsync("game", null, settings);
        if (!joined.IsOk) return;
        _room = joined.Value;

        // Typed, by name: the id comes from the handshake.
        _room.OnMessage("welcome", WelcomeMessage.FromPayload, m => Debug.Log(m.SessionId));

        // A snapshot always brings a NEW replica, so attach here, not once.
        _room.StateReplaced += state =>
        {
            var game = (GameState)state;
            game.Players.Added += (player, id) => Spawn(id, player);
        };

        _room.Left += code => Debug.Log($"left: {code}");
    }

    private void Update()
    {
        _client?.Poll();                      // the one thing you must call
        _room?.Send(new InputMessage { Up = Input.GetKey(KeyCode.W) });
    }

    private void OnDestroy() => _client?.Disconnect();
}
```

Nothing throws on bad input: every fallible call returns `Result` /
`Result<T>` with a `Code` from `ClientErrorCodes` (the `JOIN_ERROR` codes of
PROTOCOL.md §8.1, plus `CONNECTION_LOST`, `CODEC_MISMATCH`,
`UNKNOWN_MESSAGE`, `DESYNC`, …). Reconnection is automatic: an unexpected
close resumes every seat with its stored token, backing off (1 s, 2 s, 4 s, …
capped at 30 s), and each room gets a fresh snapshot, so keep `room`, never
`room.State`.

## Using it from Unity

The library targets **netstandard2.1 with C# 9, no NuGet packages and no
reflection**, so it drops into Unity as source or as a DLL. It is written to
those constraints deliberately — no `record`, no `init`, no `System.Text.Json`
— and the build treats warnings as errors.

> This has not been tested in Unity: no Unity install was available. What is
> tested is the constraint set (it compiles for netstandard2.1 with warnings
> as errors) and the runtime behaviour on .NET 10 and against a real server.

- Copy `Bungohan.Protocol/` (and your generated bindings) under `Assets/`, or
  build the DLL and drop it in `Assets/Plugins/`.
- Call `Poll()` from `Update()`. Every callback then arrives on Unity's main
  thread, so you may touch `GameObject`s from them.
- **WebGL needs its own transport.** `System.Net.WebSockets.ClientWebSocket`
  does not work in the browser player, so implement `IClientTransport` over
  the JS `WebSocket` (a `.jslib` plugin) and pass it as
  `ClientOptions.Transport`. The interface is three methods on a socket —
  `Send`, `Close`, and reporting through `IClientSocketHandlers` — and it must
  offer the `bungohan.v1` subprotocol (PROTOCOL.md §2.1). A transport may
  report from any thread; the client queues everything.
- `IL2CPP` is fine: there is no reflection and no dynamic code.

## Applying state frames without the client

The replica works on its own, for a custom transport or a recorded stream:

```csharp
var stream = new StateStream<GameState>(new SchemaCodec(), Schemas.CreateRegistry());
stream.Replaced += state => state.Players.Added += (player, id) => Spawn(id, player);
stream.ApplySnapshot(snapshotBody);   // STATE_SNAPSHOT body
stream.ApplyPatch(patchBody);         // STATE_PATCH body; Result, never throws
```
