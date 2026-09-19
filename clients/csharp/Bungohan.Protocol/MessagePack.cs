using System;
using System.Collections;
using System.Collections.Generic;

namespace Bungohan.Protocol
{
    /// <summary>
    /// The MessagePack subset PROTOCOL.md §4 needs, for control bodies and
    /// the <c>messagepack</c> codec.
    ///
    /// Values: <c>null</c>, <c>bool</c>, numbers, <c>string</c>,
    /// <c>byte[]</c> (bin), arrays (<see cref="IList"/>) and string-keyed maps
    /// (<see cref="MsgMap"/>, or any <see cref="IDictionary"/> with string
    /// keys). Decoding gives <c>long</c> for integers (<c>double</c> for a
    /// uint64 above <c>long.MaxValue</c>), <c>double</c> for floats,
    /// <c>List&lt;object?&gt;</c> for arrays and <see cref="MsgMap"/> for maps.
    /// </summary>
    public static class MessagePack
    {
        /// <summary>The largest integer written as a MessagePack integer: 2^53 − 1.</summary>
        public const double MaxSafeInteger = 9007199254740991;

        /// <summary>Nesting limit when decoding untrusted input.</summary>
        public const int MaxDepth = 512;

        public static Result<byte[]> Encode(object? value)
        {
            var writer = new ByteWriter();
            string? problem = Write(writer, value, 0);
            return problem == null
                ? Result<byte[]>.Ok(writer.ToArray())
                : Result<byte[]>.Fail(ErrorCodes.EncodeFailed, problem);
        }

        /// <summary>Writes one value per the §4 table; a message if it can't.</summary>
        public static string? Write(ByteWriter output, object? value, int depth)
        {
            if (depth > MaxDepth) return "value nested too deeply";
            switch (value)
            {
                case null:
                    output.U8(0xc0);
                    return null;
                case bool b:
                    output.U8(b ? (byte)0xc3 : (byte)0xc2);
                    return null;
                case string s:
                    WriteString(output, s);
                    return null;
                case byte[] bin:
                    WriteBin(output, bin);
                    return null;
                case long l:
                    WriteInteger(output, l);
                    return null;
                case int i:
                    WriteInteger(output, i);
                    return null;
                case ulong ul:
                    if (ul <= (ulong)MaxSafeInteger) WriteInteger(output, (long)ul);
                    else WriteFloat64(output, ul);
                    return null;
                case MsgMap map:
                    WriteMapHeader(output, map.Count);
                    foreach (var entry in map)
                    {
                        WriteString(output, entry.Key);
                        string? problem = Write(output, entry.Value, depth + 1);
                        if (problem != null) return problem;
                    }
                    return null;
                case IDictionary dictionary:
                    WriteMapHeader(output, dictionary.Count);
                    foreach (DictionaryEntry entry in dictionary)
                    {
                        if (!(entry.Key is string key)) return "map keys must be strings";
                        WriteString(output, key);
                        string? problem = Write(output, entry.Value, depth + 1);
                        if (problem != null) return problem;
                    }
                    return null;
                case IList list:
                    WriteArrayHeader(output, list.Count);
                    foreach (object? item in list)
                    {
                        string? problem = Write(output, item, depth + 1);
                        if (problem != null) return problem;
                    }
                    return null;
                default:
                    if (Numeric.TryNumber(value, out double number))
                    {
                        WriteNumber(output, number);
                        return null;
                    }
                    return "unsupported value type " + value.GetType().Name;
            }
        }

        /// <summary>
        /// A number: an integer if it has no fractional part and its magnitude
        /// is at most 2^53 − 1 (so −0 is <c>00</c>), else float64.
        /// </summary>
        public static void WriteNumber(ByteWriter output, double value)
        {
            if (value == Math.Floor(value) && Math.Abs(value) <= MaxSafeInteger)
            {
                WriteInteger(output, (long)value);
            }
            else
            {
                WriteFloat64(output, value);
            }
        }

        public static void WriteInteger(ByteWriter output, long value)
        {
            if (Math.Abs((double)value) > MaxSafeInteger)
            {
                WriteFloat64(output, value);
                return;
            }
            if (value >= 0)
            {
                if (value <= 0x7f) output.U8((byte)value);
                else if (value <= 0xff) { output.U8(0xcc); output.BigEndian((ulong)value, 1); }
                else if (value <= 0xffff) { output.U8(0xcd); output.BigEndian((ulong)value, 2); }
                else if (value <= 0xffffffffL) { output.U8(0xce); output.BigEndian((ulong)value, 4); }
                else { output.U8(0xcf); output.BigEndian((ulong)value, 8); }
                return;
            }
            if (value >= -32) output.U8((byte)(sbyte)value);
            else if (value >= sbyte.MinValue) { output.U8(0xd0); output.BigEndian((ulong)value, 1); }
            else if (value >= short.MinValue) { output.U8(0xd1); output.BigEndian((ulong)value, 2); }
            else if (value >= int.MinValue) { output.U8(0xd2); output.BigEndian((ulong)value, 4); }
            else { output.U8(0xd3); output.BigEndian((ulong)value, 8); }
        }

        public static void WriteFloat64(ByteWriter output, double value)
        {
            output.U8(0xcb);
            long bits = double.IsNaN(value) ? 0x7ff8000000000000L : BitConverter.DoubleToInt64Bits(value);
            output.BigEndian((ulong)bits, 8);
        }

        public static void WriteString(ByteWriter output, string value)
        {
            byte[] utf8 = Utf8.Encode(value);
            int n = utf8.Length;
            if (n <= 31) output.U8((byte)(0xa0 | n));
            else if (n <= 0xff) { output.U8(0xd9); output.BigEndian((ulong)n, 1); }
            else if (n <= 0xffff) { output.U8(0xda); output.BigEndian((ulong)n, 2); }
            else { output.U8(0xdb); output.BigEndian((ulong)n, 4); }
            output.Bytes(utf8, 0, n);
        }

        public static void WriteBin(ByteWriter output, byte[] value)
        {
            int n = value.Length;
            if (n <= 0xff) { output.U8(0xc4); output.BigEndian((ulong)n, 1); }
            else if (n <= 0xffff) { output.U8(0xc5); output.BigEndian((ulong)n, 2); }
            else { output.U8(0xc6); output.BigEndian((ulong)n, 4); }
            output.Bytes(value, 0, n);
        }

        public static void WriteArrayHeader(ByteWriter output, int count)
        {
            if (count <= 15) output.U8((byte)(0x90 | count));
            else if (count <= 0xffff) { output.U8(0xdc); output.BigEndian((ulong)count, 2); }
            else { output.U8(0xdd); output.BigEndian((ulong)count, 4); }
        }

        public static void WriteMapHeader(ByteWriter output, int count)
        {
            if (count <= 15) output.U8((byte)(0x80 | count));
            else if (count <= 0xffff) { output.U8(0xde); output.BigEndian((ulong)count, 2); }
            else { output.U8(0xdf); output.BigEndian((ulong)count, 4); }
        }

        // -------------------------------------------------------------------

        public static Result<object?> Decode(byte[] data) => Decode(data, 0, data.Length);

        /// <summary>
        /// Decodes exactly one value. Truncated input, trailing bytes, invalid
        /// UTF-8, a non-string map key, the key <c>__proto__</c>, a repeated
        /// key and ext types are all <c>DECODE_FAILED</c>.
        /// </summary>
        public static Result<object?> Decode(byte[] data, int offset, int count)
        {
            var reader = new ByteReader(data, offset, count);
            object? value = Read(reader, 0);
            if (!reader.Failed && !reader.Done) reader.Fail("trailing bytes after the value");
            return reader.Failed
                ? Result<object?>.Fail(ErrorCodes.DecodeFailed, "MessagePack: " + reader.Error)
                : Result<object?>.Ok(value);
        }

        private static object? Read(ByteReader input, int depth)
        {
            if (depth > MaxDepth)
            {
                input.Fail("value nested too deeply");
                return null;
            }
            byte head = input.U8();
            if (input.Failed) return null;
            if (head <= 0x7f) return (long)head;
            if (head >= 0xe0) return (long)(sbyte)head;
            if (head <= 0x8f) return ReadMap(input, head & 0x0f, depth);
            if (head <= 0x9f) return ReadArray(input, head & 0x0f, depth);
            if (head <= 0xbf) return input.Utf8String(head & 0x1f);
            switch (head)
            {
                case 0xc0: return null;
                case 0xc2: return false;
                case 0xc3: return true;
                case 0xc4: return input.Take(Length(input, 1));
                case 0xc5: return input.Take(Length(input, 2));
                case 0xc6: return input.Take(Length(input, 4));
                case 0xca: return (double)BitConverter.Int32BitsToSingle((int)input.BigEndian(4));
                case 0xcb: return BitConverter.Int64BitsToDouble((long)input.BigEndian(8));
                case 0xcc: return (long)input.BigEndian(1);
                case 0xcd: return (long)input.BigEndian(2);
                case 0xce: return (long)input.BigEndian(4);
                case 0xcf:
                {
                    ulong value = input.BigEndian(8);
                    return value <= long.MaxValue ? (object)(long)value : (double)value;
                }
                case 0xd0: return (long)(sbyte)input.BigEndian(1);
                case 0xd1: return (long)(short)input.BigEndian(2);
                case 0xd2: return (long)(int)input.BigEndian(4);
                case 0xd3: return (long)input.BigEndian(8);
                case 0xd9: return input.Utf8String(Length(input, 1));
                case 0xda: return input.Utf8String(Length(input, 2));
                case 0xdb: return input.Utf8String(Length(input, 4));
                case 0xdc: return ReadArray(input, Length(input, 2), depth);
                case 0xdd: return ReadArray(input, Length(input, 4), depth);
                case 0xde: return ReadMap(input, Length(input, 2), depth);
                case 0xdf: return ReadMap(input, Length(input, 4), depth);
                default:
                    input.Fail("unsupported MessagePack type 0x" + head.ToString("x2"));
                    return null;
            }
        }

        /// <summary>A length or count; each element takes at least one byte.</summary>
        private static int Length(ByteReader input, int size)
        {
            ulong length = input.BigEndian(size);
            if (length > (ulong)input.Remaining)
            {
                input.Fail("length " + length + " exceeds the bytes left");
                return 0;
            }
            return (int)length;
        }

        private static List<object?> ReadArray(ByteReader input, int count, int depth)
        {
            if (count > input.Remaining)
            {
                input.Fail("array count exceeds the bytes left");
                return new List<object?>();
            }
            var list = new List<object?>(count);
            for (int i = 0; i < count && !input.Failed; i++) list.Add(Read(input, depth + 1));
            return list;
        }

        private static MsgMap ReadMap(ByteReader input, int count, int depth)
        {
            var map = new MsgMap();
            if (count > input.Remaining)
            {
                input.Fail("map count exceeds the bytes left");
                return map;
            }
            for (int i = 0; i < count && !input.Failed; i++)
            {
                object? key = Read(input, depth + 1);
                if (input.Failed) break;
                if (!(key is string name))
                {
                    input.Fail("map key is not a string");
                    break;
                }
                if (name == "__proto__")
                {
                    input.Fail("forbidden map key __proto__");
                    break;
                }
                object? value = Read(input, depth + 1);
                if (input.Failed) break;
                if (!map.TryAdd(name, value)) input.Fail("repeated map key");
            }
            return map;
        }
    }
}
