using System;
using System.Collections.Generic;

namespace Bungohan.Protocol
{
    /// <summary>The kinds of a contract message field (PROTOCOL.md §10).</summary>
    public enum FieldKind
    {
        Int8,
        Int16,
        Int32,
        UInt8,
        UInt16,
        UInt32,
        Float32,
        Float64,
        Fixed,
        String,
        Bool,
        Enum,
        Array,
        Map,
        Optional,
        Nested,
    }

    /// <summary>
    /// The type of a contract message field. Build with the static members:
    /// <c>FieldType.Fixed(2)</c>, <c>FieldType.ArrayOf(FieldType.String)</c>, ….
    /// </summary>
    public sealed class FieldType
    {
        private FieldType(FieldKind kind, int decimals = 0, object[]? values = null,
            FieldType? of = null, MessageDef? message = null)
        {
            Kind = kind;
            Decimals = decimals;
            EnumValues = values ?? System.Array.Empty<object>();
            Of = of;
            Message = message;
        }

        public FieldKind Kind { get; }

        /// <summary>Decimal places of a <c>fixed:n</c> field.</summary>
        public int Decimals { get; }

        /// <summary>An enum's values (strings or doubles), in index order.</summary>
        public IReadOnlyList<object> EnumValues { get; }

        /// <summary>The element type of an array, map or optional.</summary>
        public FieldType? Of { get; }

        /// <summary>The message of a nested field.</summary>
        public MessageDef? Message { get; }

        public static readonly FieldType Int8 = new FieldType(FieldKind.Int8);
        public static readonly FieldType Int16 = new FieldType(FieldKind.Int16);
        public static readonly FieldType Int32 = new FieldType(FieldKind.Int32);
        public static readonly FieldType UInt8 = new FieldType(FieldKind.UInt8);
        public static readonly FieldType UInt16 = new FieldType(FieldKind.UInt16);
        public static readonly FieldType UInt32 = new FieldType(FieldKind.UInt32);
        public static readonly FieldType Float32 = new FieldType(FieldKind.Float32);
        public static readonly FieldType Float64 = new FieldType(FieldKind.Float64);
        public static readonly FieldType String = new FieldType(FieldKind.String);
        public static readonly FieldType Bool = new FieldType(FieldKind.Bool);

        public static FieldType Fixed(int decimals)
        {
            if (decimals < 0 || decimals > 9) throw new ArgumentOutOfRangeException(nameof(decimals));
            return new FieldType(FieldKind.Fixed, decimals);
        }

        /// <summary>An enum of strings and/or numbers, sent as the value's index.</summary>
        public static FieldType Enum(params object[] values)
        {
            var copy = new object[values.Length];
            for (int i = 0; i < values.Length; i++)
            {
                object value = values[i];
                if (value is string) copy[i] = value;
                else if (Numeric.TryNumber(value, out double number)) copy[i] = number;
                else throw new ArgumentException("enum values are strings or numbers");
            }
            return new FieldType(FieldKind.Enum, values: copy);
        }

        public static FieldType ArrayOf(FieldType of) => new FieldType(FieldKind.Array, of: of);

        public static FieldType MapOf(FieldType of) => new FieldType(FieldKind.Map, of: of);

        public static FieldType OptionalOf(FieldType of) => new FieldType(FieldKind.Optional, of: of);

        public static FieldType NestedOf(MessageDef message) => new FieldType(FieldKind.Nested, message: message);

        /// <summary>The integer kind, if this is an integer field.</summary>
        public bool TryIntKind(out IntKind kind)
        {
            switch (Kind)
            {
                case FieldKind.Int8: kind = IntKind.Int8; return true;
                case FieldKind.Int16: kind = IntKind.Int16; return true;
                case FieldKind.Int32: kind = IntKind.Int32; return true;
                case FieldKind.UInt8: kind = IntKind.UInt8; return true;
                case FieldKind.UInt16: kind = IntKind.UInt16; return true;
                case FieldKind.UInt32: kind = IntKind.UInt32; return true;
                default: kind = IntKind.Int8; return false;
            }
        }

        /// <summary>The index of <paramref name="value"/> among the enum's values, or −1.</summary>
        public int EnumIndexOf(object? value)
        {
            if (value is string s)
            {
                for (int i = 0; i < EnumValues.Count; i++)
                {
                    if (EnumValues[i] is string candidate && candidate == s) return i;
                }
            }
            else if (Numeric.TryNumber(value, out double number))
            {
                for (int i = 0; i < EnumValues.Count; i++)
                {
                    if (EnumValues[i] is double candidate && candidate == number) return i;
                }
            }
            return -1;
        }
    }

    /// <summary>One field of a message: its name and type.</summary>
    public sealed class MessageField
    {
        public MessageField(string name, FieldType type)
        {
            Name = name;
            Type = type;
        }

        public string Name { get; }
        public FieldType Type { get; }
    }

    /// <summary>
    /// A contract message: a name and its fields in declaration (wire)
    /// order. Generated code builds these; so can a hand-written client.
    /// </summary>
    public sealed class MessageDef
    {
        private MessagePlan? _plan;

        public MessageDef(string name, params MessageField[] fields)
        {
            Name = name;
            Fields = fields;
        }

        public string Name { get; }
        public IReadOnlyList<MessageField> Fields { get; }

        /// <summary>The <c>schema</c> codec's flag layout, computed once.</summary>
        internal MessagePlan Plan => _plan ??= new MessagePlan(this);
    }

    /// <summary>Where each field of a message lives under the schema codec (§13.1.6).</summary>
    internal sealed class MessagePlan
    {
        public MessagePlan(MessageDef def)
        {
            int bits = 0;
            Bits = new int[def.Fields.Count];
            ValueBits = new int[def.Fields.Count];
            for (int i = 0; i < def.Fields.Count; i++)
            {
                FieldType type = def.Fields[i].Type;
                Bits[i] = -1;
                ValueBits[i] = -1;
                if (type.Kind == FieldKind.Bool)
                {
                    Bits[i] = bits++;
                }
                else if (type.Kind == FieldKind.Optional)
                {
                    Bits[i] = bits++;
                    if (type.Of!.Kind == FieldKind.Bool) ValueBits[i] = bits++;
                }
            }
            FlagBytes = (bits + 7) / 8;
            int used = bits % 8;
            LastMask = used == 0 ? 0xff : (1 << used) - 1;
        }

        /// <summary>Per field: a bool's value bit, an optional's presence bit, or −1.</summary>
        public int[] Bits { get; }

        /// <summary>Per field: an <c>optional&lt;bool&gt;</c>'s value bit, or −1.</summary>
        public int[] ValueBits { get; }

        public int FlagBytes { get; }

        /// <summary>The used bits of the last flag byte.</summary>
        public int LastMask { get; }
    }
}
