using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using Bungohan.Protocol;

namespace Bungohan.Protocol.Tests
{
    /// <summary>A failed check inside a test case.</summary>
    public sealed class CheckFailed : Exception
    {
        public CheckFailed(string message) : base(message) { }
    }

    /// <summary>A minimal test harness: named cases, counted, failures listed.</summary>
    public sealed class Suite
    {
        private readonly List<string> _failures = new List<string>();

        public Suite(string name)
        {
            Name = name;
        }

        public string Name { get; }
        public int Passed { get; private set; }
        public int Skipped { get; private set; }
        public IReadOnlyList<string> Failures => _failures;

        public void Run(string label, Action test)
        {
            try
            {
                test();
                Passed++;
            }
            catch (Exception error)
            {
                string reason = error is CheckFailed ? error.Message : error.ToString();
                _failures.Add(label + ": " + reason);
            }
        }

        public void Skip() => Skipped++;

        public static void That(bool condition, string message)
        {
            if (!condition) throw new CheckFailed(message);
        }

        public static void Equal(object? expected, object? actual, string what)
        {
            string? diff = Values.Difference(actual, expected, "$");
            if (diff != null) throw new CheckFailed(what + ": " + diff);
        }
    }

    /// <summary>Hex strings, JSON vectors and value comparison (PROTOCOL.md §14).</summary>
    public static class Values
    {
        public static byte[] FromHex(string hex)
        {
            var clean = new StringBuilder();
            foreach (char c in hex)
            {
                if (!char.IsWhiteSpace(c)) clean.Append(c);
            }
            if (clean.Length % 2 != 0) throw new FormatException("odd hex length");
            var bytes = new byte[clean.Length / 2];
            for (int i = 0; i < bytes.Length; i++)
            {
                bytes[i] = byte.Parse(clean.ToString(i * 2, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
            }
            return bytes;
        }

        public static string ToHex(byte[] bytes) => Convert.ToHexString(bytes).ToLowerInvariant();

        /// <summary>
        /// A JSON element as a plain value: numbers as double (with
        /// <c>{"f64": bits}</c> for NaN, ±Infinity and −0), arrays as
        /// <c>List&lt;object?&gt;</c>, objects as <see cref="MsgMap"/>.
        /// </summary>
        public static object? FromJson(JsonElement element)
        {
            switch (element.ValueKind)
            {
                case JsonValueKind.Null: return null;
                case JsonValueKind.True: return true;
                case JsonValueKind.False: return false;
                case JsonValueKind.String: return element.GetString();
                case JsonValueKind.Number: return element.GetDouble();
                case JsonValueKind.Array:
                {
                    var list = new List<object?>();
                    foreach (JsonElement item in element.EnumerateArray()) list.Add(FromJson(item));
                    return list;
                }
                default:
                {
                    var map = new MsgMap();
                    int count = 0;
                    string? bits = null;
                    foreach (JsonProperty property in element.EnumerateObject())
                    {
                        count++;
                        if (property.Name == "f64" && property.Value.ValueKind == JsonValueKind.String) bits = property.Value.GetString();
                        map[property.Name] = FromJson(property.Value);
                    }
                    if (count == 1 && bits != null)
                    {
                        return BitConverter.Int64BitsToDouble(long.Parse(bits, NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                    }
                    return map;
                }
            }
        }

        public static MsgMap LoadFile(string path)
        {
            using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
            return (MsgMap)FromJson(document.RootElement)!;
        }

        /// <summary>
        /// Deep equality where numbers compare like JavaScript's
        /// <c>Object.is</c> (NaN equals NaN, −0 differs from 0), whatever their
        /// CLR type. Returns the path of the first difference, or null.
        /// </summary>
        public static string? Difference(object? actual, object? expected, string path)
        {
            bool actualNumber = Numeric.TryNumber(actual, out double a);
            bool expectedNumber = Numeric.TryNumber(expected, out double e);
            if (actualNumber || expectedNumber)
            {
                return actualNumber && expectedNumber && Numeric.SameValue(a, e)
                    ? null
                    : path + ": " + Show(actual) + " ≠ " + Show(expected);
            }
            if (actual is WireRef r) actual = new List<object?> { (double)r.ClassId, (double)r.RefId };
            if (expected is System.Collections.IList || actual is System.Collections.IList)
            {
                if (!(expected is System.Collections.IList x) || !(actual is System.Collections.IList y) || expected is string || actual is string)
                {
                    return path + ": array vs non-array (" + Show(actual) + " vs " + Show(expected) + ")";
                }
                if (x.Count != y.Count) return path + ": length " + y.Count + " ≠ " + x.Count;
                for (int i = 0; i < x.Count; i++)
                {
                    string? diff = Difference(y[i], x[i], path + "[" + i + "]");
                    if (diff != null) return diff;
                }
                return null;
            }
            if (expected is MsgMap || actual is MsgMap)
            {
                if (!(expected is MsgMap xm) || !(actual is MsgMap ym)) return path + ": object vs non-object";
                var keys = new List<string>(ym.Keys);
                foreach (string key in xm.Keys)
                {
                    if (!ym.ContainsKey(key)) keys.Add(key);
                }
                foreach (string key in keys)
                {
                    if (!ym.ContainsKey(key)) return path + "." + key + ": missing";
                    if (!xm.ContainsKey(key)) return path + "." + key + ": unexpected";
                    string? diff = Difference(ym[key], xm[key], path + "." + key);
                    if (diff != null) return diff;
                }
                return null;
            }
            if (actual is byte[] ab && expected is byte[] eb) return ToHex(ab) == ToHex(eb) ? null : path + ": bytes differ";
            return Equals(actual, expected) ? null : path + ": " + Show(actual) + " ≠ " + Show(expected);
        }

        public static string Show(object? value) => value switch
        {
            null => "null",
            string s => "\"" + s + "\"",
            bool b => b ? "true" : "false",
            double d => d.ToString("R", CultureInfo.InvariantCulture),
            _ => value.ToString() ?? "?",
        };

        /// <summary>Walks up from the working directory to the repository root.</summary>
        public static string RepoRoot()
        {
            string? dir = Directory.GetCurrentDirectory();
            while (dir != null)
            {
                if (Directory.Exists(Path.Combine(dir, "conformance", "v1"))) return dir;
                dir = Path.GetDirectoryName(dir);
            }
            dir = AppContext.BaseDirectory;
            while (dir != null)
            {
                if (Directory.Exists(Path.Combine(dir, "conformance", "v1"))) return dir;
                dir = Path.GetDirectoryName(dir);
            }
            throw new DirectoryNotFoundException("conformance/v1 not found above the working directory");
        }
    }
}
