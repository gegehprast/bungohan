using System.Collections.Generic;

namespace Bungohan.Protocol
{
    /// <summary>
    /// What a client reports a connection's life through. A transport may
    /// call these from any thread: <see cref="BungohanClient"/> only queues
    /// them, and does the work in <see cref="BungohanClient.Poll"/>.
    /// </summary>
    public interface IClientSocketHandlers
    {
        /// <summary>The connection is open; <paramref name="protocol"/> is the version the server chose.</summary>
        void OnOpen(string protocol);

        /// <summary>One whole binary message, which is exactly one frame (§3).</summary>
        void OnMessage(byte[] data);

        /// <summary>
        /// The connection closed, or never opened. Fires exactly once, and
        /// never before <see cref="IClientTransport.Open"/> has returned.
        /// </summary>
        void OnClose(int code, string reason);
    }

    /// <summary>An open (or opening) connection.</summary>
    public interface IClientSocket
    {
        /// <summary>Sends one frame; false if the connection isn't open.</summary>
        bool Send(byte[] data);

        /// <summary>Closes the connection. <c>OnClose</c> still fires.</summary>
        void Close(int code, string reason);
    }

    /// <summary>
    /// How connections are opened. The default is
    /// <see cref="WebSocketClientTransport"/>; Unity WebGL, which has no
    /// <c>ClientWebSocket</c>, needs its own, and tests inject frames
    /// through one of their own.
    /// </summary>
    public interface IClientTransport
    {
        string Name { get; }

        /// <summary>
        /// Starts opening a connection to <paramref name="url"/>, offering
        /// <paramref name="protocols"/> as WebSocket subprotocols, most
        /// preferred first. It fails only when a connection can't even be
        /// attempted (a malformed URL, no WebSocket support); a server that
        /// can't be reached is reported later, through <c>OnClose</c>.
        /// </summary>
        Result<IClientSocket> Open(string url, IReadOnlyList<string> protocols, IClientSocketHandlers handlers);
    }
}
