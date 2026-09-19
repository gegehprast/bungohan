using System.Collections;
using System.Collections.Generic;

namespace Bungohan.Protocol
{
    /// <summary>
    /// A string-keyed map that keeps insertion order. MessagePack maps
    /// decode to it, and encoders write its entries in that order, which is
    /// what makes encoding byte-exact (PROTOCOL.md §4). Message payloads use
    /// it too: a message is a <see cref="MsgMap"/> of its fields.
    /// </summary>
    public sealed class MsgMap : IEnumerable<KeyValuePair<string, object?>>
    {
        private readonly List<string> _keys = new List<string>();
        private readonly Dictionary<string, object?> _values = new Dictionary<string, object?>();

        public int Count => _keys.Count;
        public IReadOnlyList<string> Keys => _keys;

        /// <summary>Gets or sets a value. Setting a new key appends it.</summary>
        public object? this[string key]
        {
            get => _values.TryGetValue(key, out object? value) ? value : null;
            set
            {
                if (!_values.ContainsKey(key)) _keys.Add(key);
                _values[key] = value;
            }
        }

        public bool ContainsKey(string key) => _values.ContainsKey(key);

        public bool TryGetValue(string key, out object? value) => _values.TryGetValue(key, out value);

        /// <summary>Adds a new key; false if it is already present.</summary>
        public bool TryAdd(string key, object? value)
        {
            if (_values.ContainsKey(key)) return false;
            _keys.Add(key);
            _values[key] = value;
            return true;
        }

        public void Add(string key, object? value) => this[key] = value;

        public bool Remove(string key)
        {
            if (!_values.Remove(key)) return false;
            _keys.Remove(key);
            return true;
        }

        public IEnumerator<KeyValuePair<string, object?>> GetEnumerator()
        {
            foreach (string key in _keys) yield return new KeyValuePair<string, object?>(key, _values[key]);
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
