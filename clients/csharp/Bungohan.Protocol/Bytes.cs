using System;

namespace Bungohan.Protocol
{
    /// <summary>Varints (PROTOCOL.md §1.1) and zigzag (§1.2).</summary>
    public static class Varint
    {
        public const uint Max = uint.MaxValue;

        /// <summary>Bytes <paramref name="value"/> takes as a varint.</summary>
        public static int Size(uint value)
        {
            int size = 1;
            while (value >= 0x80)
            {
                value >>= 7;
                size++;
            }
            return size;
        }

        /// <summary>
        /// Reads a varint at <paramref name="offset"/>. False if it is
        /// truncated, longer than 5 bytes or above 2^32 − 1.
        /// </summary>
        public static bool TryRead(byte[] data, int offset, int end, out uint value, out int next)
        {
            ulong result = 0;
            for (int i = 0; i < 5; i++)
            {
                int at = offset + i;
                if (at >= end) break;
                byte b = data[at];
                result |= (ulong)(b & 0x7f) << (7 * i);
                if ((b & 0x80) == 0)
                {
                    next = at + 1;
                    value = (uint)result;
                    return result <= Max;
                }
            }
            value = 0;
            next = offset;
            return false;
        }

        /// <summary>Maps an int32 to a uint32: 0, −1, 1, −2 → 0, 1, 2, 3.</summary>
        public static uint Zigzag(int value) => (uint)((value << 1) ^ (value >> 31));

        /// <summary>Inverse of <see cref="Zigzag"/>.</summary>
        public static int Unzigzag(uint value) => (int)(value >> 1) ^ -(int)(value & 1);
    }

    /// <summary>
    /// A growable output buffer for the PROTOCOL.md §1 primitives. Floats
    /// are little-endian whatever the platform, and NaN is written in its
    /// canonical form.
    /// </summary>
    public sealed class ByteWriter
    {
        private byte[] _bytes;

        public ByteWriter(int capacity = 256)
        {
            _bytes = new byte[Math.Max(16, capacity)];
        }

        public int Length { get; private set; }

        public void Reset() => Length = 0;

        /// <summary>A copy of the contents.</summary>
        public byte[] ToArray()
        {
            var copy = new byte[Length];
            Buffer.BlockCopy(_bytes, 0, copy, 0, Length);
            return copy;
        }

        /// <summary>Overwrites an already-written byte.</summary>
        public void Patch(int at, byte value) => _bytes[at] = value;

        public void U8(byte value)
        {
            Reserve(1);
            _bytes[Length++] = value;
        }

        public void Bytes(byte[] data, int offset, int count)
        {
            Reserve(count);
            Buffer.BlockCopy(data, offset, _bytes, Length, count);
            Length += count;
        }

        public void Varint(uint value)
        {
            Reserve(5);
            while (value >= 0x80)
            {
                _bytes[Length++] = (byte)(value | 0x80);
                value >>= 7;
            }
            _bytes[Length++] = (byte)value;
        }

        public void Zigzag(int value) => Varint(Protocol.Varint.Zigzag(value));

        public void Float64(double value)
        {
            long bits = double.IsNaN(value) ? 0x7ff8000000000000L : BitConverter.DoubleToInt64Bits(value);
            Reserve(8);
            for (int i = 0; i < 8; i++) _bytes[Length++] = (byte)(bits >> (8 * i));
        }

        /// <summary>Writes <paramref name="value"/> rounded to binary32 (ties to even).</summary>
        public void Float32(double value)
        {
            int bits = double.IsNaN(value) ? 0x7fc00000 : BitConverter.SingleToInt32Bits((float)value);
            Reserve(4);
            for (int i = 0; i < 4; i++) _bytes[Length++] = (byte)(bits >> (8 * i));
        }

        /// <summary>Varint byte length, then the UTF-8 bytes.</summary>
        public void String(string value)
        {
            byte[] utf8 = Utf8.Encode(value);
            Varint((uint)utf8.Length);
            Bytes(utf8, 0, utf8.Length);
        }

        /// <summary>Big-endian unsigned integer of <paramref name="size"/> bytes (MessagePack).</summary>
        public void BigEndian(ulong value, int size)
        {
            Reserve(size);
            for (int i = size - 1; i >= 0; i--) _bytes[Length++] = (byte)(value >> (8 * i));
        }

        private void Reserve(int extra)
        {
            int needed = Length + extra;
            if (needed <= _bytes.Length) return;
            int size = _bytes.Length * 2;
            while (size < needed) size *= 2;
            Array.Resize(ref _bytes, size);
        }
    }

    /// <summary>
    /// Reads PROTOCOL.md §1 primitives. Errors are sticky: the first failed
    /// read records <see cref="Error"/>, and every later read returns a zero
    /// value, so callers check once per op rather than per read.
    /// </summary>
    public sealed class ByteReader
    {
        private readonly byte[] _bytes;
        private readonly int _end;

        public ByteReader(byte[] bytes) : this(bytes, 0, bytes.Length) { }

        public ByteReader(byte[] bytes, int offset, int count)
        {
            _bytes = bytes;
            Position = offset;
            _end = offset + count;
        }

        public string? Error { get; private set; }
        public int Position { get; private set; }
        public int Remaining => _end - Position;
        public bool Done => Position >= _end;
        public bool Failed => Error != null;

        /// <summary>Records a failure (the first one wins) and stops reading.</summary>
        public void Fail(string message)
        {
            if (Error == null) Error = message + " (at byte " + Position + ")";
            Position = _end;
        }

        public byte U8()
        {
            if (Position >= _end)
            {
                Fail("unexpected end of data");
                return 0;
            }
            return _bytes[Position++];
        }

        public uint Varint()
        {
            if (Protocol.Varint.TryRead(_bytes, Position, _end, out uint value, out int next))
            {
                Position = next;
                return value;
            }
            Fail("bad varint (truncated, longer than 5 bytes, or above 2^32-1)");
            return 0;
        }

        /// <summary>A count or length, which can't exceed the bytes left.</summary>
        public int Count()
        {
            uint count = Varint();
            if (count > (uint)Remaining)
            {
                Fail("count " + count + " exceeds the " + Remaining + " bytes left");
                return 0;
            }
            return (int)count;
        }

        public int Zigzag() => Protocol.Varint.Unzigzag(Varint());

        public double Float64()
        {
            if (Remaining < 8)
            {
                Fail("truncated float64");
                return 0;
            }
            long bits = 0;
            for (int i = 0; i < 8; i++) bits |= (long)_bytes[Position + i] << (8 * i);
            Position += 8;
            return BitConverter.Int64BitsToDouble(bits);
        }

        public double Float32()
        {
            if (Remaining < 4)
            {
                Fail("truncated float32");
                return 0;
            }
            int bits = 0;
            for (int i = 0; i < 4; i++) bits |= _bytes[Position + i] << (8 * i);
            Position += 4;
            return BitConverter.Int32BitsToSingle(bits);
        }

        public string String()
        {
            int length = Count();
            if (Failed) return "";
            string? text = Utf8.Decode(_bytes, Position, length);
            if (text == null)
            {
                Fail("invalid UTF-8");
                return "";
            }
            Position += length;
            return text;
        }

        /// <summary>Big-endian unsigned integer of <paramref name="size"/> bytes (MessagePack).</summary>
        public ulong BigEndian(int size)
        {
            if (Remaining < size)
            {
                Fail("truncated value");
                return 0;
            }
            ulong value = 0;
            for (int i = 0; i < size; i++) value = (value << 8) | _bytes[Position + i];
            Position += size;
            return value;
        }

        /// <summary>A copy of the next <paramref name="count"/> bytes.</summary>
        public byte[] Take(int count)
        {
            if (Remaining < count)
            {
                Fail("truncated value");
                return Array.Empty<byte>();
            }
            var copy = new byte[count];
            Buffer.BlockCopy(_bytes, Position, copy, 0, count);
            Position += count;
            return copy;
        }

        /// <summary>Decodes UTF-8 of <paramref name="count"/> bytes (MessagePack strings).</summary>
        public string Utf8String(int count)
        {
            if (Remaining < count)
            {
                Fail("truncated string");
                return "";
            }
            string? text = Utf8.Decode(_bytes, Position, count);
            if (text == null)
            {
                Fail("invalid UTF-8");
                return "";
            }
            Position += count;
            return text;
        }
    }
}
