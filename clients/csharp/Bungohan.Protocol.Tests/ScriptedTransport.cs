using System;
using System.Collections.Generic;
using Bungohan.Protocol;

namespace Bungohan.Protocol.Tests
{
    /// <summary>
    /// An <see cref="IClientTransport"/> with no socket: the test plays the
    /// server. It records what the client sends, answers what it chooses,
    /// and injects arbitrary frames, which is what the <c>behavior</c>
    /// vectors need (PROTOCOL.md §14: a connection holding one joined room
    /// at roomRef 1).
    /// </summary>
    public sealed class ScriptedTransport : IClientTransport
    {
        private readonly List<byte[]> _sent = new List<byte[]>();
        private ScriptedSocket? _socket;

        /// <summary>Answers one frame the client sent, with zero or more frames.</summary>
        public Func<byte[], IEnumerable<byte[]>>? Respond { get; set; }

        /// <summary>The protocol the "server" selected.</summary>
        public string Protocol { get; set; } = BungohanProtocol.Version;

        /// <summary>Every frame the client has sent.</summary>
        public IReadOnlyList<byte[]> Sent => _sent;

        /// <summary>False once the client or the test closed the connection.</summary>
        public bool IsOpen => _socket != null && !_socket.Closed;

        /// <summary>The close the client asked for, or null.</summary>
        public (int Code, string Reason)? ClosedBy => _socket?.ClosedBy;

        public string Name => "scripted";

        public Result<IClientSocket> Open(string url, IReadOnlyList<string> protocols, IClientSocketHandlers handlers)
        {
            var socket = new ScriptedSocket(this, handlers);
            _socket = socket;
            // Reported, never called inline: a transport may only report
            // through the handlers after Open has returned.
            socket.Pending.Add(() => handlers.OnOpen(Protocol));
            return Result<IClientSocket>.Ok(socket);
        }

        /// <summary>Delivers one frame to the client (the next Poll handles it).</summary>
        public void Inject(byte[] frame) => _socket?.Deliver(frame);

        /// <summary>Closes the connection from the network side.</summary>
        public void Drop(int code, string reason)
        {
            ScriptedSocket? socket = _socket;
            if (socket == null || socket.Closed) return;
            socket.Finish(code, reason);
        }

        /// <summary>Runs whatever the "server" owes the client so far.</summary>
        public void Flush()
        {
            ScriptedSocket? socket = _socket;
            if (socket == null) return;
            while (socket.Pending.Count > 0)
            {
                Action action = socket.Pending[0];
                socket.Pending.RemoveAt(0);
                action();
            }
        }

        internal void Record(byte[] frame) => _sent.Add(frame);

        private sealed class ScriptedSocket : IClientSocket
        {
            private readonly ScriptedTransport _transport;
            private readonly IClientSocketHandlers _handlers;

            public ScriptedSocket(ScriptedTransport transport, IClientSocketHandlers handlers)
            {
                _transport = transport;
                _handlers = handlers;
            }

            public List<Action> Pending { get; } = new List<Action>();
            public bool Closed { get; private set; }
            public (int Code, string Reason)? ClosedBy { get; private set; }

            public bool Send(byte[] data)
            {
                if (Closed) return false;
                _transport.Record(data);
                Func<byte[], IEnumerable<byte[]>>? respond = _transport.Respond;
                if (respond == null) return true;
                foreach (byte[] reply in respond(data)) Deliver(reply);
                return true;
            }

            public void Close(int code, string reason)
            {
                if (Closed) return;
                ClosedBy = (code, reason);
                Finish(code, reason);
            }

            public void Deliver(byte[] frame)
            {
                if (Closed) return;
                Pending.Add(() => _handlers.OnMessage(frame));
            }

            public void Finish(int code, string reason)
            {
                if (Closed) return;
                Closed = true;
                Pending.Add(() => _handlers.OnClose(code, reason));
            }
        }
    }
}
