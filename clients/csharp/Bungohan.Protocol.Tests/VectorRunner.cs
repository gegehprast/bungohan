using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Bungohan.Protocol;

namespace Bungohan.Protocol.Tests
{
    /// <summary>
    /// Runs every conformance vector (PROTOCOL.md §14). Codec cases run in
    /// both directions: encode → exact bytes, and bytes → decoded values;
    /// <c>replica</c> cases run in <see cref="ReplicaVectors"/> and
    /// <c>behavior</c> cases in <see cref="BehaviorTests"/>. Server-side
    /// <c>behavior</c> cases need the interop server
    /// (<c>BUNGOHAN_INTEROP_URL</c>, set by <c>bun run test:csharp</c>);
    /// without it they are the only cases skipped.
    /// </summary>
    public static class VectorRunner
    {
        private static readonly Dictionary<string, IStateCodec> s_codecs = new Dictionary<string, IStateCodec>
        {
            ["schema"] = new SchemaCodec(),
            ["messagepack"] = new MessagePackCodec(),
        };

        public static Suite Run(string root)
        {
            var suite = new Suite("conformance vectors");
            string? interopUrl = Environment.GetEnvironmentVariable("BUNGOHAN_INTEROP_URL");
            string dir = Path.Combine(root, "conformance", "v1");
            string[] files = Directory.GetFiles(dir, "*.json").OrderBy(f => f, StringComparer.Ordinal).ToArray();
            Suite.That(files.Length > 0, "no vector files in " + dir);
            foreach (string file in files)
            {
                MsgMap vectors = Values.LoadFile(file);
                var cases = (List<object?>)vectors["cases"]!;
                for (int i = 0; i < cases.Count; i++)
                {
                    var c = (MsgMap)cases[i]!;
                    string kind = (string)c["kind"]!;
                    string label = Path.GetFileName(file) + " #" + i + " " + kind +
                                   (c["description"] is string d ? ": " + d : "");
                    switch (kind)
                    {
                        case "varint": suite.Run(label, () => VarintCase(c, false)); break;
                        case "zigzag": suite.Run(label, () => VarintCase(c, true)); break;
                        case "fixed":
                        case "int":
                        case "float32": suite.Run(label, () => NumericCase(c, kind)); break;
                        case "frame": suite.Run(label, () => FrameCase(c)); break;
                        case "messagepack": suite.Run(label, () => MessagePackCase(c)); break;
                        case "message": suite.Run(label, () => MessageCase(c)); break;
                        case "state": suite.Run(label, () => StateCase(c)); break;
                        case "replica": suite.Run(label, () => ReplicaVectors.Run(c)); break;
                        case "behavior":
                            if ((string?)c["side"] == "server")
                            {
                                if (string.IsNullOrEmpty(interopUrl)) suite.Skip();
                                else suite.Run(label, () => BehaviorTests.ServerCase(c, interopUrl));
                            }
                            else
                            {
                                suite.Run(label, () => BehaviorTests.ClientCase(c));
                            }
                            break;
                        default: suite.Run(label, () => throw new CheckFailed("unknown case kind " + kind)); break;
                    }
                }
            }
            return suite;
        }

        private static void VarintCase(MsgMap c, bool signed)
        {
            byte[] bytes = Values.FromHex((string)c["hex"]!);
            bool read = Varint.TryRead(bytes, 0, bytes.Length, out uint value, out int next);
            if (c["error"] is true)
            {
                Suite.That(!read || next != bytes.Length, "decoding should fail");
                return;
            }
            Suite.That(read && next == bytes.Length, "decode failed or left bytes");
            double expected = (double)c["value"]!;
            double actual = signed ? Varint.Unzigzag(value) : value;
            Suite.Equal(expected, actual, "decoded value");
            if (c["encode"] is false) return;
            var writer = new ByteWriter();
            if (signed) writer.Zigzag((int)expected);
            else writer.Varint((uint)expected);
            Suite.Equal(Values.ToHex(bytes), Values.ToHex(writer.ToArray()), "encoded bytes");
        }

        private static void NumericCase(MsgMap c, string kind)
        {
            double value = (double)c["value"]!;
            double wire = (double)c["wire"]!;
            double actual = kind switch
            {
                "fixed" => Numeric.FixedEncode(value, (int)(double)c["decimals"]!),
                "int" => Numeric.IntEncode(value, IntKindOf((string)c["type"]!)),
                _ => Numeric.Float32(value),
            };
            Suite.Equal(wire, actual, kind);
        }

        private static IntKind IntKindOf(string type) => type switch
        {
            "int8" => IntKind.Int8,
            "int16" => IntKind.Int16,
            "int32" => IntKind.Int32,
            "uint8" => IntKind.UInt8,
            "uint16" => IntKind.UInt16,
            "uint32" => IntKind.UInt32,
            _ => throw new CheckFailed("bad int type " + type),
        };

        private static void FrameCase(MsgMap c)
        {
            var direction = (string)c["direction"]! == "client" ? FrameDirection.Client : FrameDirection.Server;
            byte[] bytes = Values.FromHex((string)c["hex"]!);
            Result<Frame> parsed = Frames.Decode(bytes, direction);
            if (c["error"] is true)
            {
                Suite.That(!parsed.IsOk, "parsing should fail");
                return;
            }
            byte[] body = Values.FromHex((string)c["bodyHex"]!);
            if (c.ContainsKey("body"))
            {
                Result<byte[]> encodedBody = MessagePack.Encode(c["body"]);
                Suite.That(encodedBody.IsOk, "body encode failed: " + encodedBody.Error);
                Suite.Equal(Values.ToHex(body), Values.ToHex(encodedBody.Value), "body bytes");
                Result<object?> decodedBody = MessagePack.Decode(body);
                Suite.That(decodedBody.IsOk, "body decode failed: " + decodedBody.Error);
                Suite.Equal(c["body"], decodedBody.Value, "decoded body");
            }
            byte type = (byte)(double)c["type"]!;
            uint[] header = ((List<object?>)c["header"]!).Select(h => (uint)(double)h!).ToArray();
            byte[] built = Frames.Encode(type, header, body);
            Suite.Equal(Values.ToHex(bytes), Values.ToHex(built), "built frame");
            Suite.That(parsed.IsOk, "parse failed: " + parsed.Error);
            Frame frame = parsed.Value;
            Suite.Equal((double)type, (double)frame.Type, "type");
            Suite.Equal(c["header"], frame.Header.Select(h => (object?)(double)h).ToList(), "header");
            Suite.Equal(Values.ToHex(body), Values.ToHex(frame.BodyBytes()), "body");
        }

        private static void MessagePackCase(MsgMap c)
        {
            byte[] bytes = Values.FromHex((string)c["hex"]!);
            Result<byte[]> encoded = MessagePack.Encode(c["value"]);
            Suite.That(encoded.IsOk, "encode failed: " + encoded.Error);
            Suite.Equal(Values.ToHex(bytes), Values.ToHex(encoded.Value), "encoded bytes");
            Result<object?> decoded = MessagePack.Decode(bytes);
            Suite.That(decoded.IsOk, "decode failed: " + decoded.Error);
            Suite.Equal(c.ContainsKey("decoded") ? c["decoded"] : c["value"], decoded.Value, "decoded value");
        }

        private static void MessageCase(MsgMap c)
        {
            MessageDef def = MessageOf(c["message"]);
            var hexes = (MsgMap)c["hex"]!;
            foreach (var entry in hexes)
            {
                IStateCodec codec = s_codecs[entry.Key];
                byte[] bytes = Values.FromHex((string)entry.Value!);
                Result<MsgMap> decoded = codec.DecodeMessage(def, bytes, 0, bytes.Length);
                if (c["error"] is true)
                {
                    Suite.That(!decoded.IsOk, entry.Key + ": decoding should fail");
                    continue;
                }
                Result<byte[]> encoded = codec.EncodeMessage(def, (MsgMap)c["payload"]!);
                Suite.That(encoded.IsOk, entry.Key + ": encode failed: " + encoded.Error);
                Suite.Equal(Values.ToHex(bytes), Values.ToHex(encoded.Value), entry.Key + " bytes");
                Suite.That(decoded.IsOk, entry.Key + ": decode failed: " + decoded.Error);
                Suite.Equal(c.ContainsKey("decoded") ? c["decoded"] : c["payload"], decoded.Value, entry.Key + " decoded");
            }
        }

        private static void StateCase(MsgMap c)
        {
            IStateCodec codec = s_codecs[(string)c["codec"]!];
            IStateCodecSession encoder = codec.CreateSession();
            List<string> clients = c["clients"] is List<object?> names
                ? names.Select(n => (string)n!).ToList()
                : new List<string> { "a" };
            var decoders = clients.ToDictionary(name => name, _ => codec.CreateSession());
            var frames = (List<object?>)c["frames"]!;
            for (int i = 0; i < frames.Count; i++)
            {
                var frame = (MsgMap)frames[i]!;
                List<string> to = frame["to"] is List<object?> targets
                    ? targets.Select(n => (string)n!).ToList()
                    : clients;
                List<WireOp>? ops = frame.ContainsKey("ops") ? OpsOf((List<object?>)frame["ops"]!) : null;
                if (frame["error"] is true)
                {
                    if (ops != null) Suite.That(!encoder.EncodeOps(ops).IsOk, "frame " + i + ": encoding should fail");
                    if (frame["hex"] is string errorHex)
                    {
                        byte[] errorBytes = Values.FromHex(errorHex);
                        foreach (string name in to)
                        {
                            Suite.That(!decoders[name].DecodeOps(errorBytes, 0, errorBytes.Length).IsOk,
                                "frame " + i + ", " + name + ": decoding should fail");
                        }
                    }
                    return; // an error ends the case
                }
                Suite.That(ops != null, "frame " + i + ": no ops");
                byte[] bytes = Values.FromHex((string)frame["hex"]!);
                if (!(frame["encode"] is false))
                {
                    Result<byte[]> encoded = encoder.EncodeOps(ops!);
                    Suite.That(encoded.IsOk, "frame " + i + ": encode failed: " + encoded.Error);
                    Suite.Equal(Values.ToHex(bytes), Values.ToHex(encoded.Value), "frame " + i + " bytes");
                }
                object? expected = frame.ContainsKey("decoded") ? frame["decoded"] : frame["ops"];
                foreach (string name in to)
                {
                    Result<List<WireOp>> decoded = decoders[name].DecodeOps(bytes, 0, bytes.Length);
                    Suite.That(decoded.IsOk, "frame " + i + ", " + name + ": decode failed: " + decoded.Error);
                    Suite.Equal(expected, decoded.Value.Select(op => (object?)op.ToTuple()).ToList(), "frame " + i + ", " + name + " ops");
                }
            }
        }

        // --- vector JSON → protocol objects --------------------------------

        /// <summary>A declaration <c>{ name, fields: [[name, type], …] }</c> (§14).</summary>
        public static MessageDef MessageOf(object? declaration)
        {
            var decl = (MsgMap)declaration!;
            var fields = ((List<object?>)decl["fields"]!)
                .Select(f => (List<object?>)f!)
                .Select(f => new MessageField((string)f[0]!, FieldOf(f[1])))
                .ToArray();
            return new MessageDef((string)decl["name"]!, fields);
        }

        private static FieldType FieldOf(object? type)
        {
            if (type is string s)
            {
                if (s.StartsWith("fixed:", StringComparison.Ordinal)) return FieldType.Fixed(s[6] - '0');
                return s switch
                {
                    "int8" => FieldType.Int8,
                    "int16" => FieldType.Int16,
                    "int32" => FieldType.Int32,
                    "uint8" => FieldType.UInt8,
                    "uint16" => FieldType.UInt16,
                    "uint32" => FieldType.UInt32,
                    "float32" => FieldType.Float32,
                    "float64" => FieldType.Float64,
                    "string" => FieldType.String,
                    "bool" => FieldType.Bool,
                    _ => throw new CheckFailed("unknown type " + s),
                };
            }
            var map = (MsgMap)type!;
            if (map["enum"] is List<object?> values) return FieldType.Enum(values.Select(v => v!).ToArray());
            if (map.ContainsKey("array")) return FieldType.ArrayOf(FieldOf(map["array"]));
            if (map.ContainsKey("map")) return FieldType.MapOf(FieldOf(map["map"]));
            if (map.ContainsKey("optional")) return FieldType.OptionalOf(FieldOf(map["optional"]));
            if (map.ContainsKey("nested")) return FieldType.NestedOf(MessageOf(map["nested"]));
            throw new CheckFailed("bad type");
        }

        /// <summary>Op tuples (§11.1) → ops. Anything malformed is kept for the encoder to refuse.</summary>
        public static List<WireOp> OpsOf(List<object?> tuples) => tuples.Select(t => OpOf((List<object?>)t!)).ToList();

        private static WireOp OpOf(List<object?> t)
        {
            var code = (int)(double)t[0]!;
            var target = (long)(double)t[1]!;
            switch (code)
            {
                case 0: return WireOp.Set(target, (double)t[2]!, ValueOf(t[3]));
                case 1: return t.Count == 3 ? WireOp.AddToSet(target, ValueOf(t[2])) : WireOp.Add(target, t[2]!, ValueOf(t[3]));
                case 2: return WireOp.Remove(target, t[2]!);
                case 3: return WireOp.Clear(target);
                default:
                    return WireOp.Define(target, (string)t[2]!,
                        ((List<object?>)t[3]!).Select(x => (string)x!).ToList(),
                        ((List<object?>)t[4]!).Select(x => (string)x!).ToList());
            }
        }

        private static object ValueOf(object? value) =>
            value is List<object?> r ? new WireRef((long)(double)r[0]!, (long)(double)r[1]!) : value!;
    }
}
