using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Net.WebSockets;
using System.Threading;
using System.Threading.Tasks;

namespace Bungohan.Protocol
{
    /// <summary>
    /// The default transport: <see cref="ClientWebSocket"/>, which works on
    /// .NET, Mono and Unity's Mono/IL2CPP players, but <b>not</b> Unity
    /// WebGL, where the browser owns the socket — write an
    /// <see cref="IClientTransport"/> over the JS WebSocket there.
    ///
    /// Receiving runs on a background task and only hands whole binary
    /// messages to the handlers, which <see cref="BungohanClient"/> queues;
    /// nothing of yours runs off the main thread.
    /// </summary>
    public sealed class WebSocketClientTransport : IClientTransport
    {
        /// <summary>Largest message accepted; a larger one closes the connection.</summary>
        public int MaxMessageBytes { get; set; } = 8 * 1024 * 1024;

        public string Name => "websocket";

        public Result<IClientSocket> Open(string url, IReadOnlyList<string> protocols, IClientSocketHandlers handlers)
        {
            Uri uri;
            try
            {
                uri = new Uri(url);
            }
            catch (Exception error)
            {
                return Result<IClientSocket>.Fail(ClientErrorCodes.ConnectionFailed, error.Message);
            }
            var socket = new WebSocketSocket(uri, protocols, handlers, MaxMessageBytes);
            socket.Start();
            return Result<IClientSocket>.Ok(socket);
        }

        private sealed class WebSocketSocket : IClientSocket
        {
            private readonly ClientWebSocket _socket = new ClientWebSocket();
            private readonly Uri _uri;
            private readonly IClientSocketHandlers _handlers;
            private readonly int _maxMessageBytes;
            private readonly CancellationTokenSource _cancel = new CancellationTokenSource();
            private readonly ConcurrentQueue<byte[]> _outbox = new ConcurrentQueue<byte[]>();
            private readonly SemaphoreSlim _pending = new SemaphoreSlim(0);
            private int _closed;
            private volatile bool _open;

            public WebSocketSocket(Uri uri, IReadOnlyList<string> protocols, IClientSocketHandlers handlers, int maxMessageBytes)
            {
                _uri = uri;
                _handlers = handlers;
                _maxMessageBytes = maxMessageBytes;
                foreach (string protocol in protocols) _socket.Options.AddSubProtocol(protocol);
            }

            public void Start()
            {
                // Detached on purpose: everything it produces reaches the
                // caller through the handlers, never through this task.
                _ = Task.Run(RunAsync);
            }

            public bool Send(byte[] data)
            {
                if (!_open) return false;
                _outbox.Enqueue(data);
                try
                {
                    _pending.Release();
                }
                catch (ObjectDisposedException)
                {
                    return false;
                }
                return true;
            }

            public void Close(int code, string reason)
            {
                if (Interlocked.Exchange(ref _closed, 1) != 0) return;
                _open = false;
                _ = Task.Run(async () =>
                {
                    try
                    {
                        if (_socket.State == WebSocketState.Open)
                        {
                            await _socket.CloseAsync(Status(code), Clip(reason), CancellationToken.None)
                                .ConfigureAwait(false);
                        }
                    }
                    catch (Exception)
                    {
                        // The receive loop reports the close either way.
                    }
                    _cancel.Cancel();
                });
            }

            private async Task RunAsync()
            {
                int code = CloseCode.Abnormal;
                string reason = "";
                Task? sender = null;
                try
                {
                    await _socket.ConnectAsync(_uri, _cancel.Token).ConfigureAwait(false);
                    _open = true;
                    sender = Task.Run(SendLoopAsync);
                    _handlers.OnOpen(_socket.SubProtocol ?? "");
                    var buffer = new byte[16 * 1024];
                    var message = new List<byte>();
                    while (!_cancel.IsCancellationRequested)
                    {
                        WebSocketReceiveResult received = await _socket
                            .ReceiveAsync(new ArraySegment<byte>(buffer), _cancel.Token).ConfigureAwait(false);
                        if (received.MessageType == WebSocketMessageType.Close)
                        {
                            code = received.CloseStatus.HasValue ? (int)received.CloseStatus.Value : CloseCode.Abnormal;
                            reason = received.CloseStatusDescription ?? "";
                            break;
                        }
                        if (message.Count + received.Count > _maxMessageBytes)
                        {
                            code = CloseCode.TooLarge;
                            reason = "message too large";
                            break;
                        }
                        for (int i = 0; i < received.Count; i++) message.Add(buffer[i]);
                        if (!received.EndOfMessage) continue;
                        // A text message is passed on as its UTF-8 bytes; the
                        // frame parser drops it as an unknown frame (§2.3).
                        _handlers.OnMessage(message.ToArray());
                        message.Clear();
                    }
                }
                catch (OperationCanceledException)
                {
                    code = _open ? CloseCode.Normal : CloseCode.Abnormal;
                }
                catch (Exception error)
                {
                    reason = error.Message;
                }
                finally
                {
                    _open = false;
                    _cancel.Cancel();
                    try
                    {
                        _pending.Release();
                    }
                    catch (ObjectDisposedException)
                    {
                        // Already torn down.
                    }
                    if (sender != null)
                    {
                        try
                        {
                            await sender.ConfigureAwait(false);
                        }
                        catch (Exception)
                        {
                            // The close below is what the client hears about.
                        }
                    }
                    _socket.Dispose();
                    _pending.Dispose();
                    _cancel.Dispose();
                    _handlers.OnClose(code, reason);
                }
            }

            private async Task SendLoopAsync()
            {
                while (!_cancel.IsCancellationRequested)
                {
                    try
                    {
                        await _pending.WaitAsync(_cancel.Token).ConfigureAwait(false);
                    }
                    catch (Exception)
                    {
                        return;
                    }
                    while (_outbox.TryDequeue(out byte[] frame))
                    {
                        if (_socket.State != WebSocketState.Open) return;
                        try
                        {
                            await _socket.SendAsync(new ArraySegment<byte>(frame), WebSocketMessageType.Binary,
                                true, _cancel.Token).ConfigureAwait(false);
                        }
                        catch (Exception)
                        {
                            return; // The receive loop reports the close.
                        }
                    }
                }
            }

            /// <summary>
            /// WebSocket only allows 1000 and 3000–4999 to be sent; anything
            /// else (1006, 1001, …) closes normally instead of throwing.
            /// </summary>
            private static WebSocketCloseStatus Status(int code) =>
                code == CloseCode.Normal || (code >= 3000 && code <= 4999)
                    ? (WebSocketCloseStatus)code
                    : WebSocketCloseStatus.NormalClosure;

            /// <summary>WebSocket close reasons are at most 123 UTF-8 bytes.</summary>
            private static string Clip(string reason) =>
                reason.Length <= 60 ? reason : reason.Substring(0, 60);
        }
    }
}
