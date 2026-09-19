using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Bungohan.Codegen.Golden;
using Bungohan.Example.Shooter;
using Bungohan.Protocol;

namespace Bungohan.Protocol.Tests
{
    /// <summary>
    /// The generated bindings at work: the recorded shooter stream
    /// (clients/fixtures) applied through the generated classes must end in
    /// the state the TypeScript client replica had, and generated messages
    /// must round-trip through both codecs.
    /// </summary>
    public static class BindingsTests
    {
        private static readonly Dictionary<string, IStateCodec> s_codecs = new Dictionary<string, IStateCodec>
        {
            ["schema"] = new SchemaCodec(),
            ["messagepack"] = new MessagePackCodec(),
        };

        public static Suite Run(string root)
        {
            var suite = new Suite("generated bindings");
            foreach (string codec in new[] { "schema", "messagepack" })
            {
                string path = Path.Combine(root, "clients", "fixtures", "shooter-stream." + codec + ".json");
                suite.Run("shooter-stream." + codec + ".json through the generated classes", () => ShooterStream(path));
            }
            foreach (var codec in s_codecs)
            {
                suite.Run("golden EverythingMessage round-trips under " + codec.Key, () => RoundTrip(codec.Value));
            }
            suite.Run("the generated contract carries the hash, and no ids", () =>
            {
                Suite.Equal(ShooterContract.Hash.Length, 8.0, "hash length");
                Suite.That(ShooterContract.ServerMessages.ContainsKey("gameEnded"), "messages by name");
            });
            return suite;
        }

        private static void ShooterStream(string path)
        {
            MsgMap recording = Values.LoadFile(path);
            IStateCodec codec = s_codecs[(string)recording["codec"]!];
            Suite.Equal(ShooterContract.Hash, recording["contractHash"], "contract hash");

            var stream = new StateStream<GameState>(codec, Bungohan.Example.Shooter.Schemas.CreateRegistry());
            var events = new Dictionary<string, int>();
            void Count(string key) => events[key] = events.TryGetValue(key, out int n) ? n + 1 : 1;
            var unknown = new List<string>();
            stream.UnknownClass += unknown.Add;
            int snapshots = 0;
            string lastStatus = "";

            foreach (object? item in (List<object?>)recording["frames"]!)
            {
                var frame = (MsgMap)item!;
                byte[] body = Values.FromHex((string)frame["hex"]!);
                switch ((string)frame["kind"]!)
                {
                    case "message":
                    {
                        Result<IContractMessage> decoded = ShooterContract.DecodeServer(codec, (string)frame["name"]!, body);
                        Suite.That(decoded.IsOk, "message decode failed: " + decoded.Error);
                        Suite.Equal(frame["payload"], decoded.Value.ToPayload(), (string)frame["name"]!);
                        if (decoded.Value is GameEndedMessage ended)
                        {
                            Suite.That(ended.Results.Count == 2 && ended.Results[0].Rank == 1, "typed nested results");
                        }
                        break;
                    }
                    case "snapshot":
                    {
                        Result applied = stream.ApplySnapshot(body);
                        Suite.That(applied.IsOk, "snapshot failed: " + applied.Error);
                        if (snapshots++ > 0) break;
                        // Listeners attached once the join's snapshot is applied,
                        // as the recording's TypeScript client did.
                        GameState state = stream.State!;
                        state.Enemies.Added += (_, _) => Count("enemiesAdded");
                        state.Enemies.Removed += (_, _) => Count("enemiesRemoved");
                        state.Bullets.Added += (_, _) => Count("bulletsAdded");
                        state.Bullets.Removed += (_, _) => Count("bulletsRemoved");
                        state.Loot.Added += (_, _) => Count("lootAdded");
                        state.Loot.Removed += (_, _) => Count("lootRemoved");
                        state.GameStatusChanged += (value, _) =>
                        {
                            Count("statusChanges");
                            lastStatus = value;
                        };
                        state.Players.Added += (player, _) =>
                        {
                            Count("playersAdded");
                            player.ScoreChanged += (_, _) => Count("scoreChanges");
                        };
                        break;
                    }
                    default:
                    {
                        Result applied = stream.ApplyPatch(body);
                        Suite.That(applied.IsOk, "patch failed: " + applied.Error);
                        break;
                    }
                }
            }
            Suite.Equal(1.0, (double)snapshots, "snapshots");
            Suite.That(unknown.Count == 0, "unknown classes: " + string.Join(", ", unknown));
            foreach (var expected in (MsgMap)recording["events"]!)
            {
                events.TryGetValue(expected.Key, out int actual);
                Suite.Equal(expected.Value, (double)actual, "event count " + expected.Key);
            }
            GameState final = stream.State!;
            if (events.ContainsKey("statusChanges")) Suite.Equal(final.GameStatus, lastStatus, "last status event");
            Suite.Equal(recording["final"], Dump(final), "final state");
        }

        // --- the canonical dump (record-stream.ts), built from typed members --

        private static MsgMap Obj(string cls, params (string, object?)[] fields)
        {
            var map = new MsgMap { ["$class"] = cls };
            foreach (var (name, value) in fields) map[name] = value;
            return map;
        }

        private static List<object?> Sorted<TKey, TValue>(MapSchema<TKey, TValue> map, Func<TValue, object?> dump)
            where TKey : notnull =>
            map.OrderBy(entry => entry.Key, Comparer<TKey>.Create((a, b) =>
                    a is string x && b is string y ? string.CompareOrdinal(x, y) : Comparer<TKey>.Default.Compare(a, b)))
                .Select(entry => (object?)new List<object?> { entry.Key, dump(entry.Value) })
                .ToList();

        private static MsgMap Dump(GameState s) => Obj("GameState",
            ("players", Sorted(s.Players, p => Obj("Player",
                ("name", p.Name), ("color", p.Color), ("x", p.X), ("y", p.Y), ("rotation", p.Rotation),
                ("score", p.Score), ("health", p.Health), ("isDead", p.IsDead), ("isReady", p.IsReady)))),
            ("enemies", Sorted(s.Enemies, e => Obj("Enemy", ("x", e.X), ("y", e.Y), ("health", e.Health)))),
            ("bullets", Sorted(s.Bullets, b => Obj("Bullet", ("ownerId", b.OwnerId), ("x", b.X), ("y", b.Y)))),
            ("loot", Sorted(s.Loot, l => Obj("Loot", ("x", l.X), ("y", l.Y), ("value", l.Value)))),
            ("roomCode", s.RoomCode), ("roomName", s.RoomName), ("hostId", s.HostId), ("gameTime", s.GameTime),
            ("gameStatus", s.GameStatus), ("maxPlayers", s.MaxPlayers), ("canStart", s.CanStart));

        // --- generated messages ---------------------------------------------

        private static void RoundTrip(IStateCodec codec)
        {
            var message = new EverythingMessage
            {
                I8 = -5, I16 = 300, I32 = -70000, U8 = 200, U16 = 60000, U32 = 4000000000,
                F32 = 0.1f, F64 = Math.PI, Fx = -1.2345, Text = "héllo", Flag = true,
                Color = EverythingMessage.ColorValue.Dark_blue, Level = 5,
                List = new List<short> { 1, -2 }, Names = new Dictionary<string, string> { ["a"] = "b" },
                Maybe = 2.5, MaybeFlag = false, MaybeColor = EverythingMessage.MaybeColorValue.South,
                Holes = new List<byte?> { 1, null }, Sparse = new Dictionary<string, bool?> { ["x"] = null, ["y"] = true },
                Point = new PointMessage { X = 1.25, Y = -2 },
                Path = new List<PointMessage> { new PointMessage { X = 3 } },
                Grid = new List<List<double>> { new List<double> { 1.5 }, new List<double>() },
                Tagged = new Dictionary<string, List<PointMessage>> { ["t"] = new List<PointMessage> { new PointMessage { Y = 4 } } },
                Palette = new List<EverythingMessage.PaletteValue> { EverythingMessage.PaletteValue.Blue },
                Definition_ = "d", Encode_ = true,
            };
            Result<byte[]> encoded = message.Encode(codec);
            Suite.That(encoded.IsOk, "encode failed: " + encoded.Error);
            Result<EverythingMessage> decoded = EverythingMessage.Decode(codec, encoded.Value);
            Suite.That(decoded.IsOk, "decode failed: " + decoded.Error);
            EverythingMessage back = decoded.Value;
            Suite.Equal(-1.235, back.Fx, "fixed:3 quantized (round half away from zero)");
            Suite.Equal((double)0.1f, (double)back.F32, "float32");
            Suite.That(back.Color == EverythingMessage.ColorValue.Dark_blue && back.MaybeColor == EverythingMessage.MaybeColorValue.South, "enums");
            Suite.That(back.MaybePoint == null && back.MaybeFlag == false, "optionals");
            Suite.That(back.Holes[1] == null && back.Sparse["x"] == null && back.Sparse["y"] == true, "absent inside collections");
            Suite.Equal(message.ToPayload().Count, (double)back.ToPayload().Count, "payload fields");
            Result<byte[]> again = back.Encode(codec);
            Suite.Equal(Values.ToHex(encoded.Value), Values.ToHex(again.Value), "re-encoding is identical");
        }
    }
}
