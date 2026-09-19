# Bungohan C# protocol core

`Bungohan.Protocol` implements [PROTOCOL.md](../../PROTOCOL.md) for Unity and
Godot .NET: netstandard2.1, C# 9, no NuGet packages, no reflection. It covers
frames, MessagePack, both state codecs (`SchemaCodec`, `MessagePackCodec`),
contract messages and the state replica (`StateStream<TRoot>`). Networking
(WebSocket, the join handshake, reconnection) is not in it yet.

- `Bungohan.Protocol/`: the library. Copy it (or its DLL) into a Unity or
  Godot project.
- `Bungohan.Bindings/`: generated bindings, compiled under the same
  constraints. `Shooter/` is the example app's (`bun run codegen:example`).
- `Bungohan.Protocol.Tests/`: every conformance vector except `behavior`,
  replica tests, and the recorded shooter stream through the generated
  classes: `dotnet run --project clients/csharp/Bungohan.Protocol.Tests`.

Generate bindings for your own contract and state:

```sh
bunx @bungohan/codegen --contract ./shared/contract.ts --state ./shared/state.ts \
  --lang csharp --namespace MyGame.Net --out ./unity/Assets/Bungohan
```

Apply state frames through the generated classes:

```csharp
var stream = new StateStream<GameState>(new SchemaCodec(), Schemas.CreateRegistry());
stream.Replaced += state => state.Players.Added += (player, id) => Spawn(id, player);
stream.ApplySnapshot(snapshotBody);   // STATE_SNAPSHOT body
stream.ApplyPatch(patchBody);         // STATE_PATCH body; Result, never throws
```
