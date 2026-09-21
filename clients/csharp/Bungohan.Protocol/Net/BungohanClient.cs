using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading.Tasks;

namespace Bungohan.Protocol
{
    /// <summary>How a <see cref="BungohanClient"/> is set up.</summary>
    public sealed class ClientOptions
    {
        /// <summary>The server, e.g. <c>ws://127.0.0.1:6060</c>.</summary>
        public string Url { get; set; } = "";

        /// <summary>Sent as <c>?token=</c>, for the server's auth hooks (§2.1).</summary>
        public string? Token { get; set; }

        /// <summary>How the client retries after an unexpected close (§7.3).</summary>
        public ReconnectionOptions Reconnection { get; set; } = new ReconnectionOptions();

        /// <summary>How connections are opened. Default <see cref="WebSocketClientTransport"/>.</summary>
        public IClientTransport? Transport { get; set; }

        /// <summary>
        /// The codecs this client can decode. The handshake names the
        /// room's; one missing here fails the join with
        /// <c>CODEC_MISMATCH</c> (§6.4). Default: <c>schema</c> and
        /// <c>messagepack</c>.
        /// </summary>
        public IReadOnlyList<IStateCodec>? StateCodecs { get; set; }

        /// <summary>Milliseconds between <c>PING</c>s; 0 disables (§7.5).</summary>
        public double PingIntervalMs { get; set; } = 5000;

        /// <summary>A join the server hasn't answered by then fails with <c>TIMEOUT</c>; 0 disables.</summary>
        public double JoinTimeoutMs { get; set; } = 10000;

        /// <summary>Where dropped frames and listener failures are reported.</summary>
        public Action<string, string>? Log { get; set; }

        /// <summary>A monotonic clock in milliseconds; default a <see cref="Stopwatch"/>.</summary>
        public Func<double>? Now { get; set; }
    }

    /// <summary>
    /// A Bungohan client (PROTOCOL.md §6, §7): joins rooms, exchanges
    /// contract and raw messages, keeps a state replica per room, and
    /// reconnects with the stored token.
    ///
    /// <b>Everything happens on the thread that calls <see cref="Poll"/>.</b>
    /// The transport may receive on a background thread, but the client only
    /// queues what it reports; frames are parsed, events raised and the
    /// tasks below completed inside <c>Poll()</c>. Call it once a frame
    /// (Unity's <c>Update</c>, Godot's <c>_Process</c>).
    ///
    /// <code>
    /// var client = new BungohanClient(new ClientOptions { Url = "ws://localhost:6060" });
    /// // in Update(): client.Poll();
    /// await client.ConnectAsync();
    /// var joined = await client.JoinOrCreateAsync("game", null, settings);
    /// </code>
    /// </summary>
    public sealed class BungohanClient : IRoomHost
    {
        /// <summary>Largest header varint (§1.1).</summary>
        private const uint MaxVarint = 0xffffffff;

        /// <summary>Client-initiated close used to force a re-sync (§11.10).</summary>
        private const int ResyncClose = 4000;

        private readonly string _url;
        private readonly ReconnectionOptions _reconnection;
        private readonly IClientTransport _transport;
        private readonly Dictionary<string, IStateCodec> _codecs = new Dictionary<string, IStateCodec>();
        private readonly double _pingIntervalMs;
        private readonly double _joinTimeoutMs;
        private readonly Action<string, string> _log;
        private readonly Func<double> _now;
        private readonly Stopwatch _stopwatch = Stopwatch.StartNew();

        /// <summary>What the transport reported, waiting for the next <see cref="Poll"/>.</summary>
        private readonly ConcurrentQueue<Action> _inbox = new ConcurrentQueue<Action>();

        private readonly Dictionary<uint, BungohanRoom> _byRef = new Dictionary<uint, BungohanRoom>();
        private readonly List<BungohanRoom> _resuming = new List<BungohanRoom>();
        private readonly Dictionary<uint, PendingJoin> _pending = new Dictionary<uint, PendingJoin>();
        private readonly List<TaskCompletionSource<Result>> _connecting =
            new List<TaskCompletionSource<Result>>();

        private SocketBinding? _connection;
        private uint _nextRequest = 1;
        private uint _nextNonce = 1;
        private int _attempt;
        private double _retryAt = double.PositiveInfinity;
        private double _nextPingAt = double.PositiveInfinity;
        private uint _pingNonce;
        private double _pingSentAt;
        private bool _polling;

        public BungohanClient(ClientOptions options)
        {
            _url = WithToken(options.Url, options.Token);
            _reconnection = options.Reconnection;
            _transport = options.Transport ?? new WebSocketClientTransport();
            IReadOnlyList<IStateCodec> codecs = options.StateCodecs ??
                new IStateCodec[] { new SchemaCodec(), new MessagePackCodec() };
            foreach (IStateCodec codec in codecs) _codecs[codec.Name] = codec;
            _pingIntervalMs = options.PingIntervalMs;
            _joinTimeoutMs = options.JoinTimeoutMs;
            _log = options.Log ?? ((level, message) => { });
            _now = options.Now ?? (() => _stopwatch.Elapsed.TotalMilliseconds);
        }

        public ConnectionState State { get; private set; } = ConnectionState.Disconnected;

        /// <summary>Last measured round trip in milliseconds, or null (§7.5).</summary>
        public double? Latency { get; private set; }

        /// <summary>
        /// Frames this client dropped under the §9.2 rules (an unknown frame
        /// type, an unmappable message id, a malformed body). Diagnostics.
        /// </summary>
        public int DroppedFrames { get; private set; }

        /// <summary>Rooms that have had a snapshot, including resuming ones.</summary>
        public IReadOnlyCollection<BungohanRoom> Rooms
        {
            get
            {
                var rooms = new List<BungohanRoom>();
                foreach (BungohanRoom room in _byRef.Values)
                {
                    if (room.Snapshots > 0) rooms.Add(room);
                }
                rooms.AddRange(_resuming);
                return rooms;
            }
        }

        /// <summary>An open connection closed (whether or not a reconnection follows).</summary>
        public event Action? Disconnected;

        /// <summary>A reconnection opened a new connection; seats resume next.</summary>
        public event Action? Reconnected;

        /// <summary>Connection-level errors: <c>ERROR</c> frames, failed reconnection.</summary>
        public event Action<ClientError>? ErrorReceived;

        // --- the pump ------------------------------------------------------

        /// <summary>
        /// Dispatches everything the transport reported and everything that
        /// has fallen due (pings, join timeouts, reconnection attempts).
        /// Every event and every task continuation of this client runs here,
        /// on the calling thread. A call made from inside one of those does
        /// nothing, so a listener can't recurse into the pump.
        /// </summary>
        public void Poll()
        {
            if (_polling) return;
            _polling = true;
            try
            {
                while (_inbox.TryDequeue(out Action action)) action();
                Timers();
            }
            finally
            {
                _polling = false;
            }
        }

        private void Timers()
        {
            double now = _now();
            if (now >= _retryAt)
            {
                _retryAt = double.PositiveInfinity;
                Open();
            }
            if (now >= _nextPingAt)
            {
                _nextPingAt = _pingIntervalMs > 0 ? now + _pingIntervalMs : double.PositiveInfinity;
                SendPing(now);
            }
            if (_pending.Count == 0) return;
            var due = new List<uint>();
            foreach (KeyValuePair<uint, PendingJoin> entry in _pending)
            {
                if (now >= entry.Value.DeadlineMs) due.Add(entry.Key);
            }
            foreach (uint requestId in due)
            {
                Settle(requestId, Result<BungohanRoom>.Fail(ClientErrorCodes.Timeout,
                    "the server did not answer the join"));
            }
        }

        // --- connection ----------------------------------------------------

        /// <summary>
        /// Opens the connection; the task completes in <see cref="Poll"/>
        /// once it is open (or has failed). A first connect that never opens
        /// fails with <c>CONNECTION_FAILED</c> and is not retried.
        /// </summary>
        public Task<Result> ConnectAsync()
        {
            if (State == ConnectionState.Connected) return Task.FromResult(Result.Ok());
            // No RunContinuationsAsynchronously: completing inside Poll()
            // must run the awaiting code on the polling thread.
            var waiting = new TaskCompletionSource<Result>();
            _connecting.Add(waiting);
            if (State == ConnectionState.Disconnected)
            {
                State = ConnectionState.Connecting;
                Open();
            }
            return waiting.Task;
        }

        /// <summary>Leaves every room (consented) and closes. No reconnection follows.</summary>
        public void Disconnect()
        {
            LeaveAll();
            _retryAt = double.PositiveInfinity;
            SocketBinding? connection = _connection;
            _connection = null;
            bool wasOpen = connection != null && connection.Open;
            SetDisconnected(new ClientError(ClientErrorCodes.ConnectionLost, "client disconnected"));
            connection?.Socket?.Close(CloseCode.Normal, "client disconnect");
            if (wasOpen) Raise(Disconnected);
        }

        public void LeaveAll()
        {
            foreach (BungohanRoom room in new List<BungohanRoom>(_byRef.Values)) room.Leave();
            foreach (BungohanRoom room in new List<BungohanRoom>(_resuming)) room.Leave();
            foreach (PendingJoin pending in new List<PendingJoin>(_pending.Values)) pending.Room.Leave();
        }

        // --- joins ---------------------------------------------------------
        //
        // `options`: for a room type whose contract declares typed options
        // (PROTOCOL.md §6.2.1), the TypedOptions its generated binding
        // builds: `ShooterContract.CreateOptions(create, join)` for
        // JoinOrCreate/Create, `ShooterContract.JoinOptions(join)` for
        // Join/JoinById. Otherwise any MessagePack value (a MsgMap, …).

        public Task<Result<BungohanRoom>> JoinOrCreateAsync(string roomType, object? options = null,
            JoinSettings? settings = null) =>
            JoinAsync(JoinMode.JoinOrCreate, roomType, options, settings, null);

        public Task<Result<BungohanRoom>> CreateAsync(string roomType, object? options = null,
            JoinSettings? settings = null) =>
            JoinAsync(JoinMode.Create, roomType, options, settings, null);

        public Task<Result<BungohanRoom>> JoinAsync(string roomType, object? options = null,
            JoinSettings? settings = null) =>
            JoinAsync(JoinMode.Join, roomType, options, settings, null);

        public Task<Result<BungohanRoom>> JoinByIdAsync(string roomId, object? options = null,
            JoinSettings? settings = null) =>
            JoinAsync(JoinMode.JoinById, roomId, options, settings, null);

        /// <summary>
        /// Resumes a held seat with a token kept from an earlier connection
        /// (§7.3). Automatic reconnection needs no call.
        /// </summary>
        public Task<Result<BungohanRoom>> ReconnectAsync(string roomId, string reconnectionToken,
            JoinSettings? settings = null) =>
            JoinAsync(JoinMode.Reconnect, reconnectionToken, null, settings, roomId);

        public Task<Result<BungohanRoom>> ConsumeReservationAsync(string reservationId,
            JoinSettings? settings = null) =>
            JoinAsync(JoinMode.ConsumeReservation, reservationId, null, settings, null);

        private async Task<Result<BungohanRoom>> JoinAsync(int mode, string target, object? options,
            JoinSettings? settings, string? roomId)
        {
            Result connected = await ConnectAsync().ConfigureAwait(false);
            if (!connected.IsOk) return Result<BungohanRoom>.Fail(connected.Error!);
            var room = new BungohanRoom(this, settings ?? new JoinSettings());
            return await Request(room, mode, target, options, roomId, false).ConfigureAwait(false);
        }

        private Task<Result<BungohanRoom>> Request(BungohanRoom room, int mode, string target,
            object? options, string? roomId, bool resume)
        {
            uint requestId = _nextRequest;
            _nextRequest = requestId >= MaxVarint ? 1 : requestId + 1;
            var waiting = new TaskCompletionSource<Result<BungohanRoom>>();
            var pending = new PendingJoin(room, roomId, resume, waiting,
                _joinTimeoutMs > 0 ? _now() + _joinTimeoutMs : double.PositiveInfinity);
            _pending[requestId] = pending;
            Result<byte[]> encoded = EncodeJoin(mode, target, options, room.Hash);
            Result sent = encoded.IsOk
                ? SendFrame(ClientFrameType.Join, new[] { requestId }, encoded.Value)
                : Result.Fail(encoded.Error!);
            if (!sent.IsOk) Settle(requestId, Result<BungohanRoom>.Fail(sent.Error!));
            return waiting.Task;
        }

        /// <summary>
        /// A <c>JOIN</c> body (PROTOCOL.md §6.2). <paramref name="options"/>
        /// is untyped (any MessagePack value) or <see cref="TypedOptions"/>
        /// (§6.2.1), which a generated contract builds.
        /// </summary>
        public static Result<byte[]> EncodeJoin(int mode, string target, object? options, string? contractHash)
        {
            if (!(options is TypedOptions typed))
            {
                return MessagePack.Encode(new List<object?> { (long)mode, target, options, contractHash });
            }
            Result<List<object?>> body = typed.Body(mode, target, contractHash);
            return body.IsOk ? MessagePack.Encode(body.Value) : Result<byte[]>.Fail(body.Error!);
        }

        /// <summary>
        /// Resolves a pending join. A failure after <c>JOIN_SUCCESS</c> (a
        /// timeout, …) gives back the seat the server already assigned.
        /// </summary>
        private void Settle(uint requestId, Result<BungohanRoom> result)
        {
            if (!_pending.TryGetValue(requestId, out PendingJoin pending)) return;
            _pending.Remove(requestId);
            if (!result.IsOk)
            {
                BungohanRoom room = pending.Room;
                if (_byRef.TryGetValue(room.RoomRef, out BungohanRoom seated) && seated == room &&
                    room.Status != RoomStatus.Left)
                {
                    SendFrame(ClientFrameType.Leave, new[] { room.RoomRef }, null);
                    _byRef.Remove(room.RoomRef);
                }
                if (pending.Resume)
                {
                    // A seat that couldn't be resumed is gone.
                    room.Fail(result.Error!.Code, result.Error.Message);
                    room.MarkLeft(LeaveCode.Disconnected);
                }
            }
            pending.Waiting.TrySetResult(result);
        }

        private void JoinSuccess(uint requestId, uint roomRef, byte[] body, int offset, int count)
        {
            if (!_pending.TryGetValue(requestId, out PendingJoin pending))
            {
                Warn("dropped JOIN_SUCCESS for unknown request " + requestId);
                // The server seated us; don't keep a seat nobody uses.
                SendFrame(ClientFrameType.Leave, new[] { roomRef }, null);
                return;
            }
            Result<object?> decoded = MessagePack.Decode(body, offset, count);
            JoinHandshake? handshake = decoded.IsOk ? JoinHandshake.Parse(decoded.Value) : null;
            if (handshake == null)
            {
                SendFrame(ClientFrameType.Leave, new[] { roomRef }, null);
                Settle(requestId, Result<BungohanRoom>.Fail(ClientErrorCodes.InvalidMessage,
                    "malformed JOIN_SUCCESS"));
                return;
            }
            if (!_codecs.TryGetValue(handshake.StateCodec, out IStateCodec codec))
            {
                // No fallback to another codec (§6.4): leave, fail locally.
                SendFrame(ClientFrameType.Leave, new[] { roomRef }, null);
                Settle(requestId, Result<BungohanRoom>.Fail(ClientErrorCodes.CodecMismatch,
                    "the room uses state codec \"" + handshake.StateCodec +
                    "\", which this client can't decode"));
                return;
            }
            if (pending.RoomId != null && pending.RoomId != handshake.RoomId)
            {
                SendFrame(ClientFrameType.Leave, new[] { roomRef }, null);
                Settle(requestId, Result<BungohanRoom>.Fail(ClientErrorCodes.InvalidToken,
                    "the token belongs to room " + handshake.RoomId + ", not " + pending.RoomId));
                return;
            }
            pending.Room.Bind(roomRef, handshake, codec);
            _byRef[roomRef] = pending.Room;
            // The join completes with the first STATE_SNAPSHOT (§6.1).
        }

        // --- frames --------------------------------------------------------

        /// <summary>
        /// Sends raw frame bytes on the current connection. For tools and
        /// conformance tests; ordinary code uses the room's methods.
        /// </summary>
        public bool SendFrameBytes(byte[] frame)
        {
            SocketBinding? connection = _connection;
            if (connection == null || !connection.Open || connection.Socket == null) return false;
            return connection.Socket.Send(frame);
        }

        Result IRoomHost.SendFrame(byte type, uint[] header, byte[]? body) => SendFrame(type, header, body);

        private Result SendFrame(byte type, uint[] header, byte[]? body)
        {
            SocketBinding? connection = _connection;
            if (connection == null || !connection.Open || connection.Socket == null)
            {
                return Result.Fail(ClientErrorCodes.NotConnected, "not connected");
            }
            byte[] frame = body == null
                ? Frames.Encode(type, header)
                : Frames.Encode(type, header, body);
            return connection.Socket.Send(frame)
                ? Result.Ok()
                : Result.Fail(ClientErrorCodes.NotConnected, "the connection is closed");
        }

        private void Receive(SocketBinding connection, byte[] data)
        {
            if (connection != _connection) return;
            if (data.Length == 0)
            {
                Drop("empty frame");
                return;
            }
            byte type = data[0];
            // An unknown frame type is dropped, not fatal: a newer server
            // may send frames this client predates. A frame is one whole
            // transport message, so skipping it is always safe (§9.2).
            if (Frames.HeaderCount(FrameDirection.Server, type) < 0)
            {
                Drop("frame: unknown frame type " + type);
                return;
            }
            Result<Frame> parsed = Frames.Decode(data, FrameDirection.Server);
            if (!parsed.IsOk)
            {
                Drop("frame " + type + ": " + parsed.Error!.Message);
                return;
            }
            Frame frame = parsed.Value;
            ArraySegment<byte> segment = frame.Body;
            byte[] body = segment.Array ?? Array.Empty<byte>();
            int offset = segment.Offset;
            int count = segment.Count;
            uint first = frame.Header.Length > 0 ? frame.Header[0] : 0;
            switch (type)
            {
                case ServerFrameType.JoinSuccess:
                    JoinSuccess(first, frame.Header.Length > 1 ? frame.Header[1] : 0, body, offset, count);
                    return;
                case ServerFrameType.JoinError:
                {
                    (string code, string message) = ErrorBody(body, offset, count);
                    Settle(first, Result<BungohanRoom>.Fail(
                        new ProtocolError(ClientErrorCodes.FromJoinError(code), message)));
                    return;
                }
                case ServerFrameType.Pong:
                    Pong(first);
                    return;
                case ServerFrameType.Error when first == 0:
                {
                    (string code, string message) = ErrorBody(body, offset, count);
                    Raise(ErrorReceived, new ClientError(ClientErrorCodes.ServerError,
                        code + ": " + message, code));
                    return;
                }
            }
            if (!_byRef.TryGetValue(first, out BungohanRoom room))
            {
                // Normally the LEAVE(1000) acknowledging our own LEAVE (§7.1):
                // dropped silently, not a compatibility drop.
                return;
            }
            room.Receive(type, frame.Header, body, offset, count);
            if (type == ServerFrameType.StateSnapshot) Joined(room);
        }

        /// <summary>A room's snapshot arrived: complete its pending join, if any.</summary>
        private void Joined(BungohanRoom room)
        {
            if (room.Status != RoomStatus.Left)
            {
                foreach (KeyValuePair<uint, PendingJoin> entry in new List<KeyValuePair<uint, PendingJoin>>(_pending))
                {
                    if (entry.Value.Room != room) continue;
                    // Completing runs the awaiting code inline, so it has
                    // registered its handlers before the held frames below.
                    Settle(entry.Key, Result<BungohanRoom>.Ok(room));
                    break;
                }
            }
            room.ReleaseHeld();
        }

        /// <summary><c>[code, message]</c>, reading only the known elements (§9.1).</summary>
        private (string, string) ErrorBody(byte[] body, int offset, int count)
        {
            Result<object?> decoded = MessagePack.Decode(body, offset, count);
            if (decoded.IsOk && decoded.Value is List<object?> array && array.Count >= 2)
            {
                return (array[0] as string ?? "", array[1] as string ?? "");
            }
            return (ClientErrorCodes.InvalidMessage, "malformed error body");
        }

        // --- connection lifecycle ------------------------------------------

        private void Open()
        {
            var binding = new SocketBinding(this);
            Result<IClientSocket> opened = _transport.Open(_url, new[] { BungohanProtocol.Version }, binding);
            if (!opened.IsOk)
            {
                FailedAttempt(new ClientError(opened.Error!.Code, opened.Error.Message));
                return;
            }
            binding.Socket = opened.Value;
            _connection = binding;
        }

        private void Opened(SocketBinding connection)
        {
            if (connection != _connection) return;
            connection.Open = true;
            bool reconnecting = State == ConnectionState.Reconnecting;
            State = ConnectionState.Connected;
            _attempt = 0;
            _nextPingAt = _pingIntervalMs > 0 ? _now() + _pingIntervalMs : double.PositiveInfinity;
            foreach (TaskCompletionSource<Result> waiting in _connecting.ToArray())
            {
                waiting.TrySetResult(Result.Ok());
            }
            _connecting.Clear();
            if (!reconnecting) return;
            Raise(Reconnected);
            // Resume every held seat with its current token (§7.3).
            foreach (BungohanRoom room in _resuming.ToArray())
            {
                _resuming.Remove(room);
                string? token = room.ReconnectionToken;
                if (token == null)
                {
                    room.MarkLeft(LeaveCode.Disconnected);
                    continue;
                }
                Request(room, JoinMode.Reconnect, token, null, room.Id, true);
            }
        }

        /// <summary>The connection closed, or never opened.</summary>
        private void Lost(SocketBinding connection, int code, string reason)
        {
            if (connection != _connection) return;
            _connection = null;
            _nextPingAt = double.PositiveInfinity;
            bool wasOpen = connection.Open;
            connection.Open = false;

            // Joins in flight on this connection can't complete. Resumes go
            // back to waiting and are retried on the next connection.
            foreach (KeyValuePair<uint, PendingJoin> entry in new List<KeyValuePair<uint, PendingJoin>>(_pending))
            {
                if (entry.Value.Resume)
                {
                    _pending.Remove(entry.Key);
                    _resuming.Add(entry.Value.Room);
                    entry.Value.Room.Suspend();
                    entry.Value.Waiting.TrySetResult(Result<BungohanRoom>.Fail(
                        ClientErrorCodes.ConnectionLost, "connection closed"));
                }
                else
                {
                    Settle(entry.Key, Result<BungohanRoom>.Fail(
                        ClientErrorCodes.ConnectionLost, "connection closed"));
                }
            }

            if (State == ConnectionState.Connecting)
            {
                // A first connect that never opened: report it, don't retry.
                SetDisconnected(new ClientError(ClientErrorCodes.ConnectionFailed,
                    "closed with " + code + " " + reason));
                return;
            }

            bool terminal = code == CloseCode.ProtocolError || code == CloseCode.PolicyViolation ||
                (code == CloseCode.Normal && wasOpen);
            if (terminal || !_reconnection.Enabled)
            {
                ClientError error = code == CloseCode.ProtocolError
                    ? new ClientError(ClientErrorCodes.ProtocolError,
                        reason.Length > 0 ? reason : "protocol version mismatch")
                    : new ClientError(
                        wasOpen ? ClientErrorCodes.ConnectionLost : ClientErrorCodes.ConnectionFailed,
                        "connection closed (" + code + (reason.Length > 0 ? ": " + reason : "") + ")");
                SetDisconnected(error);
                if (code == CloseCode.ProtocolError) Raise(ErrorReceived, error);
                if (wasOpen) Raise(Disconnected);
                return;
            }

            // Unexpected: keep every seat that has a token and try again.
            foreach (BungohanRoom room in new List<BungohanRoom>(_byRef.Values))
            {
                _byRef.Remove(room.RoomRef);
                if (room.Status == RoomStatus.Joining)
                {
                    // Seated but never joined (no snapshot): nothing to resume.
                    room.MarkLeft(LeaveCode.Disconnected);
                    continue;
                }
                room.Suspend();
                _resuming.Add(room);
            }
            State = ConnectionState.Reconnecting;
            if (wasOpen) Raise(Disconnected);
            FailedAttempt(new ClientError(ClientErrorCodes.ConnectionFailed, "closed with " + code));
        }

        /// <summary>Schedules the next attempt, or gives up after <c>MaxAttempts</c>.</summary>
        private void FailedAttempt(ClientError error)
        {
            if (State == ConnectionState.Connecting)
            {
                SetDisconnected(error);
                return;
            }
            State = ConnectionState.Reconnecting;
            if (_attempt >= _reconnection.MaxAttempts)
            {
                var failed = new ClientError(ClientErrorCodes.ReconnectionFailed,
                    "gave up after " + _attempt + " reconnection attempts");
                SetDisconnected(failed);
                Raise(ErrorReceived, failed);
                return;
            }
            double wait = Math.Min(_reconnection.DelayMs * Math.Pow(_reconnection.Factor, _attempt),
                _reconnection.DelayMaxMs);
            _attempt++;
            _retryAt = _now() + wait;
        }

        /// <summary>Ends everything: rooms left, pending joins and connects failed.</summary>
        private void SetDisconnected(ClientError error)
        {
            State = ConnectionState.Disconnected;
            _attempt = 0;
            _retryAt = double.PositiveInfinity;
            _nextPingAt = double.PositiveInfinity;
            foreach (uint requestId in new List<uint>(_pending.Keys))
            {
                Settle(requestId, Result<BungohanRoom>.Fail(new ProtocolError(error.Code, error.Message)));
            }
            var rooms = new List<BungohanRoom>(_byRef.Values);
            rooms.AddRange(_resuming);
            _byRef.Clear();
            _resuming.Clear();
            foreach (BungohanRoom room in rooms) room.MarkLeft(LeaveCode.Disconnected);
            foreach (TaskCompletionSource<Result> waiting in _connecting.ToArray())
            {
                waiting.TrySetResult(Result.Fail(new ProtocolError(error.Code, error.Message)));
            }
            _connecting.Clear();
        }

        // --- ping ----------------------------------------------------------

        private void SendPing(double now)
        {
            uint nonce = _nextNonce;
            _nextNonce = nonce >= MaxVarint ? 1 : nonce + 1;
            // rtt: whole ms, sub-ms rounds up to 1, 0 = none yet (§5.1).
            uint rtt = Latency.HasValue
                ? (uint)Math.Min(MaxVarint, Math.Max(1, Math.Ceiling(Latency.Value)))
                : 0;
            if (!SendFrame(ClientFrameType.Ping, new[] { nonce, rtt }, null).IsOk) return;
            _pingNonce = nonce;
            _pingSentAt = now;
        }

        private void Pong(uint nonce)
        {
            if (_pingNonce == 0 || _pingNonce != nonce) return;
            _pingNonce = 0;
            Latency = _now() - _pingSentAt;
        }

        // --- IRoomHost -----------------------------------------------------

        void IRoomHost.Forget(BungohanRoom room)
        {
            if (_byRef.TryGetValue(room.RoomRef, out BungohanRoom seated) && seated == room)
            {
                _byRef.Remove(room.RoomRef);
            }
            _resuming.Remove(room);
            foreach (KeyValuePair<uint, PendingJoin> entry in new List<KeyValuePair<uint, PendingJoin>>(_pending))
            {
                if (entry.Value.Room == room && !entry.Value.Resume)
                {
                    Settle(entry.Key, Result<BungohanRoom>.Fail(ClientErrorCodes.Left,
                        "left before the join completed"));
                }
            }
        }

        /// <summary>
        /// The replica no longer matches the server's (§11.10). Protocol v1
        /// has no "send me a snapshot" frame, so re-sync through
        /// reconnection: drop the connection, resume every seat with its
        /// token, and each room gets a fresh snapshot.
        /// </summary>
        void IRoomHost.Desync(BungohanRoom room, ClientError error)
        {
            LogError("state desync in room " + room.Id + "; re-syncing: " + error.Message);
            SocketBinding? connection = _connection;
            if (connection == null) return;
            Lost(connection, ResyncClose, "desync");
            connection.Socket?.Close(ResyncClose, "desync");
        }

        void IRoomHost.Defer(Action action) => _inbox.Enqueue(action);

        void IRoomHost.Warn(string message) => Warn(message);

        void IRoomHost.LogError(string message) => LogError(message);

        void IRoomHost.CountDrop() => DroppedFrames++;

        // --- helpers -------------------------------------------------------

        private void Drop(string reason)
        {
            DroppedFrames++;
            Warn("dropped " + reason);
        }

        private void Warn(string message) => _log("warn", message);

        private void LogError(string message) => _log("error", message);

        private void Raise(Action? action)
        {
            if (action == null) return;
            try
            {
                action();
            }
            catch (Exception error)
            {
                LogError("client listener threw: " + error.Message);
            }
        }

        private void Raise(Action<ClientError>? action, ClientError error)
        {
            if (action == null) return;
            try
            {
                action(error);
            }
            catch (Exception thrown)
            {
                LogError("client listener threw: " + thrown.Message);
            }
        }

        /// <summary>Appends <c>?token=</c>, keeping any query the URL has (§2.1).</summary>
        private static string WithToken(string url, string? token)
        {
            if (token == null) return url;
            int hash = url.IndexOf('#');
            string basePart = hash < 0 ? url : url.Substring(0, hash);
            string fragment = hash < 0 ? "" : url.Substring(hash);
            string separator = basePart.IndexOf('?') >= 0 ? "&" : "?";
            return basePart + separator + "token=" + Uri.EscapeDataString(token) + fragment;
        }

        private sealed class PendingJoin
        {
            public PendingJoin(BungohanRoom room, string? roomId, bool resume,
                TaskCompletionSource<Result<BungohanRoom>> waiting, double deadlineMs)
            {
                Room = room;
                RoomId = roomId;
                Resume = resume;
                Waiting = waiting;
                DeadlineMs = deadlineMs;
            }

            public BungohanRoom Room { get; }

            /// <summary>Set for resumes: the room id the token must belong to.</summary>
            public string? RoomId { get; }

            public bool Resume { get; }
            public TaskCompletionSource<Result<BungohanRoom>> Waiting { get; }
            public double DeadlineMs { get; }
        }

        /// <summary>
        /// One connection. The transport may report through it from any
        /// thread, so everything is queued and run in <see cref="Poll"/>.
        /// </summary>
        private sealed class SocketBinding : IClientSocketHandlers
        {
            private readonly BungohanClient _client;

            public SocketBinding(BungohanClient client)
            {
                _client = client;
            }

            public IClientSocket? Socket { get; set; }
            public bool Open { get; set; }

            public void OnOpen(string protocol) => _client._inbox.Enqueue(() => _client.Opened(this));

            public void OnMessage(byte[] data) => _client._inbox.Enqueue(() => _client.Receive(this, data));

            public void OnClose(int code, string reason) =>
                _client._inbox.Enqueue(() => _client.Lost(this, code, reason));
        }
    }
}
