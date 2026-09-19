using System;

namespace Bungohan.Protocol
{
    /// <summary>The integer kinds of fields, keys and message values.</summary>
    public enum IntKind
    {
        Int8,
        Int16,
        Int32,
        UInt8,
        UInt16,
        UInt32,
    }

    /// <summary>
    /// The numeric rules of PROTOCOL.md §12, which every implementation must
    /// reproduce bit for bit: fixed-point, integer conversion, float32.
    /// </summary>
    public static class Numeric
    {
        /// <summary>10^n as exact binary64 values, n = 0…9.</summary>
        private static readonly double[] s_scale = { 1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9 };

        public static long Min(IntKind kind) => kind switch
        {
            IntKind.Int8 => sbyte.MinValue,
            IntKind.Int16 => short.MinValue,
            IntKind.Int32 => int.MinValue,
            _ => 0,
        };

        public static long Max(IntKind kind) => kind switch
        {
            IntKind.Int8 => sbyte.MaxValue,
            IntKind.Int16 => short.MaxValue,
            IntKind.Int32 => int.MaxValue,
            IntKind.UInt8 => byte.MaxValue,
            IntKind.UInt16 => ushort.MaxValue,
            _ => uint.MaxValue,
        };

        /// <summary>
        /// §12.1 encode: <c>x × 10^n</c> in binary64, rounded half away from
        /// zero, saturated to int32. NaN → 0; never −0.
        /// </summary>
        public static int FixedEncode(double value, int decimals)
        {
            if (double.IsNaN(value)) return 0;
            double scaled = value * s_scale[decimals];
            // Not Math.Round(scaled): that rounds half to even (−2.5 → −2).
            double rounded = Math.Round(scaled, MidpointRounding.AwayFromZero);
            if (rounded <= int.MinValue) return int.MinValue;
            if (rounded >= int.MaxValue) return int.MaxValue;
            return (int)rounded; // (int)−0.0 is 0
        }

        /// <summary>§12.1 decode: divides (never multiplies by 0.1^n).</summary>
        public static double FixedDecode(int wire, int decimals) => wire / s_scale[decimals];

        /// <summary>
        /// §12.2: truncate toward zero, saturate to the kind's range. NaN → 0;
        /// never −0.
        /// </summary>
        public static long IntEncode(double value, IntKind kind)
        {
            if (double.IsNaN(value)) return 0;
            long min = Min(kind), max = Max(kind);
            if (value <= min) return min;
            if (value >= max) return max;
            return (long)Math.Truncate(value);
        }

        /// <summary>True if <paramref name="value"/> is an integer inside the kind's range.</summary>
        public static bool IsIntOf(double value, IntKind kind) =>
            value == Math.Floor(value) && value >= Min(kind) && value <= Max(kind);

        /// <summary>§12.3: rounds to binary32 (ties to even).</summary>
        public static double Float32(double value) => (float)value;

        /// <summary>
        /// True if <paramref name="value"/> is a number (any CLR numeric type),
        /// with its value as a double.
        /// </summary>
        public static bool TryNumber(object? value, out double number)
        {
            switch (value)
            {
                case double d: number = d; return true;
                case float f: number = f; return true;
                case int i: number = i; return true;
                case long l: number = l; return true;
                case uint u: number = u; return true;
                case short s: number = s; return true;
                case ushort us: number = us; return true;
                case byte b: number = b; return true;
                case sbyte sb: number = sb; return true;
                case ulong ul: number = ul; return true;
                case decimal m: number = (double)m; return true;
                default: number = 0; return false;
            }
        }

        /// <summary>
        /// JavaScript's <c>Object.is</c> on numbers: NaN equals NaN, and −0
        /// differs from 0.
        /// </summary>
        public static bool SameValue(double a, double b)
        {
            if (double.IsNaN(a)) return double.IsNaN(b);
            return BitConverter.DoubleToInt64Bits(a) == BitConverter.DoubleToInt64Bits(b);
        }
    }
}
