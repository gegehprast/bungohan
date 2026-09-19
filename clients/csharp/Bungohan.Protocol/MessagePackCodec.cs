using System;
using System.Collections;
using System.Collections.Generic;

namespace Bungohan.Protocol
{
    /// <summary>
    /// The <c>messagepack</c> codec (PROTOCOL.md §13.2): self-describing, kept
    /// for debugging. State bodies are one array of op tuples; a message is a
    /// positional array of its field values.
    /// </summary>
    public sealed class MessagePackCodec : IStateCodec
    {
        public string Name => "messagepack";

        public IStateCodecSession CreateSession() => new MessagePackSession();

        public Result<byte[]> EncodeMessage(MessageDef def, MsgMap payload)
        {
            string? problem = Positional.PackMessage(def, payload, def.Name, out List<object?> packed);
            return problem == null ? MessagePack.Encode(packed) : Result<byte[]>.Fail(ErrorCodes.EncodeFailed, problem);
        }

        public Result<MsgMap> DecodeMessage(MessageDef def, byte[] data, int offset, int count)
        {
            Result<object?> decoded = MessagePack.Decode(data, offset, count);
            if (!decoded.IsOk) return Result<MsgMap>.Fail(decoded.Error!);
            string? problem = Positional.UnpackMessage(def, decoded.Value, def.Name, out MsgMap message);
            return problem == null ? Result<MsgMap>.Ok(message) : Result<MsgMap>.Fail(ErrorCodes.DecodeFailed, problem);
        }
    }

    internal sealed class MessagePackSession : IStateCodecSession
    {
        private readonly ClassTable _table = new ClassTable();

        public ClassTable Table => _table;

        public Result<byte[]> EncodeOps(IReadOnlyList<WireOp> ops)
        {
            int mark = _table.Count;
            var tuples = new List<object?>(ops.Count);
            foreach (WireOp op in ops)
            {
                if (op.Code == OpCode.Define)
                {
                    string? problem = ClassTable.CheckDefine(op) ?? _table.Define(op);
                    if (problem != null)
                    {
                        _table.Truncate(mark);
                        return Result<byte[]>.Fail(ErrorCodes.EncodeFailed, problem);
                    }
                }
                tuples.Add(op.ToTuple());
            }
            Result<byte[]> encoded = MessagePack.Encode(tuples);
            if (!encoded.IsOk) _table.Truncate(mark);
            return encoded;
        }

        public Result<List<WireOp>> DecodeOps(byte[] data, int offset, int count)
        {
            Result<object?> decoded = MessagePack.Decode(data, offset, count);
            if (!decoded.IsOk) return Result<List<WireOp>>.Fail(decoded.Error!);
            if (!(decoded.Value is List<object?> list))
            {
                return Result<List<WireOp>>.Fail(ErrorCodes.DecodeFailed, "frame is not an array");
            }
            int mark = _table.Count;
            var ops = new List<WireOp>(list.Count);
            for (int i = 0; i < list.Count; i++)
            {
                WireOp? op = ToOp(list[i]);
                string? problem = op == null
                    ? "malformed op #" + i
                    : op.Code == OpCode.Define ? ClassTable.CheckDefine(op) ?? _table.Define(op) : null;
                if (problem != null)
                {
                    _table.Truncate(mark);
                    return Result<List<WireOp>>.Fail(ErrorCodes.DecodeFailed, problem);
                }
                ops.Add(op!);
            }
            return Result<List<WireOp>>.Ok(ops);
        }

        /// <summary>A decoded tuple → an op, checking code, arity and value types (§13.2.1).</summary>
        private static WireOp? ToOp(object? item)
        {
            if (!(item is List<object?> tuple) || tuple.Count < 2) return null;
            if (!TryInt(tuple[0], out long code) || !TryInt(tuple[1], out long target)) return null;
            switch (code)
            {
                case 0:
                    return tuple.Count == 4 && TryInt(tuple[2], out long index) && TryValue(tuple[3], out object? v0)
                        ? WireOp.Set(target, index, v0!)
                        : null;
                case 1:
                    if (tuple.Count == 3) return TryValue(tuple[2], out object? v1) ? WireOp.AddToSet(target, v1!) : null;
                    return tuple.Count == 4 && TryKey(tuple[2], out object? k1) && TryValue(tuple[3], out object? v2)
                        ? WireOp.Add(target, k1!, v2!)
                        : null;
                case 2:
                    return tuple.Count == 3 && TryKey(tuple[2], out object? k2) ? WireOp.Remove(target, k2!) : null;
                case 3:
                    return tuple.Count == 2 ? WireOp.Clear(target) : null;
                case 4:
                    if (tuple.Count != 5 || !(tuple[2] is string name)) return null;
                    if (!TryStrings(tuple[3], out List<string> fields) || !TryStrings(tuple[4], out List<string> types))
                    {
                        return null;
                    }
                    return WireOp.Define(target, name, fields, types);
                default:
                    return null;
            }
        }

        private static bool TryInt(object? value, out long result)
        {
            if (value is long l)
            {
                result = l;
                return true;
            }
            if (value is double d && d == Math.Floor(d) && Math.Abs(d) <= MessagePack.MaxSafeInteger)
            {
                result = (long)d;
                return true;
            }
            result = 0;
            return false;
        }

        /// <summary>A key: a number (as double), string or bool.</summary>
        private static bool TryKey(object? value, out object? key)
        {
            switch (value)
            {
                case string _:
                case bool _:
                    key = value;
                    return true;
                case long l:
                    key = (double)l;
                    return true;
                case double _:
                    key = value;
                    return true;
                default:
                    key = null;
                    return false;
            }
        }

        /// <summary>A value: a key, or a 2-integer array (a ref).</summary>
        private static bool TryValue(object? value, out object? result)
        {
            if (value is List<object?> pair)
            {
                if (pair.Count == 2 && TryInt(pair[0], out long classId) && TryInt(pair[1], out long refId))
                {
                    result = new WireRef(classId, refId);
                    return true;
                }
                result = null;
                return false;
            }
            return TryKey(value, out result);
        }

        private static bool TryStrings(object? value, out List<string> strings)
        {
            strings = new List<string>();
            if (!(value is List<object?> list)) return false;
            foreach (object? item in list)
            {
                if (!(item is string s)) return false;
                strings.Add(s);
            }
            return true;
        }
    }

    /// <summary>Positional message arrays (§13.2.2).</summary>
    internal static class Positional
    {
        public static string? PackMessage(MessageDef def, object? payload, string path, out List<object?> packed)
        {
            packed = new List<object?>();
            MsgMap? record = MessageWriter.AsRecord(payload);
            if (record == null) return path + ": not an object";
            foreach (MessageField field in def.Fields)
            {
                record.TryGetValue(field.Name, out object? value);
                string? problem = PackField(field.Type, value, path + "." + field.Name, out object? item);
                if (problem != null) return problem;
                packed.Add(item);
            }
            // Trailing absent optionals are left out.
            int length = packed.Count;
            while (length > 0 && packed[length - 1] == null && def.Fields[length - 1].Type.Kind == FieldKind.Optional)
            {
                length--;
            }
            packed.RemoveRange(length, packed.Count - length);
            return null;
        }

        private static string? PackField(FieldType type, object? value, string path, out object? packed)
        {
            packed = null;
            switch (type.Kind)
            {
                case FieldKind.Float64:
                    if (!Numeric.TryNumber(value, out double f64)) return path + ": not a number";
                    packed = f64;
                    return null;
                case FieldKind.Float32:
                    if (!Numeric.TryNumber(value, out double f32)) return path + ": not a number";
                    packed = Numeric.Float32(f32);
                    return null;
                case FieldKind.Fixed:
                    if (!Numeric.TryNumber(value, out double fx)) return path + ": not a number";
                    packed = (long)Numeric.FixedEncode(fx, type.Decimals);
                    return null;
                case FieldKind.String:
                    if (!(value is string)) return path + ": not a string";
                    packed = value;
                    return null;
                case FieldKind.Bool:
                    if (!(value is bool)) return path + ": not a bool";
                    packed = value;
                    return null;
                case FieldKind.Enum:
                {
                    int index = type.EnumIndexOf(value);
                    if (index < 0) return path + ": not one of the enum values";
                    packed = (long)index;
                    return null;
                }
                case FieldKind.Array:
                {
                    if (!(value is IList list) || value is string) return path + ": not an array";
                    var items = new List<object?>(list.Count);
                    for (int i = 0; i < list.Count; i++)
                    {
                        string? problem = PackField(type.Of!, list[i], path + "[" + i + "]", out object? item);
                        if (problem != null) return problem;
                        items.Add(item);
                    }
                    packed = items;
                    return null;
                }
                case FieldKind.Map:
                {
                    MsgMap? map = MessageWriter.AsRecord(value);
                    if (map == null) return path + ": not an object";
                    var output = new MsgMap();
                    foreach (var entry in map)
                    {
                        string? problem = PackField(type.Of!, entry.Value, path + "." + entry.Key, out object? item);
                        if (problem != null) return problem;
                        output[entry.Key] = item;
                    }
                    packed = output;
                    return null;
                }
                case FieldKind.Optional:
                    return value == null ? null : PackField(type.Of!, value, path, out packed);
                case FieldKind.Nested:
                {
                    string? problem = PackMessage(type.Message!, value, path, out List<object?> nested);
                    packed = nested;
                    return problem;
                }
                default:
                {
                    type.TryIntKind(out IntKind kind);
                    if (!Numeric.TryNumber(value, out double n)) return path + ": not a number";
                    packed = Numeric.IntEncode(n, kind);
                    return null;
                }
            }
        }

        public static string? UnpackMessage(MessageDef def, object? wire, string path, out MsgMap message)
        {
            message = new MsgMap();
            if (!(wire is List<object?> list)) return path + ": expected a positional array";
            if (list.Count > def.Fields.Count) return path + ": too many fields";
            for (int i = 0; i < def.Fields.Count; i++)
            {
                MessageField field = def.Fields[i];
                // Past the end of the array, only a trimmed optional may be missing.
                object? item = i < list.Count ? list[i] : null;
                string? problem = UnpackField(field.Type, item, path + "." + field.Name, out object? value, out bool absent);
                if (problem != null) return problem;
                if (!absent) message[field.Name] = value;
            }
            return null;
        }

        private static string? UnpackField(FieldType type, object? wire, string path, out object? value, out bool absent)
        {
            value = null;
            absent = false;
            switch (type.Kind)
            {
                case FieldKind.Float64:
                    if (!Numeric.TryNumber(wire, out double f64)) return path + ": expected a number";
                    value = f64;
                    return null;
                case FieldKind.Float32:
                    if (!Numeric.TryNumber(wire, out double f32)) return path + ": expected a number";
                    value = Numeric.Float32(f32);
                    return null;
                case FieldKind.Fixed:
                    if (!Numeric.TryNumber(wire, out double fx) || !Numeric.IsIntOf(fx, IntKind.Int32))
                    {
                        return path + ": expected an int32";
                    }
                    value = Numeric.FixedDecode((int)fx, type.Decimals);
                    return null;
                case FieldKind.String:
                    if (!(wire is string)) return path + ": expected a string";
                    value = wire;
                    return null;
                case FieldKind.Bool:
                    if (!(wire is bool)) return path + ": expected a bool";
                    value = wire;
                    return null;
                case FieldKind.Enum:
                {
                    if (!Numeric.TryNumber(wire, out double index) || index != Math.Floor(index) ||
                        index < 0 || index >= type.EnumValues.Count)
                    {
                        return path + ": bad enum index";
                    }
                    value = type.EnumValues[(int)index];
                    return null;
                }
                case FieldKind.Array:
                {
                    if (!(wire is List<object?> list)) return path + ": expected an array";
                    var items = new List<object?>(list.Count);
                    for (int i = 0; i < list.Count; i++)
                    {
                        string? problem = UnpackField(type.Of!, list[i], path + "[" + i + "]", out object? item, out _);
                        if (problem != null) return problem;
                        items.Add(item);
                    }
                    value = items;
                    return null;
                }
                case FieldKind.Map:
                {
                    if (!(wire is MsgMap map)) return path + ": expected a map";
                    var output = new MsgMap();
                    foreach (var entry in map)
                    {
                        string? problem = UnpackField(type.Of!, entry.Value, path + "." + entry.Key, out object? item, out _);
                        if (problem != null) return problem;
                        output[entry.Key] = item;
                    }
                    value = output;
                    return null;
                }
                case FieldKind.Optional:
                    if (wire == null)
                    {
                        absent = true;
                        return null;
                    }
                    return UnpackField(type.Of!, wire, path, out value, out _);
                case FieldKind.Nested:
                {
                    string? problem = UnpackMessage(type.Message!, wire, path, out MsgMap nested);
                    value = nested;
                    return problem;
                }
                default:
                {
                    type.TryIntKind(out IntKind kind);
                    if (!Numeric.TryNumber(wire, out double n) || !Numeric.IsIntOf(n, kind))
                    {
                        return path + ": expected " + kind;
                    }
                    value = (long)n;
                    return null;
                }
            }
        }
    }
}
