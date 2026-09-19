using System;
using System.Collections;
using System.Collections.Generic;

namespace Bungohan.Protocol
{
    /// <summary>A typed contract message (generated): its declaration and payload.</summary>
    public interface IContractMessage
    {
        MessageDef MessageDefinition { get; }

        /// <summary>The payload the codecs encode: a <see cref="MsgMap"/> of the fields.</summary>
        MsgMap ToPayload();
    }

    /// <summary>
    /// Conversions between typed message fields and payload values, used by
    /// generated code. Decoded payloads hold <c>long</c> for integer kinds,
    /// <c>double</c> for float32, float64 and fixed-point, lists as
    /// <c>List&lt;object?&gt;</c> and maps as <see cref="MsgMap"/>.
    /// </summary>
    public static class Payloads
    {
        public static long ToLong(object? value) => value switch
        {
            long l => l,
            double d => (long)d,
            _ => Numeric.TryNumber(value, out double n) ? (long)n : 0,
        };

        public static double ToDouble(object? value) => Numeric.TryNumber(value, out double n) ? n : 0;

        public static List<object?> FromList<T>(IEnumerable<T>? items, Func<T, object?> convert)
        {
            var list = new List<object?>();
            if (items != null)
            {
                foreach (T item in items) list.Add(convert(item));
            }
            return list;
        }

        public static MsgMap FromMap<T>(IEnumerable<KeyValuePair<string, T>>? entries, Func<T, object?> convert)
        {
            var map = new MsgMap();
            if (entries != null)
            {
                foreach (var entry in entries) map[entry.Key] = convert(entry.Value);
            }
            return map;
        }

        public static List<T> ToList<T>(object? value, Func<object?, T> convert)
        {
            var list = new List<T>();
            if (value is IList items)
            {
                foreach (object? item in items) list.Add(convert(item));
            }
            return list;
        }

        public static Dictionary<string, T> ToDictionary<T>(object? value, Func<object?, T> convert)
        {
            var map = new Dictionary<string, T>();
            if (value is MsgMap entries)
            {
                foreach (var entry in entries) map[entry.Key] = convert(entry.Value);
            }
            return map;
        }

        public static MsgMap AsMap(object? value) => value as MsgMap ?? new MsgMap();
    }
}
