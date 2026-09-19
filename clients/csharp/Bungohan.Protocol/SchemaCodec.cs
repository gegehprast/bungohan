using System;
using System.Collections;
using System.Collections.Generic;

namespace Bungohan.Protocol
{
    /// <summary>
    /// The <c>schema</c> codec (PROTOCOL.md §13.1), the default: tag-free
    /// binary state ops and contract messages.
    /// </summary>
    public sealed class SchemaCodec : IStateCodec
    {
        public string Name => "schema";

        public IStateCodecSession CreateSession() => new SchemaSession();

        public Result<byte[]> EncodeMessage(MessageDef def, MsgMap payload)
        {
            var output = new ByteWriter();
            string? problem = MessageWriter.WriteMessage(output, def, payload, def.Name);
            return problem == null
                ? Result<byte[]>.Ok(output.ToArray())
                : Result<byte[]>.Fail(ErrorCodes.EncodeFailed, problem);
        }

        public Result<MsgMap> DecodeMessage(MessageDef def, byte[] data, int offset, int count)
        {
            var input = new ByteReader(data, offset, count);
            MsgMap message = MessageWriter.ReadMessage(input, def);
            if (!input.Failed && !input.Done) input.Fail("trailing bytes after the message");
            return input.Failed
                ? Result<MsgMap>.Fail(ErrorCodes.DecodeFailed, def.Name + ": " + input.Error)
                : Result<MsgMap>.Ok(message);
        }
    }

    // =======================================================================
    // State ops (§13.1.1–13.1.4)
    // =======================================================================

    /// <summary>A class as the codec needs it: each field's parsed type.</summary>
    internal sealed class ClassLayout
    {
        public ClassLayout(StateType[] types)
        {
            Types = types;
            var collections = new List<StateType>();
            foreach (StateType type in types)
            {
                if (type.IsCollection) collections.Add(type);
            }
            Collections = collections.ToArray();
        }

        public StateType[] Types { get; }

        /// <summary>Collection field types in field order: refIds R+1 … R+k.</summary>
        public StateType[] Collections { get; }
    }

    /// <summary>What a refId denotes (§13.1.2): an instance of a class, or a collection.</summary>
    internal sealed class Target
    {
        public Target(ClassLayout? layout, StateType? collection)
        {
            Layout = layout;
            Collection = collection;
        }

        public ClassLayout? Layout { get; }
        public StateType? Collection { get; }
    }

    /// <summary>The class and target tables of one stream, with an undo journal.</summary>
    internal sealed class Tables
    {
        private readonly List<KeyValuePair<long, Target?>> _undo = new List<KeyValuePair<long, Target?>>();
        private int _classMark;

        public ClassTable Classes { get; } = new ClassTable();
        public List<ClassLayout> Layouts { get; } = new List<ClassLayout>();
        public Dictionary<long, Target> Targets { get; } = new Dictionary<long, Target>();

        public void Begin()
        {
            _undo.Clear();
            _classMark = Layouts.Count;
        }

        public void Rollback()
        {
            for (int i = _undo.Count - 1; i >= 0; i--)
            {
                var entry = _undo[i];
                if (entry.Value == null) Targets.Remove(entry.Key);
                else Targets[entry.Key] = entry.Value;
            }
            _undo.Clear();
            if (Layouts.Count > _classMark) Layouts.RemoveRange(_classMark, Layouts.Count - _classMark);
            Classes.Truncate(_classMark);
        }

        /// <summary>Applies a shape-checked <c>DEFINE</c>; a message if it's invalid.</summary>
        public string? Define(WireOp op)
        {
            int known = Classes.Count;
            string? problem = Classes.Define(op);
            if (problem != null) return problem;
            if (Classes.Count == known) return null; // a restatement
            var types = new StateType[op.Types.Count];
            for (int i = 0; i < types.Length; i++)
            {
                StateType? parsed = StateType.Parse(op.Types[i]);
                if (parsed == null) return "DEFINE " + op.Target + ": unparseable type";
                types[i] = parsed;
            }
            var layout = new ClassLayout(types);
            Layouts.Add(layout);
            // The root is refId 0, an instance of classId 0 (§11.3).
            if (op.Target == 0) Bind(0, layout);
            return null;
        }

        /// <summary>Binds <paramref name="refId"/> (and its block) as an instance of the class.</summary>
        public string? BindRef(long classId, long refId)
        {
            if (classId < 0 || classId >= Layouts.Count) return "ref to undefined classId " + classId;
            ClassLayout layout = Layouts[(int)classId];
            if (refId + layout.Collections.Length > uint.MaxValue) return "refId block of " + refId + " overflows";
            Bind(refId, layout);
            return null;
        }

        private void Bind(long refId, ClassLayout layout)
        {
            SetTarget(refId, new Target(layout, null));
            long next = refId + 1;
            foreach (StateType type in layout.Collections) SetTarget(next++, new Target(null, type));
        }

        private void SetTarget(long refId, Target target)
        {
            Targets.TryGetValue(refId, out Target? previous);
            _undo.Add(new KeyValuePair<long, Target?>(refId, previous));
            Targets[refId] = target;
        }
    }

    /// <summary>Scalar values under the schema codec (§13.1.4).</summary>
    internal static class Scalars
    {
        private static bool IsUint32(object? value, out long result)
        {
            if (Numeric.TryNumber(value, out double number) && Numeric.IsIntOf(number, IntKind.UInt32))
            {
                result = (long)number;
                return true;
            }
            result = 0;
            return false;
        }

        public static bool TryUint32(object? value, out long result) => IsUint32(value, out result);

        /// <summary>Writes a primitive, integer or key value; a message if it doesn't fit.</summary>
        public static string? Write(ByteWriter output, Scalar type, object? value)
        {
            switch (type.Kind)
            {
                case ScalarKind.Float64:
                    if (!Numeric.TryNumber(value, out double f64)) return "float64: not a number";
                    output.Float64(f64);
                    return null;
                case ScalarKind.Float32:
                    if (!Numeric.TryNumber(value, out double f32)) return "float32: not a number";
                    output.Float32(f32);
                    return null;
                case ScalarKind.String:
                    if (!(value is string s)) return "string: not a string";
                    output.String(s);
                    return null;
                case ScalarKind.Bool:
                    if (!(value is bool b)) return "bool: not a boolean";
                    output.U8(b ? (byte)1 : (byte)0);
                    return null;
                case ScalarKind.Fixed:
                    if (!Numeric.TryNumber(value, out double fx) || !Numeric.IsIntOf(fx, IntKind.Int32))
                    {
                        return "fixed:" + type.Decimals + ": not an int32";
                    }
                    output.Zigzag((int)fx);
                    return null;
                default:
                    if (!Numeric.TryNumber(value, out double n) || !Numeric.IsIntOf(n, type.IntKind))
                    {
                        return type.IntKind + ": out of range";
                    }
                    WriteInt(output, type.IntKind, (long)n);
                    return null;
            }
        }

        public static void WriteInt(ByteWriter output, IntKind kind, long value)
        {
            switch (kind)
            {
                case IntKind.Int8:
                case IntKind.UInt8:
                    output.U8((byte)value);
                    return;
                case IntKind.Int16:
                case IntKind.Int32:
                    output.Zigzag((int)value);
                    return;
                default:
                    output.Varint((uint)value);
                    return;
            }
        }

        /// <summary>Reads a primitive, integer or key value (range-checked); numbers as double.</summary>
        public static object Read(ByteReader input, Scalar type)
        {
            switch (type.Kind)
            {
                case ScalarKind.Float64: return input.Float64();
                case ScalarKind.Float32: return input.Float32();
                case ScalarKind.String: return input.String();
                case ScalarKind.Bool:
                {
                    byte b = input.U8();
                    if (b > 1) input.Fail("bool byte " + b);
                    return b == 1;
                }
                case ScalarKind.Fixed: return (double)input.Zigzag();
                default: return (double)ReadInt(input, type.IntKind);
            }
        }

        public static long ReadInt(ByteReader input, IntKind kind)
        {
            long value;
            switch (kind)
            {
                case IntKind.Int8: value = (sbyte)input.U8(); break;
                case IntKind.UInt8: value = input.U8(); break;
                case IntKind.Int16:
                case IntKind.Int32: value = input.Zigzag(); break;
                default: value = input.Varint(); break;
            }
            if (value < Numeric.Min(kind) || value > Numeric.Max(kind))
            {
                input.Fail(kind + " out of range: " + value);
            }
            return value;
        }
    }

    internal sealed class SchemaSession : IStateCodecSession
    {
        private const int HeaderS = 0x10;
        private const int FEscape = 15;
        private readonly Tables _tables = new Tables();

        public ClassTable Table => _tables.Classes;

        public Result<byte[]> EncodeOps(IReadOnlyList<WireOp> ops)
        {
            var output = new ByteWriter();
            _tables.Begin();
            long last = 0;
            for (int i = 0; i < ops.Count; i++)
            {
                string? problem = EncodeOp(output, ops[i], ref last);
                if (problem != null)
                {
                    _tables.Rollback();
                    return Result<byte[]>.Fail(ErrorCodes.EncodeFailed, "op #" + i + ": " + problem);
                }
            }
            return Result<byte[]>.Ok(output.ToArray());
        }

        public Result<List<WireOp>> DecodeOps(byte[] data, int offset, int count)
        {
            var input = new ByteReader(data, offset, count);
            _tables.Begin();
            var ops = new List<WireOp>();
            long last = 0;
            while (!input.Done)
            {
                WireOp? op = DecodeOp(input, ref last);
                if (op == null || input.Failed) break;
                ops.Add(op);
            }
            if (input.Failed)
            {
                _tables.Rollback();
                return Result<List<WireOp>>.Fail(ErrorCodes.DecodeFailed, "op #" + ops.Count + ": " + input.Error);
            }
            return Result<List<WireOp>>.Ok(ops);
        }

        // --- encoder -------------------------------------------------------

        private string? EncodeOp(ByteWriter output, WireOp op, ref long last)
        {
            if (op.Code == OpCode.Define) return EncodeDefine(output, op);
            long refId = op.Target;
            if (refId < 0 || refId > uint.MaxValue) return "target must be a uint32 refId";
            if (!_tables.Targets.TryGetValue(refId, out Target? target)) return "unknown target refId " + refId;
            int same = refId == last ? HeaderS : 0;

            // Header F: a SET on an instance carries its field index.
            long field = -1;
            if (op.Code == OpCode.Set && target.Layout != null)
            {
                if (!Scalars.TryUint32(op.Key, out field)) return "field index must be a uint32";
                if (field >= target.Layout.Types.Length) return "field " + field + " out of range";
            }
            int f = field < 0 ? 0 : (int)Math.Min(field, FEscape);
            if (op.Code > OpCode.Clear) return "unknown op code " + op.Code;
            output.U8((byte)(((int)op.Code << 5) | same | f));
            if (same == 0) output.Varint((uint)refId);
            if (f == FEscape) output.Varint((uint)(field - FEscape));

            string? problem = EncodePayload(output, op, target, field, out long? carried);
            if (problem != null) return problem;
            last = carried ?? refId;
            return null;
        }

        private string? EncodePayload(ByteWriter output, WireOp op, Target target, long field, out long? carried)
        {
            carried = null;
            if (target.Layout != null)
            {
                if (op.Code != OpCode.Set) return "op " + op.Code + " on a schema instance";
                StateType type = target.Layout.Types[field];
                return EncodeValue(output, type, op.Value, out carried);
            }
            StateType collection = target.Collection!;
            switch (op.Code)
            {
                case OpCode.Set:
                    if (!collection.IsArray) return "SET on a collection that isn't an array";
                    return EncodeIndex(output, op.Key) ?? EncodeElement(output, collection, op.Value, out carried);
                case OpCode.Add:
                    if (collection.IsSet)
                    {
                        if (op.HasKey) return "a set ADD has no key";
                        return EncodeElement(output, collection, op.Value, out carried);
                    }
                    if (!op.HasKey) return "ADD needs a key";
                    string? keyProblem = collection.IsMap
                        ? Scalars.Write(output, collection.Key, op.Key)
                        : EncodeIndex(output, op.Key);
                    return keyProblem ?? EncodeElement(output, collection, op.Value, out carried);
                case OpCode.Remove:
                    if (collection.IsMap) return Scalars.Write(output, collection.Key, op.Key);
                    if (collection.Kind == StateTypeKind.Set) return Scalars.Write(output, collection.Element, op.Key);
                    // An array index, or a schema set's element refId.
                    return EncodeIndex(output, op.Key);
                default:
                    return null; // CLEAR: nothing follows
            }
        }

        private string? EncodeValue(ByteWriter output, StateType type, object? value, out long? carried)
        {
            carried = null;
            if (type.Kind == StateTypeKind.Schema) return EncodeRef(output, value, out carried);
            if (type.Kind == StateTypeKind.Primitive || type.Kind == StateTypeKind.Int)
            {
                return Scalars.Write(output, type.Element, value);
            }
            return "a collection field has no value";
        }

        private string? EncodeElement(ByteWriter output, StateType type, object? value, out long? carried)
        {
            carried = null;
            return type.HoldsSchemas
                ? EncodeRef(output, value, out carried)
                : Scalars.Write(output, type.Element, value);
        }

        private string? EncodeRef(ByteWriter output, object? value, out long? carried)
        {
            carried = null;
            if (!(value is WireRef r) || r.ClassId < 0 || r.ClassId > uint.MaxValue || r.RefId < 0 || r.RefId > uint.MaxValue)
            {
                return "expected a ref [classId, refId]";
            }
            string? problem = _tables.BindRef(r.ClassId, r.RefId);
            if (problem != null) return problem;
            output.Varint((uint)r.ClassId);
            output.Varint((uint)r.RefId);
            carried = r.RefId;
            return null;
        }

        private static string? EncodeIndex(ByteWriter output, object? index)
        {
            if (!Scalars.TryUint32(index, out long value)) return "index must be a uint32";
            output.Varint((uint)value);
            return null;
        }

        private string? EncodeDefine(ByteWriter output, WireOp op)
        {
            string? problem = ClassTable.CheckDefine(op) ?? _tables.Define(op);
            if (problem != null) return problem;
            output.U8(0x80);
            output.Varint((uint)op.Target);
            output.String(op.Name);
            output.Varint((uint)op.Fields.Count);
            for (int i = 0; i < op.Fields.Count; i++)
            {
                output.String(op.Fields[i]);
                output.String(op.Types[i]);
            }
            return null;
        }

        // --- decoder -------------------------------------------------------

        private WireOp? DecodeOp(ByteReader input, ref long last)
        {
            int header = input.U8();
            int code = header >> 5;
            bool same = (header & HeaderS) != 0;
            int f = header & 0x0f;
            if (code == (int)OpCode.Define)
            {
                if (same || f != 0) return Fail(input, "DEFINE with S or F set");
                return DecodeDefine(input);
            }
            if (code > (int)OpCode.Define) return Fail(input, "unknown op code " + code);

            long refId = same ? last : input.Varint();
            if (input.Failed) return null;
            if (!_tables.Targets.TryGetValue(refId, out Target? target)) return Fail(input, "unknown target refId " + refId);

            if (target.Layout != null)
            {
                if (code != (int)OpCode.Set) return Fail(input, "op " + code + " on a schema instance");
                long field = f == FEscape ? FEscape + (long)input.Varint() : f;
                if (input.Failed) return null;
                if (field >= target.Layout.Types.Length) return Fail(input, "field " + field + " out of range");
                object? value = DecodeValue(input, target.Layout.Types[field]);
                if (value == null) return null;
                last = value is WireRef setRef ? setRef.RefId : refId;
                return WireOp.Set(refId, field, value);
            }

            if (f != 0) return Fail(input, "F must be 0 on a collection op");
            StateType type = target.Collection!;
            switch ((OpCode)code)
            {
                case OpCode.Set:
                {
                    if (!type.IsArray) return Fail(input, "SET on a non-array collection");
                    uint index = input.Varint();
                    object? value = DecodeElement(input, type);
                    if (value == null) return null;
                    last = value is WireRef r ? r.RefId : refId;
                    return WireOp.Set(refId, index, value);
                }
                case OpCode.Add:
                {
                    if (type.IsSet)
                    {
                        object? element = DecodeElement(input, type);
                        if (element == null) return null;
                        last = element is WireRef r ? r.RefId : refId;
                        return WireOp.AddToSet(refId, element);
                    }
                    object key = type.IsMap ? Scalars.Read(input, type.Key) : (double)input.Varint();
                    object? value = DecodeElement(input, type);
                    if (value == null) return null;
                    last = value is WireRef r2 ? r2.RefId : refId;
                    return WireOp.Add(refId, key, value);
                }
                case OpCode.Remove:
                {
                    object key;
                    if (type.IsMap) key = Scalars.Read(input, type.Key);
                    else if (type.Kind == StateTypeKind.Set) key = Scalars.Read(input, type.Element);
                    else key = (double)input.Varint(); // array index, or schema set refId
                    if (input.Failed) return null;
                    last = refId;
                    return WireOp.Remove(refId, key);
                }
                default:
                    last = refId;
                    return WireOp.Clear(refId);
            }
        }

        private static WireOp? Fail(ByteReader input, string message)
        {
            input.Fail(message);
            return null;
        }

        private object? DecodeRef(ByteReader input)
        {
            long classId = input.Varint();
            long refId = input.Varint();
            if (input.Failed) return null;
            string? problem = _tables.BindRef(classId, refId);
            if (problem != null)
            {
                input.Fail(problem);
                return null;
            }
            return new WireRef(classId, refId);
        }

        private object? DecodeValue(ByteReader input, StateType type)
        {
            if (type.Kind == StateTypeKind.Schema) return DecodeRef(input);
            if (type.Kind != StateTypeKind.Primitive && type.Kind != StateTypeKind.Int)
            {
                input.Fail("a collection field has no value");
                return null;
            }
            object value = Scalars.Read(input, type.Element);
            return input.Failed ? null : value;
        }

        private object? DecodeElement(ByteReader input, StateType type)
        {
            if (type.HoldsSchemas) return DecodeRef(input);
            object value = Scalars.Read(input, type.Element);
            return input.Failed ? null : value;
        }

        private WireOp? DecodeDefine(ByteReader input)
        {
            long classId = input.Varint();
            string name = input.String();
            int count = input.Count();
            var fields = new List<string>();
            var types = new List<string>();
            for (int i = 0; i < count && !input.Failed; i++)
            {
                fields.Add(input.String());
                types.Add(input.String());
            }
            if (input.Failed) return null;
            WireOp op = WireOp.Define(classId, name, fields, types);
            string? problem = ClassTable.CheckDefine(op) ?? _tables.Define(op);
            return problem == null ? op : Fail(input, problem);
        }
    }

    // =======================================================================
    // Contract messages (§13.1.6)
    // =======================================================================

    internal static class MessageWriter
    {
        public static MsgMap? AsRecord(object? value)
        {
            if (value is MsgMap map) return map;
            if (value is IDictionary dictionary)
            {
                var copy = new MsgMap();
                foreach (DictionaryEntry entry in dictionary)
                {
                    if (!(entry.Key is string key)) return null;
                    copy[key] = entry.Value;
                }
                return copy;
            }
            return null;
        }

        public static string? WriteMessage(ByteWriter output, MessageDef def, object? payload, string path)
        {
            MsgMap? record = AsRecord(payload);
            if (record == null) return path + ": not an object";
            MessagePlan plan = def.Plan;
            int flagsAt = output.Length;
            var flags = new byte[plan.FlagBytes];
            for (int i = 0; i < plan.FlagBytes; i++) output.U8(0);
            for (int i = 0; i < def.Fields.Count; i++)
            {
                MessageField field = def.Fields[i];
                record.TryGetValue(field.Name, out object? value);
                string at = path + "." + field.Name;
                if (field.Type.Kind == FieldKind.Bool)
                {
                    if (!(value is bool b)) return at + ": not a bool";
                    if (b) SetBit(flags, plan.Bits[i]);
                    continue;
                }
                if (field.Type.Kind == FieldKind.Optional)
                {
                    if (value == null) continue;
                    SetBit(flags, plan.Bits[i]);
                    if (plan.ValueBits[i] >= 0)
                    {
                        if (!(value is bool ob)) return at + ": not a bool";
                        if (ob) SetBit(flags, plan.ValueBits[i]);
                        continue;
                    }
                    string? optionalProblem = WriteField(output, field.Type.Of!, value, at);
                    if (optionalProblem != null) return optionalProblem;
                    continue;
                }
                string? problem = WriteField(output, field.Type, value, at);
                if (problem != null) return problem;
            }
            for (int i = 0; i < flags.Length; i++) output.Patch(flagsAt + i, flags[i]);
            return null;
        }

        private static void SetBit(byte[] flags, int bit) => flags[bit >> 3] |= (byte)(1 << (bit & 7));

        private static bool Bit(byte[] flags, int bit) => (flags[bit >> 3] & (1 << (bit & 7))) != 0;

        /// <summary>Writes one value (not a message-level bool or optional).</summary>
        public static string? WriteField(ByteWriter output, FieldType type, object? value, string path)
        {
            switch (type.Kind)
            {
                case FieldKind.Float64:
                    if (!Numeric.TryNumber(value, out double f64)) return path + ": not a number";
                    output.Float64(f64);
                    return null;
                case FieldKind.Float32:
                    if (!Numeric.TryNumber(value, out double f32)) return path + ": not a number";
                    output.Float32(f32);
                    return null;
                case FieldKind.Fixed:
                    if (!Numeric.TryNumber(value, out double fx)) return path + ": not a number";
                    output.Zigzag(Numeric.FixedEncode(fx, type.Decimals));
                    return null;
                case FieldKind.String:
                    if (!(value is string s)) return path + ": not a string";
                    output.String(s);
                    return null;
                case FieldKind.Bool:
                    if (!(value is bool b)) return path + ": not a bool";
                    output.U8(b ? (byte)1 : (byte)0);
                    return null;
                case FieldKind.Enum:
                {
                    int index = type.EnumIndexOf(value);
                    if (index < 0) return path + ": not one of the enum values";
                    output.Varint((uint)index);
                    return null;
                }
                case FieldKind.Array:
                {
                    if (!(value is IList list) || value is string) return path + ": not an array";
                    output.Varint((uint)list.Count);
                    for (int i = 0; i < list.Count; i++)
                    {
                        string? problem = WriteField(output, type.Of!, list[i], path + "[" + i + "]");
                        if (problem != null) return problem;
                    }
                    return null;
                }
                case FieldKind.Map:
                {
                    MsgMap? map = AsRecord(value);
                    if (map == null) return path + ": not an object";
                    output.Varint((uint)map.Count);
                    foreach (var entry in map)
                    {
                        output.String(entry.Key);
                        string? problem = WriteField(output, type.Of!, entry.Value, path + "." + entry.Key);
                        if (problem != null) return problem;
                    }
                    return null;
                }
                case FieldKind.Optional:
                    // An array element or map value: a presence byte.
                    if (value == null)
                    {
                        output.U8(0);
                        return null;
                    }
                    output.U8(1);
                    return WriteField(output, type.Of!, value, path);
                case FieldKind.Nested:
                    return WriteMessage(output, type.Message!, value, path);
                default:
                {
                    type.TryIntKind(out IntKind kind);
                    if (!Numeric.TryNumber(value, out double n)) return path + ": not a number";
                    Scalars.WriteInt(output, kind, Numeric.IntEncode(n, kind));
                    return null;
                }
            }
        }

        public static MsgMap ReadMessage(ByteReader input, MessageDef def)
        {
            MessagePlan plan = def.Plan;
            var flags = new byte[plan.FlagBytes];
            for (int i = 0; i < flags.Length; i++) flags[i] = input.U8();
            if (flags.Length > 0 && (flags[flags.Length - 1] & ~plan.LastMask) != 0)
            {
                input.Fail("flag padding bit set");
            }
            var output = new MsgMap();
            for (int i = 0; i < def.Fields.Count && !input.Failed; i++)
            {
                MessageField field = def.Fields[i];
                if (field.Type.Kind == FieldKind.Bool)
                {
                    output[field.Name] = Bit(flags, plan.Bits[i]);
                }
                else if (field.Type.Kind == FieldKind.Optional)
                {
                    if (!Bit(flags, plan.Bits[i]))
                    {
                        if (plan.ValueBits[i] >= 0 && Bit(flags, plan.ValueBits[i]))
                        {
                            input.Fail("value bit of an absent optional");
                        }
                        continue;
                    }
                    output[field.Name] = plan.ValueBits[i] >= 0
                        ? Bit(flags, plan.ValueBits[i])
                        : ReadField(input, field.Type.Of!);
                }
                else
                {
                    output[field.Name] = ReadField(input, field.Type);
                }
            }
            return output;
        }

        public static object? ReadField(ByteReader input, FieldType type)
        {
            switch (type.Kind)
            {
                case FieldKind.Float64: return input.Float64();
                case FieldKind.Float32: return input.Float32();
                case FieldKind.Fixed: return Numeric.FixedDecode(input.Zigzag(), type.Decimals);
                case FieldKind.String: return input.String();
                case FieldKind.Bool:
                {
                    byte b = input.U8();
                    if (b > 1) input.Fail("bool byte " + b);
                    return b == 1;
                }
                case FieldKind.Enum:
                {
                    uint index = input.Varint();
                    if (input.Failed) return null;
                    if (index >= type.EnumValues.Count)
                    {
                        input.Fail("enum index " + index + " out of range");
                        return null;
                    }
                    return type.EnumValues[(int)index];
                }
                case FieldKind.Array:
                {
                    int count = input.Count();
                    var list = new List<object?>();
                    for (int i = 0; i < count && !input.Failed; i++) list.Add(ReadField(input, type.Of!));
                    return list;
                }
                case FieldKind.Map:
                {
                    int count = input.Count();
                    var map = new MsgMap();
                    for (int i = 0; i < count && !input.Failed; i++)
                    {
                        string key = input.String();
                        if (input.Failed) break;
                        if (key == "__proto__") input.Fail("forbidden map key __proto__");
                        else if (map.ContainsKey(key)) input.Fail("duplicate map key");
                        object? value = ReadField(input, type.Of!);
                        if (!input.Failed) map[key] = value;
                    }
                    return map;
                }
                case FieldKind.Optional:
                {
                    byte present = input.U8();
                    if (present > 1) input.Fail("presence byte " + present);
                    return present == 1 ? ReadField(input, type.Of!) : null;
                }
                case FieldKind.Nested:
                    return ReadMessage(input, type.Message!);
                default:
                    type.TryIntKind(out IntKind kind);
                    return Scalars.ReadInt(input, kind);
            }
        }
    }
}
