using System;
using System.Collections.Generic;

namespace Bungohan.Protocol
{
    /// <summary>What a room needs from the client that owns it.</summary>
    internal interface IRoomHost
    {
        Result SendFrame(byte type, uint[] header, byte[]? body);

        /// <summary>The room is gone locally (left, kicked, …).</summary>
        void Forget(BungohanRoom room);

        /// <summary>The replica no longer matches the server's (§11.10).</summary>
        void Desync(BungohanRoom room, ClientError error);

        /// <summary>Runs <paramref name="action"/> on the next <c>Poll()</c>.</summary>
        void Defer(Action action);

        void Warn(string message);

        void LogError(string message);

        /// <summary>A frame was dropped under the §9.2 rules.</summary>
        void CountDrop();
    }

    /// <summary>
    /// Runtime inputs to a join: what the replica is built from, and what
    /// the room's incoming messages are declared as. Generated bindings
    /// supply all of it:
    ///
    /// <code>
    /// var settings = new JoinSettings {
    ///     ContractHash = InteropContract.Hash,
    ///     ServerMessages = InteropContract.ServerMessages,
    ///     Registry = Schemas.CreateRegistry(),
    ///     CreateState = () => new Interop_State(),
    /// };
    /// </code>
    /// </summary>
    public sealed class JoinSettings
    {
        /// <summary>
        /// The contract hash this client was built against, sent in the
        /// <c>JOIN</c> (§6.3). Null skips the check, which is for raw-only
        /// clients and tools.
        /// </summary>
        public string? ContractHash { get; set; }

        /// <summary>Server → client message declarations, by name (§6.5).</summary>
        public IReadOnlyDictionary<string, MessageDef>? ServerMessages { get; set; }

        /// <summary>The classes the replica may instantiate (§11.2).</summary>
        public SchemaRegistry? Registry { get; set; }

        /// <summary>
        /// Builds a fresh replica root. Without it, state frames are still
        /// decoded (so the stream stays in step) but not applied, and
        /// <see cref="BungohanRoom.State"/> stays null.
        /// </summary>
        public Func<Schema>? CreateState { get; set; }
    }

    /// <summary>
    /// One joined room, client side (PROTOCOL.md §6, §7, §11). Frames reach
    /// it already parsed and routed by <c>roomRef</c>; every event it
    /// raises is raised from <see cref="BungohanClient.Poll"/>, on the
    /// thread that called it.
    /// </summary>
    public sealed class BungohanRoom
    {
        /// <summary>At most this many unclaimed pre-join events are kept.</summary>
        private const int MaxUnclaimed = 64;

        private readonly IRoomHost _host;
        private readonly JoinSettings _settings;
        private readonly Dictionary<string, List<Action<MsgMap>>> _handlers =
            new Dictionary<string, List<Action<MsgMap>>>();
        private readonly List<Unclaimed> _unclaimed = new List<Unclaimed>();

        private IStateCodec? _codec;
        private IStateCodecSession? _session;
        private StateDecoder? _decoder;
        private Dictionary<string, uint> _clientIds = new Dictionary<string, uint>();
        private string[] _serverNames = Array.Empty<string>();
        private List<Held>? _held;
        private bool _releasing;
        private int _snapshots;
        private Action<string, MsgMap>? _message;
        private Action<string, object?>? _raw;
        private Action<string, string>? _error;
        private Action<string>? _clientJoined;
        private Action<string>? _clientLeft;

        internal BungohanRoom(IRoomHost host, JoinSettings settings)
        {
            _host = host;
            _settings = settings;
        }

        public string Id { get; private set; } = "";
        public string RoomType { get; private set; } = "";
        public string SessionId { get; private set; } = "";

        /// <summary>Replaced on every join and resume; keep the newest (§6.4).</summary>
        public string? ReconnectionToken { get; private set; }

        /// <summary>The room type's contract hash, from the handshake.</summary>
        public string ContractHash { get; private set; } = "";

        /// <summary>The codec named in the handshake: <c>schema</c> or <c>messagepack</c>.</summary>
        public string StateCodecName { get; private set; } = "";

        public RoomStatus Status { get; private set; } = RoomStatus.Joining;

        /// <summary>This seat's handle on the current connection (§3.1).</summary>
        public uint RoomRef { get; private set; }

        /// <summary>
        /// The replica. A <b>new object</b> after every snapshot (a join, a
        /// resume, or the server replacing its state): keep the room, not
        /// the state, and re-attach listeners in <see cref="StateReplaced"/>.
        /// </summary>
        public Schema? State { get; private set; }

        /// <summary>The replica as <typeparamref name="T"/>, or null.</summary>
        public T? StateAs<T>() where T : Schema => State as T;

        /// <summary>Snapshots applied; 1 once the join completed.</summary>
        public int Snapshots => _snapshots;

        // The events a room can receive before its caller holds it (a
        // message sent in the server's onJoin, …) claim what was kept for
        // them when subscribed, like OnMessage: a plain field-like event
        // couldn't (§7.5, the unclaimed-event rule).

        /// <summary>
        /// A contract message arrived: its name and decoded payload. The
        /// first subscriber also receives the pre-join messages nobody had
        /// claimed, on the next <c>Poll()</c>.
        /// </summary>
        public event Action<string, MsgMap>? Message
        {
            add => Subscribe(ref _message, value, EventKind.Message);
            remove => _message -= value;
        }

        /// <summary>An untyped message (<c>ROOM_MESSAGE_RAW</c>); claims like <see cref="Message"/>.</summary>
        public event Action<string, object?>? RawMessage
        {
            add => Subscribe(ref _raw, value, EventKind.Raw);
            remove => _raw -= value;
        }

        /// <summary>A fresh replica; raised <b>before</b> its snapshot applies.</summary>
        public event Action<Schema>? StateReplaced;

        /// <summary>After every applied state frame.</summary>
        public event Action<Schema>? StateChanged;

        /// <summary>The room was left; the argument is a <see cref="LeaveCode"/>.</summary>
        public event Action<int>? Left;

        /// <summary>An <c>ERROR</c> frame for this room, or a local failure; claims like <see cref="Message"/>.</summary>
        public event Action<string, string>? ErrorReceived
        {
            add => Subscribe(ref _error, value, EventKind.Error);
            remove => _error -= value;
        }

        /// <summary>Another seat joined; claims like <see cref="Message"/>.</summary>
        public event Action<string>? ClientJoined
        {
            add => Subscribe(ref _clientJoined, value, EventKind.ClientJoined);
            remove => _clientJoined -= value;
        }

        /// <summary>Another seat left; claims like <see cref="Message"/>.</summary>
        public event Action<string>? ClientLeft
        {
            add => Subscribe(ref _clientLeft, value, EventKind.ClientLeft);
            remove => _clientLeft -= value;
        }

        // --- sending -------------------------------------------------------

        /// <summary>
        /// Sends a generated contract message. Its id comes from the
        /// handshake's <c>clientMessages</c> table, resolved by name (§6.5).
        /// </summary>
        public Result Send(IContractMessage message)
        {
            MessageDef def = message.MessageDefinition;
            return Send(def, message.ToPayload());
        }

        /// <summary>Sends a contract message from its declaration and payload.</summary>
        public Result Send(MessageDef def, MsgMap payload)
        {
            Result usable = Usable();
            if (!usable.IsOk) return usable;
            if (!_clientIds.TryGetValue(def.Name, out uint id))
            {
                return Result.Fail(ClientErrorCodes.UnknownMessage,
                    "\"" + def.Name + "\" is not a client message of this room");
            }
            IStateCodec? codec = _codec;
            if (codec == null) return Result.Fail(ClientErrorCodes.NotJoined, "the room has no codec yet");
            Result<byte[]> body = codec.EncodeMessage(def, payload);
            if (!body.IsOk) return Result.Fail(body.Error!);
            return _host.SendFrame(ClientFrameType.RoomMessage, new[] { RoomRef, id }, body.Value);
        }

        /// <summary>Sends an untyped MessagePack message (the server's raw handlers).</summary>
        public Result SendRaw(string type, object? payload)
        {
            Result usable = Usable();
            if (!usable.IsOk) return usable;
            Result<byte[]> body = MessagePack.Encode(new List<object?> { type, payload });
            if (!body.IsOk) return Result.Fail(body.Error!);
            return _host.SendFrame(ClientFrameType.RoomMessageRaw, new[] { RoomRef }, body.Value);
        }

        /// <summary>
        /// Leaves the room (a consented <c>LEAVE</c>, §7.1) and drops every
        /// listener. The server's acknowledgement is not waited for; the
        /// seat counts as left at once.
        /// </summary>
        public Result Leave()
        {
            if (Status == RoomStatus.Left) return Result.Fail(ClientErrorCodes.NotJoined, "already left");
            // While reconnecting there is no connection to send it on, and
            // the seat is simply not resumed.
            if (Status != RoomStatus.Reconnecting && RoomRef != 0)
            {
                _host.SendFrame(ClientFrameType.Leave, new[] { RoomRef }, null);
            }
            MarkLeft(LeaveCode.Consented);
            return Result.Ok();
        }

        // --- listeners -----------------------------------------------------

        /// <summary>
        /// Handles one contract message by name. Convert the payload with
        /// the generated <c>FromPayload</c>, or use the typed overload.
        /// </summary>
        public void OnMessage(string name, Action<MsgMap> handler)
        {
            if (!_handlers.TryGetValue(name, out List<Action<MsgMap>> list))
            {
                list = new List<Action<MsgMap>>();
                _handlers[name] = list;
            }
            list.Add(handler);
            Claim(e => e.Kind == EventKind.Message && e.Name == name);
        }

        /// <summary>
        /// Handles one contract message, converted by the generated
        /// <c>FromPayload</c>:
        /// <code>room.OnMessage("welcome", WelcomeMessage.FromPayload, m => …);</code>
        /// </summary>
        public void OnMessage<T>(string name, Func<MsgMap, T> fromPayload, Action<T> handler) =>
            OnMessage(name, payload => handler(fromPayload(payload)));

        /// <summary>Drops every listener; done automatically when the room is left.</summary>
        public void RemoveAllListeners()
        {
            _handlers.Clear();
            _unclaimed.Clear();
            _message = null;
            _raw = null;
            StateReplaced = null;
            StateChanged = null;
            Left = null;
            _error = null;
            _clientJoined = null;
            _clientLeft = null;
        }

        // --- driven by the client ------------------------------------------

        /// <summary>The contract hash to send in this room's JOIN frames.</summary>
        internal string? Hash => _settings.ContractHash;

        /// <summary>Adopts a <c>JOIN_SUCCESS</c> handshake (a join or a resume).</summary>
        internal void Bind(uint roomRef, JoinHandshake handshake, IStateCodec codec)
        {
            _codec = codec;
            RoomRef = roomRef;
            Id = handshake.RoomId;
            RoomType = handshake.RoomType;
            SessionId = handshake.SessionId;
            ReconnectionToken = handshake.ReconnectionToken;
            ContractHash = handshake.ContractHash;
            StateCodecName = handshake.StateCodec;
            _clientIds = new Dictionary<string, uint>();
            for (int i = 0; i < handshake.ClientMessages.Length; i++)
            {
                _clientIds[handshake.ClientMessages[i]] = (uint)i;
            }
            _serverNames = handshake.ServerMessages;
            // A first join holds its frames; a resumed seat already has
            // its handlers and holds nothing.
            if (_snapshots == 0) _held = new List<Held>();
            // Nothing may be decoded against the old stream: the next state
            // frame is a snapshot, which starts a new session.
            _session = null;
            if (Status == RoomStatus.Reconnecting) Status = RoomStatus.Joining;
        }

        /// <summary>The connection dropped; the seat will be resumed (§7.2).</summary>
        internal void Suspend()
        {
            if (Status != RoomStatus.Left) Status = RoomStatus.Reconnecting;
        }

        /// <summary>
        /// Handles one frame for this room. On a first join, messages can
        /// arrive between <c>JOIN_SUCCESS</c> and the snapshot (§6.1),
        /// before the caller holds the room. Those are held, in order, and
        /// released once the join has been handed over.
        /// </summary>
        internal void Receive(byte type, uint[] header, byte[] body, int offset, int count)
        {
            List<Held>? held = _held;
            if (held != null)
            {
                bool first = _snapshots == 0 &&
                    (type == ServerFrameType.StateSnapshot || type == ServerFrameType.Leave);
                if (!first)
                {
                    held.Add(new Held(type, header, Copy(body, offset, count)));
                    return;
                }
            }
            Handle(type, header, body, offset, count);
        }

        /// <summary>Handles the frames held during a first join, in order.</summary>
        internal void ReleaseHeld()
        {
            List<Held>? held = _held;
            if (held == null) return;
            _held = null;
            _releasing = true;
            try
            {
                foreach (Held frame in held)
                {
                    if (Status == RoomStatus.Left) return;
                    Handle(frame.Type, frame.Header, frame.Body, 0, frame.Body.Length);
                }
            }
            finally
            {
                _releasing = false;
            }
        }

        /// <summary>
        /// The room is over locally: raises <see cref="Left"/>, then drops
        /// every listener (spec §7.2) and tells the client to forget it.
        /// </summary>
        internal void MarkLeft(int code)
        {
            if (Status == RoomStatus.Left) return;
            Status = RoomStatus.Left;
            _held = null;
            _host.Forget(this);
            Raise(() => Left?.Invoke(code));
            RemoveAllListeners();
        }

        /// <summary>Reports an error on this room.</summary>
        internal void Fail(string code, string message) =>
            Raise(() => _error?.Invoke(code, message));

        // --- internals -----------------------------------------------------

        private Result Usable()
        {
            switch (Status)
            {
                case RoomStatus.Left: return Result.Fail(ClientErrorCodes.NotJoined, "the room has been left");
                case RoomStatus.Reconnecting: return Result.Fail(ClientErrorCodes.NotConnected, "reconnecting");
                default: return Result.Ok();
            }
        }

        private void Handle(byte type, uint[] header, byte[] body, int offset, int count)
        {
            switch (type)
            {
                case ServerFrameType.StateSnapshot:
                    Snapshot(body, offset, count);
                    return;
                case ServerFrameType.StatePatch:
                    Patch(body, offset, count);
                    return;
                case ServerFrameType.RoomMessage:
                    Contract(header.Length > 1 ? header[1] : uint.MaxValue, body, offset, count);
                    return;
                case ServerFrameType.RoomMessageRaw:
                {
                    List<object?>? array = DecodeArray(body, offset, count, 2, "ROOM_MESSAGE_RAW");
                    if (array == null) return;
                    if (!(array[0] is string name))
                    {
                        Drop("raw message: type is not a string");
                        return;
                    }
                    Offer(Unclaimed.Raw(name, array[1]));
                    return;
                }
                case ServerFrameType.ClientJoined:
                case ServerFrameType.ClientLeft:
                {
                    object? decoded = Decode(body, offset, count);
                    if (!(decoded is string sessionId))
                    {
                        Drop("frame " + type + ": sessionId is not a string");
                        return;
                    }
                    Offer(type == ServerFrameType.ClientJoined
                        ? Unclaimed.Joined(sessionId)
                        : Unclaimed.LeftSeat(sessionId));
                    return;
                }
                case ServerFrameType.Leave:
                    // No frame for this roomRef follows a LEAVE (§7.1).
                    MarkLeft(header.Length > 1 ? (int)header[1] : LeaveCode.Kicked);
                    return;
                case ServerFrameType.Error:
                {
                    List<object?>? array = DecodeArray(body, offset, count, 2, "ERROR");
                    if (array == null) return;
                    Offer(Unclaimed.Error(Text(array[0]), Text(array[1])));
                    return;
                }
                default:
                    Drop("frame " + type + ": not a room frame");
                    return;
            }
        }

        /// <summary>Every snapshot starts a fresh stream: new session, new replica (§11.9).</summary>
        private void Snapshot(byte[] body, int offset, int count)
        {
            IStateCodec? codec = _codec;
            if (codec == null)
            {
                Desync(new ClientError(ClientErrorCodes.Desync, "STATE_SNAPSHOT before the join"));
                return;
            }
            _session = codec.CreateSession();
            _snapshots++;
            if (Status == RoomStatus.Joining) Status = RoomStatus.Joined;
            Func<Schema>? create = _settings.CreateState;
            if (create == null)
            {
                State = null;
                _decoder = null;
            }
            else
            {
                Schema root = create();
                SchemaRegistry registry = _settings.Registry ?? new SchemaRegistry();
                registry.Register(root.Class);
                var decoder = new StateDecoder(root, registry);
                decoder.UnknownClass += UnknownClass;
                decoder.ListenerError += error => _host.LogError("state listener threw: " + error.Message);
                _decoder = decoder;
                State = root;
                Raise(() => StateReplaced?.Invoke(root));
            }
            ApplyState(body, offset, count);
        }

        private void Patch(byte[] body, int offset, int count)
        {
            if (_session == null)
            {
                Desync(new ClientError(ClientErrorCodes.Desync, "STATE_PATCH before a snapshot"));
                return;
            }
            ApplyState(body, offset, count);
        }

        private void ApplyState(byte[] body, int offset, int count)
        {
            IStateCodecSession? session = _session;
            if (session == null) return;
            Result<List<WireOp>> ops = session.DecodeOps(body, offset, count);
            if (!ops.IsOk)
            {
                Desync(new ClientError(ClientErrorCodes.Desync, ops.Error!.Message));
                return;
            }
            StateDecoder? decoder = _decoder;
            if (decoder != null)
            {
                Result applied = decoder.Apply(ops.Value);
                if (!applied.IsOk)
                {
                    Desync(new ClientError(ClientErrorCodes.Desync, applied.Error!.Message));
                    return;
                }
            }
            Schema? state = State;
            if (state != null) Raise(() => StateChanged?.Invoke(state));
        }

        /// <summary>
        /// An instance of a class this client has none registered for was
        /// left out of the replica (§11.7). Loud: the replica now lacks
        /// data, but it is not a desync, so nothing is re-synchronized.
        /// </summary>
        private void UnknownClass(string name)
        {
            string message = "the server sent \"" + name + "\", a schema class this client has not " +
                "registered; its instances are missing from room.State. Register it through " +
                "JoinSettings.Registry (the generated Schemas.CreateRegistry() has every class)";
            _host.LogError("room " + RoomType + ": " + message);
            Offer(Unclaimed.Error(ClientErrorCodes.UnknownClass, message));
        }

        private void Desync(ClientError error)
        {
            _session = null;
            Fail(error.Code, error.Message);
            _host.Desync(this, error);
        }

        private void Contract(uint id, byte[] body, int offset, int count)
        {
            // Ids resolve by name through the handshake's table (§6.5); an
            // id or a name this client can't map is dropped, not fatal.
            if (id >= (uint)_serverNames.Length)
            {
                Drop("message: unknown message id " + id);
                return;
            }
            string name = _serverNames[id];
            IReadOnlyDictionary<string, MessageDef>? table = _settings.ServerMessages;
            MessageDef? def = null;
            if (table != null && table.TryGetValue(name, out MessageDef found)) def = found;
            if (def == null)
            {
                Drop("message \"" + name + "\": no declaration in this client's contract");
                return;
            }
            IStateCodec? codec = _codec;
            if (codec == null)
            {
                Drop("message \"" + name + "\": the room has no codec yet");
                return;
            }
            Result<MsgMap> payload = codec.DecodeMessage(def, body, offset, count);
            if (!payload.IsOk)
            {
                Drop("message \"" + name + "\": " + payload.Error!.Message);
                return;
            }
            Offer(Unclaimed.Contract(name, payload.Value));
        }

        /// <summary>
        /// Delivers an event to its listeners. With none, a pre-join event
        /// is kept for a handler registered later.
        /// </summary>
        private void Offer(Unclaimed e)
        {
            if (Dispatch(e)) return;
            if (_held != null || _releasing)
            {
                _unclaimed.Add(e);
                if (_unclaimed.Count > MaxUnclaimed) _unclaimed.RemoveAt(0);
            }
            else if (e.Kind == EventKind.Message)
            {
                _host.Warn("no handler for message \"" + e.Name + "\"");
            }
        }

        /// <summary>False if the event found no listener.</summary>
        private bool Dispatch(Unclaimed e)
        {
            switch (e.Kind)
            {
                case EventKind.Message:
                {
                    bool handled = false;
                    if (_handlers.TryGetValue(e.Name, out List<Action<MsgMap>> list) && list.Count > 0)
                    {
                        handled = true;
                        foreach (Action<MsgMap> handler in list.ToArray())
                        {
                            Raise(() => handler(e.Payload!));
                        }
                    }
                    Action<string, MsgMap>? all = _message;
                    if (all != null)
                    {
                        handled = true;
                        Raise(() => all(e.Name, e.Payload!));
                    }
                    return handled;
                }
                case EventKind.Raw:
                {
                    Action<string, object?>? raw = _raw;
                    if (raw == null) return false;
                    Raise(() => raw(e.Name, e.Value));
                    return true;
                }
                case EventKind.ClientJoined:
                {
                    Action<string>? joined = _clientJoined;
                    if (joined == null) return false;
                    Raise(() => joined(e.Name));
                    return true;
                }
                case EventKind.ClientLeft:
                {
                    Action<string>? left = _clientLeft;
                    if (left == null) return false;
                    Raise(() => left(e.Name));
                    return true;
                }
                default:
                {
                    Action<string, string>? error = _error;
                    if (error == null) return false;
                    Raise(() => error(e.Name, e.Value as string ?? ""));
                    return true;
                }
            }
        }

        /// <summary>Adds a listener to one of the claiming events.</summary>
        private void Subscribe<T>(ref T? field, T? handler, EventKind kind) where T : Delegate
        {
            if (handler == null) return;
            field = (T?)Delegate.Combine(field, handler);
            Claim(e => e.Kind == kind);
        }

        /// <summary>A handler was registered: hand it the kept events it takes, later.</summary>
        private void Claim(Func<Unclaimed, bool> takes)
        {
            if (_unclaimed.Count == 0) return;
            var claimed = new List<Unclaimed>();
            for (int i = _unclaimed.Count - 1; i >= 0; i--)
            {
                if (!takes(_unclaimed[i])) continue;
                claimed.Insert(0, _unclaimed[i]);
                _unclaimed.RemoveAt(i);
            }
            if (claimed.Count == 0) return;
            // Not inside the registering call: its caller hasn't returned.
            _host.Defer(() =>
            {
                foreach (Unclaimed e in claimed)
                {
                    if (Status == RoomStatus.Left) return;
                    Dispatch(e);
                }
            });
        }

        private object? Decode(byte[] body, int offset, int count)
        {
            Result<object?> decoded = MessagePack.Decode(body, offset, count);
            if (decoded.IsOk) return decoded.Value;
            Drop("frame body: " + decoded.Error!.Message);
            return null;
        }

        /// <summary>The known leading elements of an array body (§9.1).</summary>
        private List<object?>? DecodeArray(byte[] body, int offset, int count, int required, string what)
        {
            object? value = Decode(body, offset, count);
            if (value is List<object?> array && array.Count >= required) return array;
            if (value != null) Drop(what + ": expected an array of " + required + " or more");
            return null;
        }

        private void Drop(string reason)
        {
            _host.CountDrop();
            _host.Warn("dropped " + reason);
        }

        /// <summary>A listener that throws is logged, never propagated.</summary>
        private void Raise(Action action)
        {
            try
            {
                action();
            }
            catch (Exception error)
            {
                _host.LogError("room listener threw: " + error.Message);
            }
        }

        private static string Text(object? value) => value as string ?? Convert.ToString(value) ?? "";

        private static byte[] Copy(byte[] data, int offset, int count)
        {
            var copy = new byte[count];
            Buffer.BlockCopy(data, offset, copy, 0, count);
            return copy;
        }

        private readonly struct Held
        {
            public Held(byte type, uint[] header, byte[] body)
            {
                Type = type;
                Header = header;
                Body = body;
            }

            public byte Type { get; }
            public uint[] Header { get; }
            public byte[] Body { get; }
        }

        private enum EventKind
        {
            Message,
            Raw,
            ClientJoined,
            ClientLeft,
            Error,
        }

        private readonly struct Unclaimed
        {
            private Unclaimed(EventKind kind, string name, MsgMap? payload, object? value)
            {
                Kind = kind;
                Name = name;
                Payload = payload;
                Value = value;
            }

            public EventKind Kind { get; }

            /// <summary>The message name, session id, or error code.</summary>
            public string Name { get; }

            public MsgMap? Payload { get; }
            public object? Value { get; }

            public static Unclaimed Contract(string name, MsgMap payload) =>
                new Unclaimed(EventKind.Message, name, payload, null);

            public static Unclaimed Raw(string name, object? value) =>
                new Unclaimed(EventKind.Raw, name, null, value);

            public static Unclaimed Joined(string sessionId) =>
                new Unclaimed(EventKind.ClientJoined, sessionId, null, null);

            public static Unclaimed LeftSeat(string sessionId) =>
                new Unclaimed(EventKind.ClientLeft, sessionId, null, null);

            public static Unclaimed Error(string code, string message) =>
                new Unclaimed(EventKind.Error, code, null, message);
        }
    }
}
