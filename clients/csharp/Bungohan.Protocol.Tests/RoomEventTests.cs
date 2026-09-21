using System.Collections.Generic;
using System.Threading.Tasks;
using Bungohan.Interop;
using Bungohan.Protocol;

namespace Bungohan.Protocol.Tests
{
    /// <summary>
    /// The unclaimed-event rule (spec §7.5): what a room sends before its
    /// caller holds it — here, every event kind the server can send from
    /// <c>onJoin</c>, between <c>JOIN_SUCCESS</c> and the snapshot — is kept
    /// and delivered to the first handler attached for it, however late.
    /// Against <see cref="ScriptedTransport"/>, so no server is needed.
    /// </summary>
    public static class RoomEventTests
    {
        public static Suite Run()
        {
            var suite = new Suite("room events");
            suite.Run("events sent in onJoin reach handlers attached after the join resolves", EarlyEvents);
            return suite;
        }

        private static void EarlyEvents()
        {
            var transport = new ScriptedTransport();
            transport.Respond = Answer;
            var client = new BungohanClient(new ClientOptions
            {
                Url = "ws://scripted/",
                Transport = transport,
                PingIntervalMs = 0,
                JoinTimeoutMs = 0,
            });
            var settings = new JoinSettings { ServerMessages = InteropContract.ServerMessages };
            Task<Result<BungohanRoom>> joining = client.JoinOrCreateAsync("early", null, settings);
            Result<BungohanRoom> joined = Pump.Wait(client, joining, "the join", transport);
            Suite.That(joined.IsOk, "join failed: " + joined.Error);
            BungohanRoom room = joined.Value;
            // Later than the join itself: the held frames have been
            // released and found no handler (React subscribes this late).
            for (int i = 0; i < 3; i++)
            {
                transport.Flush();
                client.Poll();
            }

            var got = new List<string>();
            room.Message += (name, payload) =>
                got.Add(name + " " + WelcomeMessage.FromPayload(payload).SessionId);
            room.RawMessage += (type, payload) => got.Add("raw " + type + " " + payload);
            room.ClientJoined += id => got.Add("joined " + id);
            room.ClientLeft += id => got.Add("left " + id);
            room.ErrorReceived += (code, message) => got.Add("error " + code + " " + message);
            Suite.Equal(0d, (double)got.Count, "nothing is delivered inside the subscribing call");

            client.Poll();
            Suite.Equal(new List<object?>
            {
                "welcome session-1", "raw hello 7", "joined s-2", "left s-3", "error BOOM went wrong",
            }, got.ConvertAll(s => (object?)s), "delivered, in order");

            // Delivered once: a second handler finds nothing kept.
            got.Clear();
            room.RawMessage += (type, payload) => got.Add("again " + type);
            room.ClientJoined += id => got.Add("again " + id);
            client.Poll();
            Suite.Equal(0d, (double)got.Count, "a kept event is delivered to one handler only");
            client.Disconnect();
            client.Poll();
        }

        /// <summary>
        /// Answers the JOIN as a room that sends one event of each kind from
        /// its onJoin: after the handshake, before the snapshot (§6.1).
        /// </summary>
        private static IEnumerable<byte[]> Answer(byte[] frame)
        {
            if (frame.Length == 0 || frame[0] != ClientFrameType.Join) yield break;
            Result<Frame> parsed = Frames.Decode(frame, FrameDirection.Client);
            if (!parsed.IsOk) yield break;
            uint requestId = parsed.Value.Header[0];
            yield return Frames.Encode(ServerFrameType.JoinSuccess, new uint[] { requestId, 1 }, Body(new List<object?>
            {
                "early-room", "early", "session-1", null, "", "schema",
                new List<object?>(), new List<object?> { "welcome" },
            }));
            var welcome = new WelcomeMessage { SessionId = "session-1", Players = 1 };
            byte[] message = new SchemaCodec().EncodeMessage(WelcomeMessage.Definition, welcome.ToPayload()).Value;
            yield return Frames.Encode(ServerFrameType.RoomMessage, new uint[] { 1, 0 }, message);
            yield return Frames.Encode(ServerFrameType.RoomMessageRaw, new uint[] { 1 },
                Body(new List<object?> { "hello", 7L }));
            yield return Frames.Encode(ServerFrameType.ClientJoined, new uint[] { 1 }, Body("s-2"));
            yield return Frames.Encode(ServerFrameType.ClientLeft, new uint[] { 1 }, Body("s-3"));
            yield return Frames.Encode(ServerFrameType.Error, new uint[] { 1 },
                Body(new List<object?> { "BOOM", "went wrong" }));
            // An empty body is a room with no state (§5.2).
            yield return Frames.Encode(ServerFrameType.StateSnapshot, new uint[] { 1 });
        }

        private static byte[] Body(object? value) => MessagePack.Encode(value).Value;
    }
}
