using System;
using System.Collections.Generic;

namespace Bungohan.Protocol
{
    /// <summary>Which side sends a frame; the two have separate type tables.</summary>
    public enum FrameDirection
    {
        /// <summary>Client → server.</summary>
        Client,

        /// <summary>Server → client.</summary>
        Server,
    }

    /// <summary>Client → server frame types (PROTOCOL.md §3).</summary>
    public static class ClientFrameType
    {
        public const byte RoomMessage = 0x00;
        public const byte RoomMessageRaw = 0x01;
        public const byte Join = 0x02;
        public const byte Leave = 0x03;
        public const byte Ping = 0x04;
    }

    /// <summary>Server → client frame types (PROTOCOL.md §3).</summary>
    public static class ServerFrameType
    {
        public const byte RoomMessage = 0x00;
        public const byte RoomMessageRaw = 0x01;
        public const byte StateSnapshot = 0x02;
        public const byte StatePatch = 0x03;
        public const byte JoinSuccess = 0x04;
        public const byte JoinError = 0x05;
        public const byte ClientJoined = 0x06;
        public const byte ClientLeft = 0x07;
        public const byte Leave = 0x08;
        public const byte Error = 0x09;
        public const byte Pong = 0x0a;
    }

    /// <summary>A parsed frame. <see cref="Body"/> is a view into the frame's bytes.</summary>
    public sealed class Frame
    {
        public Frame(byte type, uint[] header, ArraySegment<byte> body)
        {
            Type = type;
            Header = header;
            Body = body;
        }

        public byte Type { get; }
        public uint[] Header { get; }
        public ArraySegment<byte> Body { get; }

        /// <summary>A copy of the body.</summary>
        public byte[] BodyBytes()
        {
            var copy = new byte[Body.Count];
            if (Body.Array != null) Buffer.BlockCopy(Body.Array, Body.Offset, copy, 0, Body.Count);
            return copy;
        }
    }

    /// <summary>
    /// <c>frame = type:u8 header:varint × N(type) body</c> (PROTOCOL.md §3).
    /// One WebSocket binary message is one frame.
    /// </summary>
    public static class Frames
    {
        private static readonly int[] s_clientHeaders = { 2, 1, 1, 1, 2 };
        private static readonly int[] s_serverHeaders = { 2, 1, 1, 1, 2, 1, 1, 1, 2, 1, 1 };

        /// <summary>
        /// The number of header varints of a frame type, or −1 for a type
        /// this version doesn't know (a client drops those, §9.2).
        /// </summary>
        public static int HeaderCount(FrameDirection direction, byte type)
        {
            int[] table = direction == FrameDirection.Client ? s_clientHeaders : s_serverHeaders;
            return type < table.Length ? table[type] : -1;
        }

        public static byte[] Encode(byte type, IReadOnlyList<uint> header) =>
            Encode(type, header, Array.Empty<byte>(), 0, 0);

        public static byte[] Encode(byte type, IReadOnlyList<uint> header, byte[] body) =>
            Encode(type, header, body, 0, body.Length);

        public static byte[] Encode(byte type, IReadOnlyList<uint> header, byte[] body, int offset, int count)
        {
            int size = 1 + count;
            foreach (uint value in header) size += Varint.Size(value);
            var writer = new ByteWriter(size);
            writer.U8(type);
            foreach (uint value in header) writer.Varint(value);
            writer.Bytes(body, offset, count);
            return writer.ToArray();
        }

        /// <summary>
        /// Parses a frame. An empty message, an unknown type or a header that
        /// can't be read is <c>DECODE_FAILED</c>; use
        /// <see cref="HeaderCount"/> first to tell an unknown type apart.
        /// </summary>
        public static Result<Frame> Decode(byte[] data, FrameDirection direction) =>
            Decode(data, 0, data.Length, direction);

        public static Result<Frame> Decode(byte[] data, int offset, int count, FrameDirection direction)
        {
            if (count <= 0) return Result<Frame>.Fail(ErrorCodes.DecodeFailed, "empty frame");
            byte type = data[offset];
            int headers = HeaderCount(direction, type);
            if (headers < 0) return Result<Frame>.Fail(ErrorCodes.DecodeFailed, "unknown frame type " + type);
            int end = offset + count;
            int at = offset + 1;
            var header = new uint[headers];
            for (int i = 0; i < headers; i++)
            {
                if (!Varint.TryRead(data, at, end, out uint value, out int next))
                {
                    return Result<Frame>.Fail(ErrorCodes.DecodeFailed, "bad frame header");
                }
                header[i] = value;
                at = next;
            }
            return Result<Frame>.Ok(new Frame(type, header, new ArraySegment<byte>(data, at, end - at)));
        }
    }
}
