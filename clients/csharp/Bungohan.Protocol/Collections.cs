using System;
using System.Collections;
using System.Collections.Generic;

namespace Bungohan.Protocol
{
    /// <summary>
    /// Base of the replicated collections. A collection is created with its
    /// field's type string, and its element types are checked against it
    /// once, at construction (a mismatch is a bug in generated code).
    /// </summary>
    public abstract class StateCollection
    {
        protected StateCollection(string type, Type keyType, Type valueType)
        {
            Type = StateType.Parse(type) ?? throw new ArgumentException("bad collection type \"" + type + "\"");
            if (!Type.IsCollection) throw new ArgumentException("\"" + type + "\" is not a collection type");
            Check(Type, keyType, valueType);
        }

        /// <summary>The field type, e.g. <c>schemaMap&lt;uint32,Enemy&gt;</c>.</summary>
        public StateType Type { get; }

        public abstract int Count { get; }

        /// <summary>The instance holding this collection (set when the stream binds it).</summary>
        internal Schema? Owner { get; set; }

        /// <summary>Empties the collection without notifications (§11.5 reset).</summary>
        internal abstract void ResetSilently();

        /// <summary>Adds every schema element to <paramref name="into"/>.</summary>
        internal abstract void CollectSchemas(List<Schema> into);

        private static void Check(StateType type, Type keyType, Type valueType)
        {
            if (type.IsMap && keyType != WireValues.ClrType(type.Key))
            {
                throw new ArgumentException(type.Text + ": key type must be " + WireValues.ClrType(type.Key).Name);
            }
            if (type.HoldsSchemas)
            {
                if (!typeof(Schema).IsAssignableFrom(valueType))
                {
                    throw new ArgumentException(type.Text + ": elements must be a Schema class");
                }
            }
            else if (valueType != WireValues.ClrType(type.Element))
            {
                throw new ArgumentException(type.Text + ": element type must be " + WireValues.ClrType(type.Element).Name);
            }
        }

        internal static void AddSchema(object? value, List<Schema> into)
        {
            if (value is Schema schema) into.Add(schema);
        }
    }

    internal interface IMapState
    {
        /// <summary>Inserts or replaces; returns whether a value was replaced, and which.</summary>
        bool Upsert(object key, object value, ChangeQueue? changes, out object? previous);

        bool Delete(object key, ChangeQueue? changes, out object? removed);

        List<object?> Clear(ChangeQueue? changes);
    }

    internal interface IArrayState
    {
        bool Insert(int index, object value, ChangeQueue? changes);

        bool RemoveAt(int index, ChangeQueue? changes, out object? removed);

        bool Replace(int index, object value, ChangeQueue? changes, out object? previous);

        List<object?> Clear(ChangeQueue? changes);
    }

    internal interface ISetState
    {
        bool Add(object value, ChangeQueue? changes);

        bool Delete(object value, ChangeQueue? changes);

        List<object?> Clear(ChangeQueue? changes);
    }

    /// <summary>
    /// A replicated <c>map&lt;K,V&gt;</c> or <c>schemaMap&lt;K,N&gt;</c>. Listeners
    /// take the value first, then the key (as in every Bungohan client).
    /// </summary>
    public sealed class MapSchema<TKey, TValue> : StateCollection, IReadOnlyDictionary<TKey, TValue>, IMapState
        where TKey : notnull
    {
        private readonly Dictionary<TKey, TValue> _items = new Dictionary<TKey, TValue>();

        public MapSchema(string type) : base(type, typeof(TKey), typeof(TValue)) { }

        /// <summary>A key was added: (value, key).</summary>
        public event Action<TValue, TKey>? Added;

        /// <summary>A key was removed: (value, key).</summary>
        public event Action<TValue, TKey>? Removed;

        /// <summary>An existing key got a new value: (value, previous, key).</summary>
        public event Action<TValue, TValue, TKey>? Replaced;

        public override int Count => _items.Count;
        public TValue this[TKey key] => _items[key];
        public IEnumerable<TKey> Keys => _items.Keys;
        public IEnumerable<TValue> Values => _items.Values;

        public bool ContainsKey(TKey key) => _items.ContainsKey(key);

        public bool TryGetValue(TKey key, out TValue value) => _items.TryGetValue(key, out value!);

        public IEnumerator<KeyValuePair<TKey, TValue>> GetEnumerator() => _items.GetEnumerator();

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

        internal override void ResetSilently() => _items.Clear();

        internal override void CollectSchemas(List<Schema> into)
        {
            foreach (TValue value in _items.Values) AddSchema(value, into);
        }

        bool IMapState.Upsert(object key, object value, ChangeQueue? changes, out object? previous)
        {
            var k = (TKey)key;
            var v = (TValue)value;
            bool had = _items.TryGetValue(k, out TValue old);
            _items[k] = v;
            previous = had ? (object?)old : null;
            if (changes != null)
            {
                if (had) changes.Enqueue(() => Replaced?.Invoke(v, old, k));
                else changes.Enqueue(() => Added?.Invoke(v, k));
            }
            return had;
        }

        bool IMapState.Delete(object key, ChangeQueue? changes, out object? removed)
        {
            var k = (TKey)key;
            removed = null;
            if (!_items.TryGetValue(k, out TValue old)) return false;
            _items.Remove(k);
            removed = old;
            changes?.Enqueue(() => Removed?.Invoke(old, k));
            return true;
        }

        List<object?> IMapState.Clear(ChangeQueue? changes)
        {
            var removed = new List<object?>(_items.Count);
            var entries = new List<KeyValuePair<TKey, TValue>>(_items);
            _items.Clear();
            foreach (var entry in entries)
            {
                removed.Add(entry.Value);
                changes?.Enqueue(() => Removed?.Invoke(entry.Value, entry.Key));
            }
            return removed;
        }
    }

    /// <summary>A replicated <c>array&lt;P&gt;</c> or <c>schemaArray&lt;N&gt;</c>.</summary>
    public sealed class ArraySchema<T> : StateCollection, IReadOnlyList<T>, IArrayState
    {
        private readonly List<T> _items = new List<T>();

        public ArraySchema(string type) : base(type, typeof(int), typeof(T)) { }

        /// <summary>An element was inserted: (value, index).</summary>
        public event Action<T, int>? Added;

        /// <summary>An element was removed: (value, index).</summary>
        public event Action<T, int>? Removed;

        /// <summary>An element was replaced: (value, previous, index).</summary>
        public event Action<T, T, int>? Replaced;

        public override int Count => _items.Count;
        public T this[int index] => _items[index];

        public IEnumerator<T> GetEnumerator() => _items.GetEnumerator();

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

        internal override void ResetSilently() => _items.Clear();

        internal override void CollectSchemas(List<Schema> into)
        {
            foreach (T value in _items) AddSchema(value, into);
        }

        bool IArrayState.Insert(int index, object value, ChangeQueue? changes)
        {
            if (index < 0 || index > _items.Count) return false;
            var v = (T)value;
            _items.Insert(index, v);
            changes?.Enqueue(() => Added?.Invoke(v, index));
            return true;
        }

        bool IArrayState.RemoveAt(int index, ChangeQueue? changes, out object? removed)
        {
            removed = null;
            if (index < 0 || index >= _items.Count) return false;
            T old = _items[index];
            _items.RemoveAt(index);
            removed = old;
            changes?.Enqueue(() => Removed?.Invoke(old, index));
            return true;
        }

        bool IArrayState.Replace(int index, object value, ChangeQueue? changes, out object? previous)
        {
            previous = null;
            if (index < 0 || index >= _items.Count) return false;
            var v = (T)value;
            T old = _items[index];
            _items[index] = v;
            previous = old;
            changes?.Enqueue(() => Replaced?.Invoke(v, old, index));
            return true;
        }

        List<object?> IArrayState.Clear(ChangeQueue? changes)
        {
            var items = new List<T>(_items);
            _items.Clear();
            var removed = new List<object?>(items.Count);
            for (int i = 0; i < items.Count; i++)
            {
                T old = items[i];
                int index = i;
                removed.Add(old);
                changes?.Enqueue(() => Removed?.Invoke(old, index));
            }
            return removed;
        }
    }

    /// <summary>A replicated <c>set&lt;K&gt;</c> or <c>schemaSet&lt;N&gt;</c>.</summary>
    public sealed class SetSchema<T> : StateCollection, IReadOnlyCollection<T>, ISetState
    {
        private readonly HashSet<T> _items;

        public SetSchema(string type) : base(type, typeof(int), typeof(T))
        {
            // Schema elements are distinct objects: compare them by reference.
            _items = typeof(Schema).IsAssignableFrom(typeof(T))
                ? new HashSet<T>(new ReferenceComparer())
                : new HashSet<T>();
        }

        /// <summary>An element was added.</summary>
        public event Action<T>? Added;

        /// <summary>An element was removed.</summary>
        public event Action<T>? Removed;

        public override int Count => _items.Count;

        public bool Contains(T value) => _items.Contains(value);

        public IEnumerator<T> GetEnumerator() => _items.GetEnumerator();

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

        internal override void ResetSilently() => _items.Clear();

        internal override void CollectSchemas(List<Schema> into)
        {
            foreach (T value in _items) AddSchema(value, into);
        }

        bool ISetState.Add(object value, ChangeQueue? changes)
        {
            var v = (T)value;
            if (!_items.Add(v)) return false;
            changes?.Enqueue(() => Added?.Invoke(v));
            return true;
        }

        bool ISetState.Delete(object value, ChangeQueue? changes)
        {
            var v = (T)value;
            if (!_items.Remove(v)) return false;
            changes?.Enqueue(() => Removed?.Invoke(v));
            return true;
        }

        List<object?> ISetState.Clear(ChangeQueue? changes)
        {
            var items = new List<T>(_items);
            _items.Clear();
            var removed = new List<object?>(items.Count);
            foreach (T old in items)
            {
                removed.Add(old);
                changes?.Enqueue(() => Removed?.Invoke(old));
            }
            return removed;
        }

        private sealed class ReferenceComparer : IEqualityComparer<T>
        {
            public bool Equals(T? x, T? y) => ReferenceEquals(x, y);

            public int GetHashCode(T obj) => System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(obj!);
        }
    }
}
