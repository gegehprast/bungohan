using System.Collections.Generic;
using Bungohan.Protocol;

namespace Bungohan.Protocol.Tests
{
    /// <summary>
    /// The real WebSocket transport, recording the close code of every
    /// connection. The <c>behavior</c> vectors' <c>violation</c> cases are
    /// checked by that code (PROTOCOL.md §8.2), which the client itself
    /// only exposes as a state change.
    /// </summary>
    public sealed class ClosingWebSocketTransport : IClientTransport
    {
        private readonly WebSocketClientTransport _inner = new WebSocketClientTransport();
        private readonly List<int> _closes;

        public ClosingWebSocketTransport(List<int> closes)
        {
            _closes = closes;
        }

        public string Name => _inner.Name;

        public Result<IClientSocket> Open(string url, IReadOnlyList<string> protocols, IClientSocketHandlers handlers) =>
            _inner.Open(url, protocols, new Watcher(handlers, _closes));

        private sealed class Watcher : IClientSocketHandlers
        {
            private readonly IClientSocketHandlers _inner;
            private readonly List<int> _closes;

            public Watcher(IClientSocketHandlers inner, List<int> closes)
            {
                _inner = inner;
                _closes = closes;
            }

            public void OnOpen(string protocol) => _inner.OnOpen(protocol);

            public void OnMessage(byte[] data) => _inner.OnMessage(data);

            public void OnClose(int code, string reason)
            {
                lock (_closes) _closes.Add(code);
                _inner.OnClose(code, reason);
            }
        }
    }
}
