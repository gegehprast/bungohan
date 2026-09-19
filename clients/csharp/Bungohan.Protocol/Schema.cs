using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;

namespace Bungohan.Protocol
{
    /// <summary>One synchronized field of a schema class: its name and type string.</summary>
    public sealed class SchemaField
    {
        public SchemaField(string name, string type)
        {
            Name = name;
            Type = type;
            Parsed = StateType.Parse(type) ?? throw new ArgumentException("bad state type \"" + type + "\"", nameof(type));
        }

        public string Name { get; }

        /// <summary>The type string, as the server's <c>DEFINE</c> states it.</summary>
        public string Type { get; }

        public StateType Parsed { get; }
    }

    /// <summary>
    /// A schema class as a receiver knows it: the name the server uses
    /// (matched by name, §11.2), its fields, and a factory.
    /// </summary>
    public sealed class SchemaClass
    {
        private readonly Dictionary<string, int> _byName = new Dictionary<string, int>();

        public SchemaClass(string name, Func<Schema> create, params SchemaField[] fields)
        {
            Name = name;
            Create = create;
            Fields = fields;
            for (int i = 0; i < fields.Length; i++) _byName[fields[i].Name] = i;
        }

        public string Name { get; }
        public Func<Schema> Create { get; }
        public IReadOnlyList<SchemaField> Fields { get; }

        /// <summary>The local index of a field, or −1.</summary>
        public int IndexOf(string field) => _byName.TryGetValue(field, out int index) ? index : -1;
    }

    /// <summary>
    /// The classes a receiver can instantiate, by name. An instance of a class
    /// that isn't registered is ignored with everything under it (§11.7).
    /// </summary>
    public sealed class SchemaRegistry
    {
        private readonly Dictionary<string, SchemaClass> _classes = new Dictionary<string, SchemaClass>();

        public SchemaRegistry Register(SchemaClass schemaClass)
        {
            _classes[schemaClass.Name] = schemaClass;
            return this;
        }

        public bool TryGet(string name, out SchemaClass schemaClass) => _classes.TryGetValue(name, out schemaClass!);

        public IEnumerable<string> Names => _classes.Keys;
    }

    /// <summary>
    /// Change notifications of one frame. They fire after the whole frame
    /// is applied, in op order (§11.10).
    /// </summary>
    public sealed class ChangeQueue
    {
        private readonly List<Action> _actions = new List<Action>();

        public void Enqueue(Action action) => _actions.Add(action);

        internal void Fire(Action<Exception>? onError)
        {
            foreach (Action action in _actions)
            {
                try
                {
                    action();
                }
                catch (Exception error)
                {
                    // A listener is user code: it may throw, but it never
                    // breaks the replica or the other listeners.
                    onError?.Invoke(error);
                }
            }
            _actions.Clear();
        }
    }

    /// <summary>
    /// Base class of a replicated schema instance. Generated classes derive
    /// from it: each primitive field is a read-only property with a
    /// <c>…Changed</c> event, each nested instance and collection a
    /// read-only property holding its object.
    ///
    /// Only the replica writes to these objects. Every instance is reset to
    /// zero values when the stream creates it (§11.5), whatever it was
    /// constructed with.
    /// </summary>
    public abstract class Schema
    {
        /// <summary>This instance's class (generated).</summary>
        public abstract SchemaClass Class { get; }

        /// <summary>
        /// Applies a wire value to primitive field <paramref name="index"/> (a
        /// local index). False if the value doesn't fit the field's type.
        /// </summary>
        protected internal abstract bool ApplyField(int index, object? wire, ChangeQueue? changes);

        /// <summary>The nested instance or collection object of field <paramref name="index"/>.</summary>
        protected internal abstract object? GetChild(int index);

        /// <summary>
        /// Helper for generated <see cref="ApplyField"/>: converts
        /// <paramref name="wire"/> to the field's value, stores it, and queues
        /// <paramref name="changed"/> if the value differs.
        /// </summary>
        protected bool Apply<T>(int index, ref T field, object? wire, ChangeQueue? changes, Action<T, T>? changed)
        {
            if (!WireValues.TryDecode(Class.Fields[index].Parsed.Element, wire, out object value)) return false;
            T next = (T)value;
            T previous = field;
            field = next;
            if (changes != null && changed != null && !WireValues.Same(previous, next))
            {
                changes.Enqueue(() => changed(next, previous));
            }
            return true;
        }
    }

    /// <summary>Converts wire values (as ops carry them) to the CLR values fields hold.</summary>
    public static class WireValues
    {
        /// <summary>
        /// The CLR type of a scalar: <c>double</c> (float64, fixed:n),
        /// <c>float</c>, <c>string</c>, <c>bool</c>, and <c>sbyte</c>,
        /// <c>short</c>, <c>int</c>, <c>byte</c>, <c>ushort</c>, <c>uint</c>
        /// for the integer kinds.
        /// </summary>
        public static Type ClrType(Scalar type) => type.Kind switch
        {
            ScalarKind.Float64 => typeof(double),
            ScalarKind.Float32 => typeof(float),
            ScalarKind.Fixed => typeof(double),
            ScalarKind.String => typeof(string),
            ScalarKind.Bool => typeof(bool),
            ScalarKind.Int8 => typeof(sbyte),
            ScalarKind.Int16 => typeof(short),
            ScalarKind.Int32 => typeof(int),
            ScalarKind.UInt8 => typeof(byte),
            ScalarKind.UInt16 => typeof(ushort),
            _ => typeof(uint),
        };

        /// <summary>The wire zero value of a scalar: 0, "" or false (§11.5).</summary>
        public static object Zero(Scalar type) => type.Kind switch
        {
            ScalarKind.String => "",
            ScalarKind.Bool => false,
            _ => 0.0,
        };

        /// <summary>
        /// A field value or collection element. <c>fixed:n</c> must be an
        /// int32 on the wire and is divided (§12.1); integer kinds must be
        /// integers in range.
        /// </summary>
        public static bool TryDecode(Scalar type, object? wire, out object value)
        {
            value = false;
            switch (type.Kind)
            {
                case ScalarKind.String:
                    if (!(wire is string s)) return false;
                    value = s;
                    return true;
                case ScalarKind.Bool:
                    if (!(wire is bool b)) return false;
                    value = b;
                    return true;
            }
            if (!Numeric.TryNumber(wire, out double number)) return false;
            switch (type.Kind)
            {
                case ScalarKind.Float64:
                    value = number;
                    return true;
                case ScalarKind.Float32:
                    value = (float)number;
                    return true;
                case ScalarKind.Fixed:
                    if (!Numeric.IsIntOf(number, IntKind.Int32)) return false;
                    value = Numeric.FixedDecode((int)number, type.Decimals);
                    return true;
                default:
                    return TryInt(type, number, out value);
            }
        }

        /// <summary>A map key or set element: exact, never quantized (§12.2).</summary>
        public static bool TryKey(Scalar type, object? wire, out object key)
        {
            if (type.Kind == ScalarKind.Float64)
            {
                bool ok = Numeric.TryNumber(wire, out double number);
                key = number;
                return ok;
            }
            return TryDecode(type, wire, out key);
        }

        private static bool TryInt(Scalar type, double number, out object value)
        {
            value = 0;
            IntKind kind = type.IntKind;
            if (!Numeric.IsIntOf(number, kind)) return false;
            value = kind switch
            {
                IntKind.Int8 => (sbyte)number,
                IntKind.Int16 => (short)number,
                IntKind.Int32 => (int)number,
                IntKind.UInt8 => (byte)number,
                IntKind.UInt16 => (ushort)number,
                _ => (object)(uint)number,
            };
            return true;
        }

        /// <summary>Equality as change detection sees it: NaN equals NaN, −0 differs from 0.</summary>
        public static bool Same<T>(T a, T b)
        {
            if (a is double da && b is double db) return Numeric.SameValue(da, db);
            if (a is float fa && b is float fb) return Numeric.SameValue(fa, fb);
            if (typeof(T).IsValueType || a is string) return EqualityComparer<T>.Default.Equals(a, b);
            return ReferenceEquals(a, b);
        }
    }

    /// <summary>Reference equality for schema instances used as dictionary keys.</summary>
    internal sealed class IdentityComparer<T> : IEqualityComparer<T> where T : class
    {
        public static readonly IdentityComparer<T> Instance = new IdentityComparer<T>();

        public bool Equals(T? x, T? y) => ReferenceEquals(x, y);

        public int GetHashCode(T obj) => RuntimeHelpers.GetHashCode(obj);
    }
}
