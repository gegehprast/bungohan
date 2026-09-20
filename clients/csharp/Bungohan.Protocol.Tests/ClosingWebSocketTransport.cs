using System.Collections.Generic;
using Bungohan.Protocol;

namespace Bungohan.Protocol.Tests
{
    /// <summary>One connection's close: its code and reason.</summary>
    public readonly struct Closed
    {
        public Closed(int code, string reason)
        {
            Code = code;
            Reason = reason;
        }

        public int Code { get; }
        public string Reason { get; }

        public override string ToString() => Code + " " + Reason;
    }

    /// <summary>
    /// The real WebSocket transport, recording how every connection closed.
    /// The <c>behavior</c> vectors' <c>violation</c> cases are checked by
    /// the close code and its reason (PROTOCOL.md §8.2), which the client
    /// itself only exposes folded into an error message.
    /// </summary>
    public sealed class ClosingWebSocketTransport : IClientTransport
    {
        private readonly WebSocketClientTransport _inner = new WebSocketClientTransport();
        private readonly List<Closed> _closes;

        public ClosingWebSocketTransport(List<Closed> closes)
        {
            _closes = closes;
        }

        public string Name => _inner.Name;

        public Result<IClientSocket> Open(string url, IReadOnlyList<string> protocols, IClientSocketHandlers handlers) =>
            _inner.Open(url, protocols, new Watcher(handlers, _closes));

        private sealed class Watcher : IClientSocketHandlers
        {
            private readonly IClientSocketHandlers _inner;
            private readonly List<Closed> _closes;

            public Watcher(IClientSocketHandlers inner, List<Closed> closes)
            {
                _inner = inner;
                _closes = closes;
            }

            public void OnOpen(string protocol) => _inner.OnOpen(protocol);

            public void OnMessage(byte[] data) => _inner.OnMessage(data);

            public void OnClose(int code, string reason)
            {
                lock (_closes) _closes.Add(new Closed(code, reason));
                _inner.OnClose(code, reason);
            }
        }
    }
}
