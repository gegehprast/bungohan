using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using Bungohan.Protocol;

namespace Bungohan.Protocol.Tests
{
    /// <summary>
    /// <c>join</c> vectors (PROTOCOL.md §6.2.1, §14): building the
    /// <c>JOIN</c> frame gives exactly the case's bytes, and, with the
    /// interop server, sending those bytes on a fresh connection gets the
    /// case's reply and, on success, the room's echo of what it received.
    /// </summary>
    public static class JoinVectors
    {
        public static void Encode(MsgMap c)
        {
            if (!c.ContainsKey("request")) return;
            var declares = (MsgMap)c["declares"]!;
            MessageDef? create = declares.ContainsKey("create") ? VectorRunner.MessageOf(declares["create"]) : null;
            MessageDef? join = declares.ContainsKey("join") ? VectorRunner.MessageOf(declares["join"]) : null;
            var r = (MsgMap)c["request"]!;
            var options = new TypedOptions(join, r["join"] as MsgMap, create, r["create"] as MsgMap);
            Result<byte[]> body = BungohanClient.EncodeJoin(
                Convert.ToInt32(r["mode"]), (string)r["target"]!, options, r["contractHash"] as string);
            Suite.That(body.IsOk, "encoding failed: " + body.Error);
            byte[] frame = Frames.Encode(ClientFrameType.Join, new[] { Convert.ToUInt32(r["requestId"]) }, body.Value);
            Suite.Equal(Values.ToHex(Values.FromHex((string)c["hex"]!)), Values.ToHex(frame), "JOIN bytes");
        }

        /// <summary>Sends the case's bytes to the interop server's <c>options</c> room type.</summary>
        public static void Server(MsgMap c, string url)
        {
            byte[] bytes = Values.FromHex((string)c["hex"]!);
            Result<Frame> sent = Frames.Decode(bytes, FrameDirection.Client);
            Suite.That(sent.IsOk, "the case's JOIN doesn't parse");
            uint requestId = sent.Value.Header[0];
            using var socket = RawSocket.Connect(url);
            Suite.That(socket.Send(bytes), "the JOIN was not sent");

            Frame reply = socket.Next(f => (f.Type == ServerFrameType.JoinSuccess || f.Type == ServerFrameType.JoinError)
                                           && f.Header[0] == requestId, "the JOIN reply");
            string expected = (string)c["reply"]!;
            if (expected != "JOIN_SUCCESS")
            {
                Suite.Equal((double)ServerFrameType.JoinError, (double)reply.Type, "reply frame type");
                var error = (List<object?>)MessagePack.Decode(reply.BodyBytes()).Value!;
                Suite.Equal(expected, error[0], "JOIN_ERROR code");
                Suite.That(socket.Open, "the connection should stay open");
                return;
            }
            Suite.Equal((double)ServerFrameType.JoinSuccess, (double)reply.Type,
                "reply frame type (JOIN_ERROR " + Show(reply) + ")");
            uint roomRef = reply.Header[1];
            Frame echo = socket.Next(f => f.Type == ServerFrameType.RoomMessageRaw && f.Header[0] == roomRef,
                "the room's echo");
            var message = (List<object?>)MessagePack.Decode(echo.BodyBytes()).Value!;
            Suite.Equal("options", message[0], "echo type");
            object? received = c.ContainsKey("received") ? c["received"] : Default(c);
            Suite.Equal(received, message[1], "what the room received");
        }

        private static object Default(MsgMap c)
        {
            var r = (MsgMap)c["request"]!;
            var received = new MsgMap();
            received["join"] = r["join"];
            received["create"] = r["create"];
            return received;
        }

        private static string Show(Frame frame) =>
            frame.Type == ServerFrameType.JoinError
                ? Values.Show(MessagePack.Decode(frame.BodyBytes()).Value)
                : "none";

        /// <summary>A bare connection: frames as they come, no client logic.</summary>
        private sealed class RawSocket : IClientSocketHandlers, IDisposable
        {
            private readonly BlockingCollection<byte[]> _frames = new BlockingCollection<byte[]>();
            private readonly ManualResetEventSlim _opened = new ManualResetEventSlim();
            private IClientSocket? _socket;
            private volatile bool _closed;

            public bool Open => _opened.IsSet && !_closed;

            public static RawSocket Connect(string url)
            {
                var raw = new RawSocket();
                Result<IClientSocket> socket = new WebSocketClientTransport()
                    .Open(url, new[] { BungohanProtocol.Version }, raw);
                Suite.That(socket.IsOk, "could not open: " + socket.Error);
                raw._socket = socket.Value;
                Suite.That(raw._opened.Wait(5000) && !raw._closed, "the connection did not open");
                return raw;
            }

            public bool Send(byte[] data) => _socket != null && _socket.Send(data);

            public Frame Next(Func<Frame, bool> wanted, string what)
            {
                DateTime deadline = DateTime.UtcNow.AddSeconds(5);
                while (true)
                {
                    TimeSpan left = deadline - DateTime.UtcNow;
                    if (left <= TimeSpan.Zero || !_frames.TryTake(out byte[]? data, left))
                    {
                        throw new CheckFailed("timed out waiting for " + what);
                    }
                    Result<Frame> frame = Frames.Decode(data, FrameDirection.Server);
                    if (frame.IsOk && wanted(frame.Value)) return frame.Value;
                }
            }

            public void OnOpen(string protocol) => _opened.Set();

            public void OnMessage(byte[] data) => _frames.Add(data);

            public void OnClose(int code, string reason)
            {
                _closed = true;
                _opened.Set();
            }

            // The collection and the event stay undisposed: the transport may
            // still report from its receive loop after the close.
            public void Dispose() => _socket?.Close(CloseCode.Normal, "done");
        }
    }
}
