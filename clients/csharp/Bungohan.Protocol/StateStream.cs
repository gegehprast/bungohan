using System;
using System.Collections.Generic;

namespace Bungohan.Protocol
{
    /// <summary>
    /// A room's state as a receiver sees it: decodes <c>STATE_SNAPSHOT</c> and
    /// <c>STATE_PATCH</c> bodies with the room's codec and applies them to a
    /// replica rooted at <typeparamref name="TRoot"/>.
    ///
    /// Every snapshot starts a new stream (§11.9): a new codec session, a new
    /// decoder and a new root object. Hold on to the stream, not to
    /// <see cref="State"/>, and attach listeners in <see cref="Replaced"/>,
    /// which fires before the snapshot is applied, so its content arrives
    /// through them.
    /// </summary>
    public sealed class StateStream<TRoot> where TRoot : Schema, new()
    {
        private readonly IStateCodec _codec;
        private readonly SchemaRegistry _registry;
        private IStateCodecSession? _session;
        private StateDecoder? _decoder;

        public StateStream(IStateCodec codec, SchemaRegistry registry)
        {
            _codec = codec;
            _registry = registry;
        }

        /// <summary>The replica; null before the first snapshot.</summary>
        public TRoot? State { get; private set; }

        /// <summary>The class table of the current stream.</summary>
        public ClassTable? Table => _session?.Table;

        /// <summary>A snapshot started a new replica. Fires before its ops apply.</summary>
        public event Action<TRoot>? Replaced;

        /// <summary>An instance of a class this client doesn't have was ignored (§11.7).</summary>
        public event Action<string>? UnknownClass;

        /// <summary>A change listener threw; the replica is unaffected.</summary>
        public event Action<Exception>? ListenerError;

        /// <summary>Applied after every frame, once its listeners have fired.</summary>
        public event Action<TRoot>? Applied;

        public Result ApplySnapshot(byte[] body) => ApplySnapshot(body, 0, body.Length);

        public Result ApplySnapshot(byte[] body, int offset, int count)
        {
            var root = new TRoot();
            _registry.Register(root.Class);
            _session = _codec.CreateSession();
            _decoder = new StateDecoder(root, _registry);
            _decoder.UnknownClass += name => UnknownClass?.Invoke(name);
            _decoder.ListenerError += error => ListenerError?.Invoke(error);
            State = root;
            Replaced?.Invoke(root);
            return Apply(body, offset, count);
        }

        public Result ApplyPatch(byte[] body) => ApplyPatch(body, 0, body.Length);

        /// <summary>A patch before any snapshot is <c>NO_SNAPSHOT</c> (a desync, §11.9).</summary>
        public Result ApplyPatch(byte[] body, int offset, int count)
        {
            if (_decoder == null) return Result.Fail(ErrorCodes.NoSnapshot, "STATE_PATCH before the first STATE_SNAPSHOT");
            return Apply(body, offset, count);
        }

        private Result Apply(byte[] body, int offset, int count)
        {
            Result<List<WireOp>> ops = _session!.DecodeOps(body, offset, count);
            if (!ops.IsOk) return Result.Fail(ops.Error!);
            Result applied = _decoder!.Apply(ops.Value);
            if (applied.IsOk && State != null) Applied?.Invoke(State);
            return applied;
        }
    }
}
