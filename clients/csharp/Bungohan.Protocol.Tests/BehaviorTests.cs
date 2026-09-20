using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Bungohan.Protocol;

namespace Bungohan.Protocol.Tests
{
    /// <summary>
    /// The <c>behavior</c> conformance vectors (PROTOCOL.md §14): what a
    /// receiver must do with each frame.
    ///
    /// Client-side cases start from a connection holding one joined room at
    /// roomRef 1 with no contract, which <see cref="ScriptedTransport"/>
    /// gives without a socket. Server-side cases say what the <b>server</b>
    /// must do, so they run against the real interop server over a real
    /// WebSocket, with the frames sent verbatim; without one
    /// (<c>BUNGOHAN_INTEROP_URL</c>) they are skipped.
    /// </summary>
    public static class BehaviorTests
    {
        /// <summary>The handshake the scripted server answers a JOIN with (§6.4).</summary>
        private static byte[] Handshake() => MessagePack.Encode(new List<object?>
        {
            "compat-room", "compat", "session-1", null, "", "schema",
            new List<object?>(), new List<object?>(),
        }).Value;

        /// <summary>Client side, against a scripted connection.</summary>
        public static void ClientCase(MsgMap c)
        {
            var transport = new ScriptedTransport();
            transport.Respond = frame => Answer(frame);
            var logged = new List<string>();
            var client = new BungohanClient(new ClientOptions
            {
                Url = "ws://scripted/",
                Transport = transport,
                PingIntervalMs = 0,
                JoinTimeoutMs = 0,
                Log = Pump.Collect(logged),
            });
            Task<Result<BungohanRoom>> joining = client.JoinOrCreateAsync("compat");
            Result<BungohanRoom> joined = Pump.Wait(client, joining, "the join", transport);
            Suite.That(joined.IsOk, "join failed: " + joined.Error);
            BungohanRoom room = joined.Value;
            Suite.Equal(1d, (double)room.RoomRef, "roomRef");
            // Handlers for everything an "accept" frame may carry, so that
            // nothing counts as unhandled.
            room.RawMessage += (type, payload) => { };
            room.Message += (name, payload) => { };
            room.ErrorReceived += (code, message) => { };
            room.ClientJoined += id => { };
            room.ClientLeft += id => { };
            client.ErrorReceived += error => { };

            int before = client.DroppedFrames;
            foreach (object? hex in (List<object?>)c["frames"]!)
            {
                transport.Inject(Values.FromHex((string)hex!));
            }
            // Two rounds: a frame may be handled on a later poll (deferred
            // work), and nothing here waits on real time.
            for (int i = 0; i < 4; i++)
            {
                transport.Flush();
                client.Poll();
            }
            int dropped = client.DroppedFrames - before;
            string expect = (string)c["expect"]!;
            Suite.Equal(expect == "drop" ? 1d : 0d, (double)dropped, "frames dropped");
            Suite.That(transport.IsOpen, "the connection should stay open");
            Suite.That(room.Status == RoomStatus.Joined, "the room should stay joined, was " + room.Status);
            Suite.That(client.State == ConnectionState.Connected,
                "the client should stay connected, was " + client.State);
        }

        /// <summary>Answers the scripted client's JOIN with a handshake and an empty snapshot.</summary>
        private static IEnumerable<byte[]> Answer(byte[] frame)
        {
            if (frame.Length == 0 || frame[0] != ClientFrameType.Join) yield break;
            Result<Frame> parsed = Frames.Decode(frame, FrameDirection.Client);
            if (!parsed.IsOk) yield break;
            uint requestId = parsed.Value.Header[0];
            yield return Frames.Encode(ServerFrameType.JoinSuccess, new uint[] { requestId, 1 }, Handshake());
            // An empty body is a room with no state (§5.2).
            yield return Frames.Encode(ServerFrameType.StateSnapshot, new uint[] { 1 });
        }

        /// <summary>Server side, against the real interop server.</summary>
        public static void ServerCase(MsgMap c, string url)
        {
            var errors = new List<ClientError>();
            var closes = new List<int>();
            var transport = new ClosingWebSocketTransport(closes);
            var client = new BungohanClient(new ClientOptions
            {
                Url = url,
                PingIntervalMs = 0,
                Transport = transport,
                Reconnection = new ReconnectionOptions { Enabled = false },
            });
            try
            {
                Result<BungohanRoom> joined = Pump.Wait(client, client.JoinOrCreateAsync("compat"), "the join");
                Suite.That(joined.IsOk, "join failed: " + joined.Error);
                Suite.Equal(1d, (double)joined.Value.RoomRef, "roomRef");
                client.ErrorReceived += error => errors.Add(error);

                foreach (object? hex in (List<object?>)c["frames"]!)
                {
                    Suite.That(client.SendFrameBytes(Values.FromHex((string)hex!)), "the frame was not sent");
                }

                if ((string)c["expect"]! == "violation")
                {
                    // The close code is the signal; the ERROR frame that
                    // precedes it may be dropped by the transport (§8.2).
                    Pump.Until(client, () => client.State == ConnectionState.Disconnected,
                        "the server to close the connection");
                    Suite.That(closes.Count > 0 && closes[0] == CloseCode.PolicyViolation,
                        "expected a 1008 close, got " + (closes.Count > 0 ? closes[0].ToString() : "none"));
                    foreach (ClientError error in errors)
                    {
                        Suite.That(error.Message.StartsWith("INVALID_MESSAGE", StringComparison.Ordinal),
                            "expected INVALID_MESSAGE, got " + error);
                    }
                }
                else
                {
                    Pump.For(client, 250);
                    Suite.That(errors.Count == 0, "unexpected error: " + (errors.Count > 0 ? errors[0].ToString() : ""));
                    Suite.That(client.State == ConnectionState.Connected,
                        "the connection should stay open, was " + client.State);
                }
            }
            finally
            {
                client.Disconnect();
                client.Poll();
            }
        }
    }
}
