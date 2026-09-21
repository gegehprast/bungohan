using System.Collections.Generic;

namespace Bungohan.Protocol
{
    /// <summary>
    /// Typed join and create options (PROTOCOL.md §6.2.1): each a
    /// <c>schema</c>-encoded message (§13.1.6), whatever the room's codec,
    /// sent in the <c>JOIN</c> body as MessagePack <c>bin</c>, or
    /// <c>null</c> when it encodes to zero bytes. Generated contract
    /// bindings build these (<c>JoinOptions(…)</c>,
    /// <c>CreateOptions(…)</c>) so their parameters are typed; pass the
    /// result as a join's <c>options</c>.
    /// </summary>
    public sealed class TypedOptions
    {
        /// <summary>The message a declaration the contract leaves out stands for.</summary>
        public static readonly MessageDef NoOptions = new MessageDef("noOptions");

        private static readonly SchemaCodec s_schema = new SchemaCodec();

        private readonly MessageDef _joinDefinition;
        private readonly MsgMap? _join;
        private readonly MessageDef _createDefinition;
        private readonly MsgMap? _create;

        /// <summary>
        /// Options from declarations and payloads. A null definition is
        /// <see cref="NoOptions"/>; a null payload is the empty map.
        /// </summary>
        public TypedOptions(MessageDef? joinDefinition, MsgMap? join,
            MessageDef? createDefinition = null, MsgMap? create = null)
        {
            _joinDefinition = joinDefinition ?? NoOptions;
            _join = join;
            _createDefinition = createDefinition ?? NoOptions;
            _create = create;
        }

        /// <summary>Options from generated message classes; null is <see cref="NoOptions"/>.</summary>
        public TypedOptions(IContractMessage? join, IContractMessage? create = null)
            : this(join?.MessageDefinition, join?.ToPayload(), create?.MessageDefinition, create?.ToPayload())
        {
        }

        /// <summary>
        /// The five <c>JOIN</c> body elements (§6.2): the join options in
        /// modes 0–3, the create options only in modes 0 and 1. Modes 4
        /// and 5 ignore options, so they get the body without them.
        /// </summary>
        public Result<List<object?>> Body(int mode, string target, string? contractHash)
        {
            bool creates = mode == JoinMode.JoinOrCreate || mode == JoinMode.Create;
            bool reads = creates || mode == JoinMode.Join || mode == JoinMode.JoinById;
            if (!reads) return Result<List<object?>>.Ok(new List<object?> { (long)mode, target, null, contractHash });
            Result<byte[]?> join = Encode(_joinDefinition, _join);
            if (!join.IsOk) return Result<List<object?>>.Fail(join.Error!);
            byte[]? create = null;
            if (creates)
            {
                Result<byte[]?> encoded = Encode(_createDefinition, _create);
                if (!encoded.IsOk) return Result<List<object?>>.Fail(encoded.Error!);
                create = encoded.Value;
            }
            return Result<List<object?>>.Ok(new List<object?> { (long)mode, target, join.Value, contractHash, create });
        }

        /// <summary>One options element: the encoded message, or null for zero bytes.</summary>
        public static Result<byte[]?> Encode(MessageDef definition, MsgMap? payload)
        {
            Result<byte[]> encoded = s_schema.EncodeMessage(definition, payload ?? new MsgMap());
            if (!encoded.IsOk) return Result<byte[]?>.Fail(encoded.Error!);
            return Result<byte[]?>.Ok(encoded.Value.Length == 0 ? null : encoded.Value);
        }
    }
}
