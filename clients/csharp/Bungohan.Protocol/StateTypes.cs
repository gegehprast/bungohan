using System;

namespace Bungohan.Protocol
{
    /// <summary>The value types of state fields, collection elements and keys.</summary>
    public enum ScalarKind
    {
        Float64,
        Float32,
        Fixed,
        String,
        Bool,
        Int8,
        Int16,
        Int32,
        UInt8,
        UInt16,
        UInt32,
    }

    /// <summary>A primitive, integer or key type: <c>fixed:2</c>, <c>uint16</c>, ….</summary>
    public readonly struct Scalar
    {
        public Scalar(ScalarKind kind, int decimals = 0)
        {
            Kind = kind;
            Decimals = decimals;
        }

        public ScalarKind Kind { get; }
        public int Decimals { get; }

        public bool IsInt => Kind >= ScalarKind.Int8;

        public IntKind IntKind => Kind switch
        {
            ScalarKind.Int8 => Protocol.IntKind.Int8,
            ScalarKind.Int16 => Protocol.IntKind.Int16,
            ScalarKind.Int32 => Protocol.IntKind.Int32,
            ScalarKind.UInt8 => Protocol.IntKind.UInt8,
            ScalarKind.UInt16 => Protocol.IntKind.UInt16,
            _ => Protocol.IntKind.UInt32,
        };

        /// <summary><c>float64</c>, <c>float32</c>, <c>fixed:n</c>, <c>string</c> or <c>bool</c>.</summary>
        public bool IsPrimitive => !IsInt;

        /// <summary><c>string</c>, <c>float64</c> or an integer kind.</summary>
        public bool IsKey => Kind == ScalarKind.String || Kind == ScalarKind.Float64 || IsInt;

        public static bool TryParse(string text, out Scalar scalar)
        {
            switch (text)
            {
                case "float64": scalar = new Scalar(ScalarKind.Float64); return true;
                case "float32": scalar = new Scalar(ScalarKind.Float32); return true;
                case "string": scalar = new Scalar(ScalarKind.String); return true;
                case "bool": scalar = new Scalar(ScalarKind.Bool); return true;
                case "int8": scalar = new Scalar(ScalarKind.Int8); return true;
                case "int16": scalar = new Scalar(ScalarKind.Int16); return true;
                case "int32": scalar = new Scalar(ScalarKind.Int32); return true;
                case "uint8": scalar = new Scalar(ScalarKind.UInt8); return true;
                case "uint16": scalar = new Scalar(ScalarKind.UInt16); return true;
                case "uint32": scalar = new Scalar(ScalarKind.UInt32); return true;
            }
            if (text.Length == 7 && text.StartsWith("fixed:", StringComparison.Ordinal) &&
                text[6] >= '0' && text[6] <= '9')
            {
                scalar = new Scalar(ScalarKind.Fixed, text[6] - '0');
                return true;
            }
            scalar = default;
            return false;
        }
    }

    /// <summary>The shapes a state field type can take (PROTOCOL.md §11.2).</summary>
    public enum StateTypeKind
    {
        /// <summary><c>float64</c>, <c>float32</c>, <c>fixed:n</c>, <c>string</c>, <c>bool</c>.</summary>
        Primitive,

        /// <summary>An integer field: <c>int8</c> … <c>uint32</c>.</summary>
        Int,

        /// <summary><c>schema&lt;N&gt;</c>, a directly nested instance.</summary>
        Schema,

        Map,
        Set,
        Array,
        SchemaMap,
        SchemaSet,
        SchemaArray,
    }

    /// <summary>A parsed state field type, e.g. <c>schemaMap&lt;uint32,Enemy&gt;</c>.</summary>
    public sealed class StateType
    {
        private StateType(string text, StateTypeKind kind, Scalar key, Scalar element, string schema)
        {
            Text = text;
            Kind = kind;
            Key = key;
            Element = element;
            Schema = schema;
        }

        /// <summary>The type string as it appears in a <c>DEFINE</c>.</summary>
        public string Text { get; }

        public StateTypeKind Kind { get; }

        /// <summary>A map's key type.</summary>
        public Scalar Key { get; }

        /// <summary>
        /// A primitive or integer field's type, a primitive collection's
        /// element type, or a set's element (key) type.
        /// </summary>
        public Scalar Element { get; }

        /// <summary>The class name of <c>schema</c> fields and schema collections.</summary>
        public string Schema { get; }

        /// <summary>Collections own a refId (PROTOCOL.md §11.3).</summary>
        public bool IsCollection =>
            Kind != StateTypeKind.Primitive && Kind != StateTypeKind.Int && Kind != StateTypeKind.Schema;

        public bool IsArray => Kind == StateTypeKind.Array || Kind == StateTypeKind.SchemaArray;

        public bool IsSet => Kind == StateTypeKind.Set || Kind == StateTypeKind.SchemaSet;

        public bool IsMap => Kind == StateTypeKind.Map || Kind == StateTypeKind.SchemaMap;

        /// <summary>Elements are schema instances (refs).</summary>
        public bool HoldsSchemas =>
            Kind == StateTypeKind.SchemaMap || Kind == StateTypeKind.SchemaSet || Kind == StateTypeKind.SchemaArray;

        /// <summary>Parses a type string; null if it isn't in the grammar.</summary>
        public static StateType? Parse(string text)
        {
            if (Scalar.TryParse(text, out Scalar scalar))
            {
                var kind = scalar.IsInt ? StateTypeKind.Int : StateTypeKind.Primitive;
                return new StateType(text, kind, default, scalar, "");
            }
            int open = text.IndexOf('<');
            if (open <= 0 || !text.EndsWith(">", StringComparison.Ordinal)) return null;
            string head = text.Substring(0, open);
            string inner = text.Substring(open + 1, text.Length - open - 2);
            int comma = inner.IndexOf(',');
            string key = comma < 0 ? "" : inner.Substring(0, comma);
            string rest = comma < 0 ? "" : inner.Substring(comma + 1);
            switch (head)
            {
                case "schema":
                    return inner.Length == 0 ? null : new StateType(text, StateTypeKind.Schema, default, default, inner);
                case "schemaSet":
                    return inner.Length == 0 ? null : new StateType(text, StateTypeKind.SchemaSet, default, default, inner);
                case "schemaArray":
                    return inner.Length == 0 ? null : new StateType(text, StateTypeKind.SchemaArray, default, default, inner);
                case "set":
                    return Scalar.TryParse(inner, out Scalar setElement) && setElement.IsKey
                        ? new StateType(text, StateTypeKind.Set, default, setElement, "")
                        : null;
                case "array":
                    return Scalar.TryParse(inner, out Scalar arrayElement) && arrayElement.IsPrimitive
                        ? new StateType(text, StateTypeKind.Array, default, arrayElement, "")
                        : null;
                case "map":
                    return comma > 0 && Scalar.TryParse(key, out Scalar mapKey) && mapKey.IsKey &&
                           Scalar.TryParse(rest, out Scalar mapValue) && mapValue.IsPrimitive
                        ? new StateType(text, StateTypeKind.Map, mapKey, mapValue, "")
                        : null;
                case "schemaMap":
                    return comma > 0 && Scalar.TryParse(key, out Scalar schemaKey) && schemaKey.IsKey && rest.Length > 0
                        ? new StateType(text, StateTypeKind.SchemaMap, schemaKey, default, rest)
                        : null;
                default:
                    return null;
            }
        }
    }
}
