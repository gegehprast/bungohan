using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Bungohan.Protocol;

namespace Bungohan.Protocol.Tests
{
    /// <summary>
    /// A schema class built at run time from a <c>replica</c> vector's
    /// declaration: each field is a slot holding its value, nested instance
    /// or collection.
    /// </summary>
    internal sealed class DynamicSchema : Schema
    {
        private readonly SchemaClass _class;
        private readonly object?[] _values;

        public DynamicSchema(SchemaClass cls, Func<string, SchemaClass> classOf)
        {
            _class = cls;
            _values = new object?[cls.Fields.Count];
            for (int i = 0; i < _values.Length; i++)
            {
                StateType type = cls.Fields[i].Parsed;
                if (type.Kind == StateTypeKind.Schema) _values[i] = classOf(type.Schema).Create();
                else if (type.IsCollection) _values[i] = CollectionFor(type);
                else _values[i] = WireValues.Zero(type.Element);
            }
        }

        public override SchemaClass Class => _class;

        public object? this[int index] => _values[index];

        protected override bool ApplyField(int index, object? wire, ChangeQueue? changes)
        {
            object? value = _values[index];
            bool applied = Apply(index, ref value, wire, changes, null);
            _values[index] = value;
            return applied;
        }

        protected override object? GetChild(int index) =>
            _values[index] is Schema || _values[index] is StateCollection ? _values[index] : null;

        private static StateCollection CollectionFor(StateType type)
        {
            Type element = type.HoldsSchemas ? typeof(DynamicSchema) : WireValues.ClrType(type.Element);
            Type generic = type.IsMap
                ? typeof(MapSchema<,>).MakeGenericType(WireValues.ClrType(type.Key), element)
                : (type.IsSet ? typeof(SetSchema<>) : typeof(ArraySchema<>)).MakeGenericType(element);
            return (StateCollection)Activator.CreateInstance(generic, type.Text)!;
        }
    }

    /// <summary>
    /// Runs <c>replica</c> vectors (PROTOCOL.md §14): builds the case's
    /// classes, applies each frame to a replica, and compares the tree with
    /// the frame's <c>expect</c>, including which objects are the same one
    /// (<c>"$"</c> labels).
    /// </summary>
    internal static class ReplicaVectors
    {
        public static void Run(MsgMap c)
        {
            var classes = new Dictionary<string, SchemaClass>();
            SchemaClass ClassOf(string name) =>
                classes.TryGetValue(name, out SchemaClass? cls) ? cls : throw new CheckFailed("undeclared class " + name);
            var registry = new SchemaRegistry();
            foreach (object? item in (List<object?>)c["classes"]!)
            {
                var decl = (MsgMap)item!;
                var name = (string)decl["name"]!;
                SchemaField[] fields = ((List<object?>)decl["fields"]!)
                    .Select(f => (List<object?>)f!)
                    .Select(f => new SchemaField((string)f[0]!, (string)f[1]!))
                    .ToArray();
                SchemaClass? cls = null;
                cls = new SchemaClass(name, () => new DynamicSchema(cls!, ClassOf), fields);
                classes[name] = cls;
                registry.Register(cls);
            }

            Schema root = ClassOf((string)c["root"]!).Create();
            var decoder = new StateDecoder(root, registry);
            var check = new TreeCheck();
            var frames = (List<object?>)c["frames"]!;
            for (int i = 0; i < frames.Count; i++)
            {
                var frame = (MsgMap)frames[i]!;
                Result applied = decoder.Apply(VectorRunner.OpsOf((List<object?>)frame["ops"]!));
                Suite.That(applied.IsOk, "frame " + i + ": " + applied.Error);
                if (!frame.ContainsKey("expect")) continue;
                List<string> problems = check.Compare(root, frame["expect"], "frame " + i + ": $");
                Suite.That(problems.Count == 0, string.Join("; ", problems));
            }
        }

        private sealed class TreeCheck
        {
            private readonly Dictionary<string, object> _objects = new Dictionary<string, object>();
            private readonly Dictionary<object, string> _labels = new Dictionary<object, string>(ReferenceComparer.Instance);

            public List<string> Compare(object? actual, object? expected, string path)
            {
                var problems = new List<string>();
                if (actual is DynamicSchema instance) Instance(instance, expected, path, problems);
                else if (actual is StateCollection collection) Collection(collection, expected, path, problems);
                else Leaf(actual, expected, path, problems);
                return problems;
            }

            private void Instance(DynamicSchema actual, object? expected, string path, List<string> problems)
            {
                if (!(expected is MsgMap record))
                {
                    problems.Add(path + ": expected " + Values.Show(expected) + ", got an instance");
                    return;
                }
                if (record["$"] is string label)
                {
                    bool bound = _objects.TryGetValue(label, out object? previous);
                    bool known = _labels.TryGetValue(actual, out string? other);
                    if (bound && !ReferenceEquals(previous, actual)) problems.Add(path + ": \"" + label + "\" is a different object than before");
                    else if (known && other != label) problems.Add(path + ": \"" + label + "\" is the object labeled \"" + other + "\"");
                    else
                    {
                        _objects[label] = actual;
                        _labels[actual] = label;
                    }
                }
                IReadOnlyList<SchemaField> fields = actual.Class.Fields;
                foreach (string key in record.Keys)
                {
                    if (key != "$" && actual.Class.IndexOf(key) < 0) problems.Add(path + "." + key + ": no such field");
                }
                for (int i = 0; i < fields.Count; i++)
                {
                    string name = fields[i].Name;
                    if (!record.ContainsKey(name))
                    {
                        problems.Add(path + "." + name + ": missing from expect");
                        continue;
                    }
                    problems.AddRange(Compare(actual[i], record[name], path + "." + name));
                }
            }

            private void Collection(StateCollection actual, object? expected, string path, List<string> problems)
            {
                if (!(expected is List<object?> list))
                {
                    problems.Add(path + ": expected an array");
                    return;
                }
                if (actual.Count != list.Count)
                {
                    problems.Add(path + ": " + actual.Count + " elements ≠ " + list.Count);
                    return;
                }
                if (actual.Type.IsMap)
                {
                    var entries = new List<(object Key, object? Value)>();
                    foreach (object? pair in (IEnumerable)actual)
                    {
                        Type t = pair!.GetType();
                        entries.Add((t.GetProperty("Key")!.GetValue(pair)!, t.GetProperty("Value")!.GetValue(pair)));
                    }
                    foreach (object? item in list)
                    {
                        var entry = (List<object?>)item!;
                        int at = entries.FindIndex(e => Values.Difference(e.Key, entry[0], "") == null);
                        if (at < 0) problems.Add(path + ": no key " + Values.Show(entry[0]));
                        else problems.AddRange(Compare(entries[at].Value, entry[1], path + "[" + Values.Show(entry[0]) + "]"));
                    }
                    return;
                }
                List<object?> elements = ((IEnumerable)actual).Cast<object?>().ToList();
                if (actual.Type.IsSet)
                {
                    for (int i = 0; i < list.Count; i++)
                    {
                        int at = elements.FindIndex(e => Tries(() => Compare(e, list[i], path + "{" + i + "}")));
                        if (at < 0) problems.Add(path + ": no element matches #" + i);
                        else elements.RemoveAt(at);
                    }
                    return;
                }
                for (int i = 0; i < list.Count; i++) problems.AddRange(Compare(elements[i], list[i], path + "[" + i + "]"));
            }

            /// <summary>Runs a comparison, keeping its label bindings only if it matched.</summary>
            private bool Tries(Func<List<string>> compare)
            {
                var objects = new Dictionary<string, object>(_objects);
                var labels = new Dictionary<object, string>(_labels, ReferenceComparer.Instance);
                if (compare().Count == 0) return true;
                _objects.Clear();
                _labels.Clear();
                foreach (KeyValuePair<string, object> pair in objects) _objects[pair.Key] = pair.Value;
                foreach (KeyValuePair<object, string> pair in labels) _labels[pair.Key] = pair.Value;
                return false;
            }

            private static void Leaf(object? actual, object? expected, string path, List<string> problems)
            {
                string? diff = Values.Difference(actual, expected, path);
                if (diff != null) problems.Add(diff);
            }
        }

        private sealed class ReferenceComparer : IEqualityComparer<object>
        {
            public static readonly ReferenceComparer Instance = new ReferenceComparer();

            public new bool Equals(object? x, object? y) => ReferenceEquals(x, y);

            public int GetHashCode(object obj) => System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(obj);
        }
    }
}
