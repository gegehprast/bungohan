using System;
using System.Collections.Generic;
using System.Linq;
using Bungohan.Interop;
using Bungohan.Protocol;

namespace Bungohan.Protocol.Tests
{
    /// <summary>
    /// End-to-end against the real server (`packages/testing/src/interop`),
    /// over a real WebSocket, through the generated bindings: joining,
    /// typed messages both ways, a replica compared field by field with
    /// the server's own view of its state, raw messages, a kick, a
    /// reconnection after an unexpected drop, and the two ways a join is
    /// refused up front (contract hash, state codec).
    ///
    /// Skipped without <c>BUNGOHAN_INTEROP_URL</c>; <c>bun run
    /// test:csharp</c> starts the server and sets it.
    /// </summary>
    public static class InteropTests
    {
        public static Suite Run()
        {
            var suite = new Suite("interop (real server)");
            string? url = Environment.GetEnvironmentVariable("BUNGOHAN_INTEROP_URL");
            if (string.IsNullOrEmpty(url))
            {
                suite.Skip();
                return suite;
            }
            suite.Run("joins, exchanges typed messages and mirrors the server's state", () => StateCase(url));
            suite.Run("raw messages round-trip", () => RawCase(url));
            suite.Run("a kick ends the room with LEAVE 4000", () => KickCase(url));
            suite.Run("reconnects after an unexpected drop and gets a fresh snapshot", () => ReconnectCase(url));
            suite.Run("a wrong contract hash fails the join with CONTRACT_MISMATCH", () => ContractCase(url));
            suite.Run("an unknown state codec fails the join with CODEC_MISMATCH", () => CodecCase(url));
            suite.Run("PING measures a round trip", () => PingCase(url));
            suite.Run("a room without reconnection hands out no token", () => NoTokenCase(url));
            return suite;
        }

        /// <summary>The generated bindings, as a join's runtime inputs.</summary>
        private static JoinSettings Settings(string? hash = null) => new JoinSettings
        {
            ContractHash = hash ?? InteropContract.Hash,
            ServerMessages = InteropContract.ServerMessages,
            Registry = Schemas.CreateRegistry(),
            CreateState = () => new Interop_State(),
        };

        private static BungohanClient NewClient(string url, ClientOptions? options = null)
        {
            ClientOptions settings = options ?? new ClientOptions();
            settings.Url = url;
            settings.PingIntervalMs = 0;
            return new BungohanClient(settings);
        }

        private static void StateCase(string url)
        {
            BungohanClient client = NewClient(url);
            try
            {
                Result<BungohanRoom> joined = Pump.Wait(client, client.JoinOrCreateAsync("interop", null, Settings()), "the join");
                Suite.That(joined.IsOk, "join failed: " + joined.Error);
                BungohanRoom room = joined.Value;

                // A message sent from the server's onJoin, i.e. before the
                // caller held the room: it must still reach this handler.
                WelcomeMessage? welcome = null;
                room.OnMessage("welcome", WelcomeMessage.FromPayload, m => welcome = m);
                DumpMessage? dump = null;
                room.OnMessage("dump", DumpMessage.FromPayload, m => dump = m);
                EchoedMessage? echoed = null;
                room.OnMessage("echoed", EchoedMessage.FromPayload, m => echoed = m);
                Pump.Until(client, () => welcome != null, "the welcome message");
                Suite.Equal(room.SessionId, welcome!.SessionId, "welcome.sessionId");

                var state = room.StateAs<Interop_State>();
                Suite.That(state != null, "the replica should be an Interop_State");
                Suite.Equal("interop", state!.Label, "state.label");
                Suite.That(state.Players.ContainsKey(room.SessionId), "the replica should hold our player");

                // Typed messages, whose effect the server puts back in the state.
                room.Send(new SetNameMessage { Name = "ada" }).ThrowIfFailed("setName");
                room.Send(new MoveMessage { Dx = 1.25, Dy = -3.5 }).ThrowIfFailed("move");
                room.Send(new MoveMessage { Dx = 0.5, Dy = 0.25 }).ThrowIfFailed("move");
                room.Send(new AddTagMessage { Tag = "red" }).ThrowIfFailed("addTag");
                room.Send(new AddTagMessage { Tag = "blue" }).ThrowIfFailed("addTag");
                room.Send(new BumpMessage { By = 7, Alive = false, Note = "hi" }).ThrowIfFailed("bump");
                Pump.Until(client, () => state.Turn == 2 && state.Players[room.SessionId].Score == 7,
                    "the state to catch up");

                Interop_Player player = state.Players[room.SessionId];
                Suite.Equal("ada", player.Name, "player.name");
                Suite.Equal(1.75d, player.X, "player.x");
                Suite.Equal(-3.25d, player.Y, "player.y");
                Suite.Equal(false, player.Alive, "player.alive");
                Suite.Equal(new List<object?> { "blue", "red" },
                    player.Tags.OrderBy(t => t, StringComparer.Ordinal).Cast<object?>().ToList(), "player.tags");
                Suite.Equal(new List<object?> { "name:ada", "note:hi" },
                    state.Log.Cast<object?>().ToList(), "state.log");

                // An optional the sender left out must decode as absent.
                room.Send(new EchoMessage { Text = "hello", Count = 0 }).ThrowIfFailed("echo");
                Pump.Until(client, () => echoed != null, "the echo");
                Suite.Equal("hello", echoed!.Text, "echoed.text");
                Suite.That(echoed.Note == null, "echoed.note should be absent");

                // The server's own view of its state, compared to the replica.
                room.Send(new RequestDumpMessage()).ThrowIfFailed("requestDump");
                Pump.Until(client, () => dump != null, "the dump");
                Compare(dump!, state);
            }
            finally
            {
                client.Disconnect();
                client.Poll();
            }
        }

        /// <summary>Every field of the server's dump against the replica.</summary>
        private static void Compare(DumpMessage dump, Interop_State state)
        {
            Suite.Equal((double)dump.Turn, (double)state.Turn, "dump.turn vs replica");
            Suite.Equal(dump.Label, state.Label, "dump.label vs replica");
            Suite.Equal(dump.Log.Cast<object?>().ToList(), state.Log.Cast<object?>().ToList(),
                "dump.log vs replica");
            Suite.Equal((double)dump.Players.Count, (double)state.Players.Count,
                "dump player count vs replica");
            foreach (PlayerDumpMessage entry in dump.Players)
            {
                Suite.That(state.Players.ContainsKey(entry.Id), "the replica lacks player " + entry.Id);
                Interop_Player player = state.Players[entry.Id];
                Suite.Equal(entry.Name, player.Name, entry.Id + ".name");
                Suite.Equal(entry.X, player.X, entry.Id + ".x");
                Suite.Equal(entry.Y, player.Y, entry.Id + ".y");
                Suite.Equal((double)entry.Score, (double)player.Score, entry.Id + ".score");
                Suite.Equal(entry.Alive, player.Alive, entry.Id + ".alive");
                Suite.Equal(entry.Tags.OrderBy(t => t, StringComparer.Ordinal).Cast<object?>().ToList(),
                    player.Tags.OrderBy(t => t, StringComparer.Ordinal).Cast<object?>().ToList(),
                    entry.Id + ".tags");
            }
        }

        private static void RawCase(string url)
        {
            BungohanClient client = NewClient(url);
            try
            {
                BungohanRoom room = Join(client, url);
                object? echoed = null;
                string type = "";
                room.RawMessage += (name, payload) =>
                {
                    type = name;
                    echoed = payload;
                };
                room.SendRaw("ping", new List<object?> { 1L, "two", true }).ThrowIfFailed("sendRaw");
                Pump.Until(client, () => echoed != null, "the raw reply");
                Suite.Equal("pong", type, "raw message type");
                Suite.Equal(new List<object?> { 1d, "two", true }, echoed, "raw payload");
            }
            finally
            {
                client.Disconnect();
                client.Poll();
            }
        }

        private static void KickCase(string url)
        {
            BungohanClient client = NewClient(url);
            try
            {
                BungohanRoom room = Join(client, url);
                int? code = null;
                room.Left += c => code = c;
                room.Send(new KickMeMessage { Reason = "bye" }).ThrowIfFailed("kickMe");
                Pump.Until(client, () => code != null, "the kick");
                Suite.Equal((double)LeaveCode.Kicked, (double)code!.Value, "leave code");
                Suite.That(room.Status == RoomStatus.Left, "the room should be left");
                // The connection is untouched by a kick (§7.1).
                Suite.That(client.State == ConnectionState.Connected, "the connection should stay open");
            }
            finally
            {
                client.Disconnect();
                client.Poll();
            }
        }

        private static void ReconnectCase(string url)
        {
            BungohanClient client = NewClient(url, new ClientOptions
            {
                Reconnection = new ReconnectionOptions { Enabled = true, MaxAttempts = 5, DelayMs = 20, DelayMaxMs = 50 },
            });
            try
            {
                BungohanRoom room = Join(client, url);
                var state = room.StateAs<Interop_State>()!;
                room.Send(new SetNameMessage { Name = "grace" }).ThrowIfFailed("setName");
                room.Send(new MoveMessage { Dx = 2.5, Dy = 2.5 }).ThrowIfFailed("move");
                Pump.Until(client, () => state.Players[room.SessionId].Name == "grace", "the name");

                string sessionId = room.SessionId;
                string? token = room.ReconnectionToken;
                Suite.That(token != null, "the room should allow reconnection");
                int snapshots = room.Snapshots;
                int replaced = 0;
                room.StateReplaced += _ => replaced++;

                // The server drops the whole connection, without a LEAVE.
                room.Send(new DropMeMessage()).ThrowIfFailed("dropMe");
                Pump.Until(client, () => client.State == ConnectionState.Reconnecting ||
                    client.State == ConnectionState.Connected && room.Snapshots > snapshots,
                    "the drop");
                Pump.Until(client, () => room.Status == RoomStatus.Joined && room.Snapshots > snapshots,
                    "the seat to resume with a fresh snapshot");

                Suite.Equal(sessionId, room.SessionId, "the sessionId survives a reconnection");
                Suite.That(room.ReconnectionToken != token, "the token is replaced on every rejoin");
                Suite.That(replaced > 0, "the snapshot should have replaced the replica");
                // A new replica object, restored from the snapshot alone.
                var restored = room.StateAs<Interop_State>()!;
                Suite.That(!ReferenceEquals(restored, state), "the replica should be a new object");
                Suite.Equal("grace", restored.Players[sessionId].Name, "the restored name");
                Suite.Equal(2.5d, restored.Players[sessionId].X, "the restored x");
            }
            finally
            {
                client.Disconnect();
                client.Poll();
            }
        }

        private static void ContractCase(string url)
        {
            BungohanClient client = NewClient(url);
            try
            {
                Result<BungohanRoom> joined = Pump.Wait(client,
                    client.JoinOrCreateAsync("interop", null, Settings("deadbeef")), "the join");
                Suite.That(!joined.IsOk, "the join should have failed");
                Suite.Equal(ClientErrorCodes.ContractMismatch, joined.Error!.Code, "error code");
                Suite.That(client.State == ConnectionState.Connected, "the connection should stay open");
            }
            finally
            {
                client.Disconnect();
                client.Poll();
            }
        }

        private static void CodecCase(string url)
        {
            // The server's rooms use `schema`; a client with only the other
            // codec must leave the seat and fail locally (§6.4).
            BungohanClient client = NewClient(url, new ClientOptions
            {
                StateCodecs = new IStateCodec[] { new MessagePackCodec() },
            });
            try
            {
                Result<BungohanRoom> joined = Pump.Wait(client,
                    client.JoinOrCreateAsync("interop", null, Settings()), "the join");
                Suite.That(!joined.IsOk, "the join should have failed");
                Suite.Equal(ClientErrorCodes.CodecMismatch, joined.Error!.Code, "error code");
            }
            finally
            {
                client.Disconnect();
                client.Poll();
            }
        }

        private static void PingCase(string url)
        {
            var options = new ClientOptions { Url = url, PingIntervalMs = 10 };
            var client = new BungohanClient(options);
            try
            {
                Result<BungohanRoom> joined = Pump.Wait(client,
                    client.JoinOrCreateAsync("interop", null, Settings()), "the join");
                Suite.That(joined.IsOk, "join failed: " + joined.Error);
                Pump.Until(client, () => client.Latency.HasValue, "a round trip measurement");
                Suite.That(client.Latency!.Value >= 0, "latency should be a duration");
            }
            finally
            {
                client.Disconnect();
                client.Poll();
            }
        }

        /// <summary>A room with <c>allowReconnection: false</c> sends a null token (§6.4).</summary>
        private static void NoTokenCase(string url)
        {
            BungohanClient client = NewClient(url);
            try
            {
                Result<BungohanRoom> joined = Pump.Wait(client,
                    client.JoinOrCreateAsync("solo", null, Settings()), "the join");
                Suite.That(joined.IsOk, "join failed: " + joined.Error);
                Suite.That(joined.Value.ReconnectionToken == null,
                    "expected no token, got " + joined.Value.ReconnectionToken);
            }
            finally
            {
                client.Disconnect();
                client.Poll();
            }
        }

        private static BungohanRoom Join(BungohanClient client, string url)
        {
            Result<BungohanRoom> joined = Pump.Wait(client,
                client.JoinOrCreateAsync("interop", null, Settings()), "the join");
            Suite.That(joined.IsOk, "join failed: " + joined.Error);
            return joined.Value;
        }
    }

    internal static class ResultChecks
    {
        public static void ThrowIfFailed(this Result result, string what)
        {
            if (!result.IsOk) throw new CheckFailed(what + " failed: " + result.Error);
        }
    }
}
