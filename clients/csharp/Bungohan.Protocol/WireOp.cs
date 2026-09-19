using System;
using System.Collections.Generic;

namespace Bungohan.Protocol
{
    /// <summary>State op codes (PROTOCOL.md §11.1).</summary>
    public enum OpCode : byte
    {
        Set = 0,
        Add = 1,
        Remove = 2,
        Clear = 3,
        Define = 4,
    }

    /// <summary>A reference to a schema instance: <c>[classId, refId]</c>.</summary>
    public readonly struct WireRef : IEquatable<WireRef>
    {
        public WireRef(long classId, long refId)
        {
            ClassId = classId;
            RefId = refId;
        }

        public long ClassId { get; }
        public long RefId { get; }

        public bool Equals(WireRef other) => ClassId == other.ClassId && RefId == other.RefId;
        public override bool Equals(object? obj) => obj is WireRef other && Equals(other);
        public override int GetHashCode() => HashCode.Combine(ClassId, RefId);
        public override string ToString() => "[" + ClassId + ", " + RefId + "]";
    }

    /// <summary>
    /// One state op, the codec-independent unit of a state frame. Values and
    /// keys are <c>double</c> (every number), <c>string</c>, <c>bool</c> or
    /// (values only) <see cref="WireRef"/>. They are wire values (§12.5): a
    /// <c>fixed:2</c> field carries its integer.
    /// </summary>
    public sealed class WireOp
    {
        private WireOp(OpCode code, long target)
        {
            Code = code;
            Target = target;
        }

        public OpCode Code { get; }

        /// <summary>The target refId; for <c>DEFINE</c>, the classId.</summary>
        public long Target { get; }

        /// <summary>
        /// <c>SET</c>: the field index or array index. <c>ADD</c>: the map key
        /// or array index (absent for a set). <c>REMOVE</c>: the key, index or
        /// element (a schema set's element refId).
        /// </summary>
        public object? Key { get; private set; }

        /// <summary>Whether <see cref="Key"/> is present (an <c>ADD</c> on a set has none).</summary>
        public bool HasKey { get; private set; }

        /// <summary>The value of a <c>SET</c> or <c>ADD</c>.</summary>
        public object? Value { get; private set; }

        /// <summary><c>DEFINE</c>: the class name.</summary>
        public string Name { get; private set; } = "";

        /// <summary><c>DEFINE</c>: field names, in field order.</summary>
        public IReadOnlyList<string> Fields { get; private set; } = Array.Empty<string>();

        /// <summary><c>DEFINE</c>: field types, parallel to <see cref="Fields"/>.</summary>
        public IReadOnlyList<string> Types { get; private set; } = Array.Empty<string>();

        public static WireOp Set(long target, double index, object value) =>
            new WireOp(OpCode.Set, target) { Key = index, HasKey = true, Value = value };

        public static WireOp Add(long target, object key, object value) =>
            new WireOp(OpCode.Add, target) { Key = key, HasKey = true, Value = value };

        /// <summary>A set's <c>ADD</c>: <c>[1, target, value]</c>.</summary>
        public static WireOp AddToSet(long target, object value) =>
            new WireOp(OpCode.Add, target) { Value = value };

        public static WireOp Remove(long target, object key) =>
            new WireOp(OpCode.Remove, target) { Key = key, HasKey = true };

        public static WireOp Clear(long target) => new WireOp(OpCode.Clear, target);

        public static WireOp Define(long classId, string name, IReadOnlyList<string> fields, IReadOnlyList<string> types) =>
            new WireOp(OpCode.Define, classId) { Name = name, Fields = fields, Types = types };

        /// <summary>The op as its §11.1 tuple (numbers as doubles, refs as 2-element lists).</summary>
        public List<object?> ToTuple()
        {
            var tuple = new List<object?> { (double)(int)Code, (double)Target };
            switch (Code)
            {
                case OpCode.Define:
                    tuple.Add(Name);
                    tuple.Add(new List<object?>(Fields));
                    tuple.Add(new List<object?>(Types));
                    break;
                case OpCode.Clear:
                    break;
                case OpCode.Remove:
                    tuple.Add(Key);
                    break;
                default:
                    if (HasKey) tuple.Add(Key);
                    tuple.Add(Value is WireRef r ? new List<object?> { (double)r.ClassId, (double)r.RefId } : Value);
                    break;
            }
            return tuple;
        }

        public override string ToString() => Describe(ToTuple());

        private static string Describe(object? value) => value switch
        {
            null => "null",
            string s => "\"" + s + "\"",
            bool b => b ? "true" : "false",
            double d => d.ToString("R", System.Globalization.CultureInfo.InvariantCulture),
            List<object?> list => "[" + string.Join(", ", list.ConvertAll(Describe)) + "]",
            _ => value.ToString() ?? "",
        };
    }

    /// <summary>One entry of a stream's class table (from a <c>DEFINE</c>).</summary>
    public sealed class ClassEntry
    {
        public ClassEntry(long classId, string name, IReadOnlyList<string> fields, IReadOnlyList<string> types)
        {
            ClassId = classId;
            Name = name;
            Fields = fields;
            Types = types;
        }

        public long ClassId { get; }
        public string Name { get; }
        public IReadOnlyList<string> Fields { get; }
        public IReadOnlyList<string> Types { get; }

        public bool SameAs(ClassEntry other)
        {
            if (Name != other.Name || Fields.Count != other.Fields.Count || Types.Count != other.Types.Count) return false;
            for (int i = 0; i < Fields.Count; i++)
            {
                if (Fields[i] != other.Fields[i] || Types[i] != other.Types[i]) return false;
            }
            return true;
        }
    }

    /// <summary>
    /// A stream's class table, built from its <c>DEFINE</c>s: a new class must
    /// take the next id, a known one must be restated identically (§11.2).
    /// </summary>
    public sealed class ClassTable
    {
        private readonly List<ClassEntry> _classes = new List<ClassEntry>();

        public int Count => _classes.Count;

        public ClassEntry? Get(long classId) =>
            classId >= 0 && classId < _classes.Count ? _classes[(int)classId] : null;

        public IReadOnlyList<ClassEntry> Entries => _classes;

        /// <summary>Forgets every class from <paramref name="size"/> on (rollback).</summary>
        public void Truncate(int size)
        {
            if (size < _classes.Count) _classes.RemoveRange(size, _classes.Count - size);
        }

        /// <summary>Applies one <c>DEFINE</c>; a message if it is invalid.</summary>
        public string? Define(WireOp op)
        {
            var entry = new ClassEntry(op.Target, op.Name, op.Fields, op.Types);
            ClassEntry? existing = Get(op.Target);
            if (existing != null)
            {
                return existing.SameAs(entry)
                    ? null
                    : "DEFINE " + op.Target + " (" + op.Name + ") contradicts the known " + existing.Name;
            }
            if (op.Target != _classes.Count)
            {
                return "DEFINE " + op.Target + " (" + op.Name + ") skips ahead of class " + _classes.Count;
            }
            _classes.Add(entry);
            return null;
        }

        /// <summary>Checks a <c>DEFINE</c>'s shape: parallel lists, parseable types.</summary>
        public static string? CheckDefine(WireOp op)
        {
            if (op.Target < 0 || op.Target > uint.MaxValue) return "DEFINE: bad classId";
            if (op.Fields.Count != op.Types.Count) return "DEFINE: fields and types differ in length";
            foreach (string type in op.Types)
            {
                if (StateType.Parse(type) == null) return "DEFINE " + op.Target + ": type \"" + type + "\" is outside the grammar";
            }
            return null;
        }
    }

    /// <summary>
    /// A room's codec (PROTOCOL.md §13): it encodes the state op stream and
    /// the room's contract messages, and is named in the join handshake.
    /// Stateless; each state stream gets its own session.
    /// </summary>
    public interface IStateCodec
    {
        /// <summary><c>"schema"</c> or <c>"messagepack"</c>.</summary>
        string Name { get; }

        IStateCodecSession CreateSession();

        /// <summary>
        /// Encodes a contract message; numbers are converted per §12. A
        /// payload that doesn't fit the declaration is <c>ENCODE_FAILED</c>.
        /// </summary>
        Result<byte[]> EncodeMessage(MessageDef def, MsgMap payload);

        /// <summary>Decodes a contract message, strictly (§10).</summary>
        Result<MsgMap> DecodeMessage(MessageDef def, byte[] data, int offset, int count);
    }

    /// <summary>
    /// One op stream. A session keeps the class table (and, for the
    /// <c>schema</c> codec, the target table) from what it encodes or decodes.
    /// A failed frame leaves the session as it was.
    /// </summary>
    public interface IStateCodecSession
    {
        Result<byte[]> EncodeOps(IReadOnlyList<WireOp> ops);

        Result<List<WireOp>> DecodeOps(byte[] data, int offset, int count);

        ClassTable Table { get; }
    }
}
