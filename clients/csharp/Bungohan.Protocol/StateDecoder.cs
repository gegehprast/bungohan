using System;
using System.Collections.Generic;

namespace Bungohan.Protocol
{
    /// <summary>
    /// Applies state ops to a replica (PROTOCOL.md §11): the class table and
    /// matching by name, refIds and blocks, zero-value resets, holder counts
    /// with end-of-frame drops, unknown classes, and change notifications
    /// deferred until the frame is applied. One decoder per stream (per
    /// snapshot); <see cref="StateStream{TRoot}"/> manages that for you.
    /// </summary>
    public sealed class StateDecoder
    {
        private sealed class ClassBinding
        {
            public ClassBinding(ClassEntry entry, StateType[] types, SchemaClass? local)
            {
                Entry = entry;
                Types = types;
                Local = local;
            }

            public ClassEntry Entry { get; }
            public StateType[] Types { get; }

            /// <summary>The local class of the same name; null if unknown here (ignored).</summary>
            public SchemaClass? Local { get; }

            /// <summary>Server field index → local field index (−1: skipped). Computed on first use.</summary>
            public int[]? LocalIndex { get; set; }
        }

        private static readonly object s_ignored = new object();

        private readonly Schema _root;
        private readonly SchemaRegistry _registry;
        private readonly Dictionary<long, object> _refs = new Dictionary<long, object>();
        private readonly HashSet<long> _ignored = new HashSet<long>();
        private readonly Dictionary<long, ClassBinding> _classes = new Dictionary<long, ClassBinding>();
        private readonly Dictionary<Schema, long> _refOf = new Dictionary<Schema, long>(IdentityComparer<Schema>.Instance);
        private readonly Dictionary<Schema, ClassBinding> _bindingOf = new Dictionary<Schema, ClassBinding>(IdentityComparer<Schema>.Instance);
        private readonly Dictionary<Schema, int> _holders = new Dictionary<Schema, int>(IdentityComparer<Schema>.Instance);
        private readonly HashSet<string> _unknownReported = new HashSet<string>();
        private bool _rootBound;

        // Per frame.
        private ChangeQueue _queue = new ChangeQueue();
        private readonly HashSet<Schema> _created = new HashSet<Schema>(IdentityComparer<Schema>.Instance);
        private readonly List<Schema> _released = new List<Schema>();

        public StateDecoder(Schema root, SchemaRegistry registry)
        {
            _root = root;
            _registry = registry;
        }

        public Schema Root => _root;

        /// <summary>
        /// An instance of a class this receiver has no class for was dropped
        /// with its subtree. Once per class name per stream, after the frame.
        /// </summary>
        public event Action<string>? UnknownClass;

        /// <summary>A change listener threw (it is caught; the frame is unaffected).</summary>
        public event Action<Exception>? ListenerError;

        /// <summary>
        /// Applies one frame's ops. On error, the ops before the failing one
        /// stay applied, and the replica can no longer be trusted (a desync).
        /// </summary>
        public Result Apply(IReadOnlyList<WireOp> ops)
        {
            _queue = new ChangeQueue();
            _created.Clear();
            _released.Clear();
            Result result = Result.Ok();
            foreach (WireOp op in ops)
            {
                result = ApplyOp(op);
                if (!result.IsOk) break;
            }
            foreach (Schema instance in _released)
            {
                if (_holders.TryGetValue(instance, out int count) && count <= 0) Drop(instance);
            }
            _queue.Fire(ListenerError);
            return result;
        }

        private Result ApplyOp(WireOp op) => op.Code switch
        {
            OpCode.Define => Define(op),
            OpCode.Set => Set(op),
            OpCode.Add => Add(op),
            OpCode.Remove => Remove(op),
            OpCode.Clear => Clear(op),
            _ => Malformed("unknown op code", op),
        };

        // --- ops ----------------------------------------------------------

        private Result Define(WireOp op)
        {
            string? problem = ClassTable.CheckDefine(op);
            if (problem != null) return Malformed(problem, op);
            var types = new StateType[op.Types.Count];
            for (int i = 0; i < types.Length; i++) types[i] = StateType.Parse(op.Types[i])!;
            _registry.TryGet(op.Name, out SchemaClass? local);
            var binding = new ClassBinding(new ClassEntry(op.Target, op.Name, op.Fields, op.Types), types, local);
            _classes[op.Target] = binding;

            if (!_rootBound && _root.Class.Name == op.Name)
            {
                Result bound = Bind(_root, binding, 0);
                if (!bound.IsOk) return bound;
                _holders[_root] = int.MaxValue;
                _created.Remove(_root); // the root's listeners always fire
                _rootBound = true;
            }
            return Result.Ok();
        }

        private Result Set(WireOp op)
        {
            long refId = op.Target;
            if (!TryIndex(op.Key, out int index)) return Malformed("bad SET index", op);
            if (_ignored.Contains(refId)) return IgnoreValue(op.Value);
            if (!_refs.TryGetValue(refId, out object? target)) return UnknownRef(refId);

            if (target is Schema instance)
            {
                ClassBinding binding = _bindingOf[instance];
                if (index >= binding.Types.Length) return Malformed("field " + index + " out of range", op);
                int local = binding.LocalIndex![index];
                StateType type = binding.Types[index];
                if (type.Kind == StateTypeKind.Schema)
                {
                    if (!(op.Value is WireRef r)) return Malformed("a schema field needs a ref", op);
                    if (local < 0 || !(instance.GetChild(local) is Schema child)) return IgnoreValue(r);
                    if (_refOf.TryGetValue(child, out long current) && current == r.RefId) return Result.Ok();
                    if (!_classes.TryGetValue(r.ClassId, out ClassBinding? childBinding)) return UnknownClassId(r.ClassId);
                    Result bound = Bind(child, childBinding, r.RefId);
                    if (!bound.IsOk) return bound;
                    Retain(child);
                    return Result.Ok();
                }
                if (type.IsCollection) return Malformed("SET on a collection field", op);
                if (local < 0) return Result.Ok();
                return instance.ApplyField(local, op.Value, QueueFor(instance))
                    ? Result.Ok()
                    : Malformed("bad value for " + type.Text + " field \"" + binding.Entry.Fields[index] + "\"", op);
            }

            if (target is IArrayState array)
            {
                var collection = (StateCollection)target;
                Result<object> decoded = DecodeElement(collection, op.Value, op);
                if (!decoded.IsOk) return Result.Fail(decoded.Error!);
                if (decoded.Value == s_ignored) return Result.Ok();
                if (!array.Replace(index, decoded.Value, QueueOf(collection), out object? previous))
                {
                    return Malformed("replace out of range", op);
                }
                Release(previous);
                Retain(decoded.Value);
                return Result.Ok();
            }
            return Malformed("SET target is not a schema or an array", op);
        }

        private Result Add(WireOp op)
        {
            long refId = op.Target;
            if (_ignored.Contains(refId)) return IgnoreValue(op.Value);
            if (!_refs.TryGetValue(refId, out object? target)) return UnknownRef(refId);
            if (!(target is StateCollection collection)) return Malformed("ADD on a schema", op);

            Result<object> decoded = DecodeElement(collection, op.Value, op);
            if (!decoded.IsOk) return Result.Fail(decoded.Error!);
            object element = decoded.Value;
            ChangeQueue? changes = QueueOf(collection);

            if (target is ISetState set)
            {
                if (op.HasKey) return Malformed("a set ADD has no key", op);
                if (element == s_ignored) return Result.Ok();
                if (set.Add(element, changes)) Retain(element);
                return Result.Ok();
            }
            if (!op.HasKey) return Malformed("ADD needs a key", op);
            if (target is IMapState map)
            {
                if (!WireValues.TryKey(collection.Type.Key, op.Key, out object key)) return Malformed("bad map key", op);
                if (element == s_ignored) return Result.Ok();
                map.Upsert(key, element, changes, out object? previous);
                if (!ReferenceEquals(previous, element))
                {
                    Release(previous);
                    Retain(element);
                }
                return Result.Ok();
            }
            if (target is IArrayState array)
            {
                if (!TryIndex(op.Key, out int index)) return Malformed("bad array index", op);
                if (element == s_ignored)
                {
                    // Skipping would shift every later index out of step.
                    return Result.Fail(ErrorCodes.UnknownClass, "array element of a class unknown to this client");
                }
                if (!array.Insert(index, element, changes)) return Malformed("insert out of range", op);
                Retain(element);
                return Result.Ok();
            }
            return Malformed("unsupported ADD target", op);
        }

        private Result Remove(WireOp op)
        {
            long refId = op.Target;
            if (_ignored.Contains(refId)) return Result.Ok();
            if (!_refs.TryGetValue(refId, out object? target)) return UnknownRef(refId);
            if (!(target is StateCollection collection)) return Malformed("REMOVE on a schema", op);
            ChangeQueue? changes = QueueOf(collection);

            if (target is IMapState map)
            {
                if (!WireValues.TryKey(collection.Type.Key, op.Key, out object key)) return Malformed("bad map key", op);
                if (map.Delete(key, changes, out object? removed)) Release(removed);
            }
            else if (target is IArrayState array)
            {
                if (!TryIndex(op.Key, out int index)) return Malformed("bad array index", op);
                if (!array.RemoveAt(index, changes, out object? removed)) return Malformed("remove out of range", op);
                Release(removed);
            }
            else if (target is ISetState set)
            {
                if (collection.Type.HoldsSchemas)
                {
                    if (!TryRefId(op.Key, out long elementRef)) return Malformed("a schema set REMOVE takes a refId", op);
                    if (_refs.TryGetValue(elementRef, out object? element) && element is Schema schema && set.Delete(schema, changes))
                    {
                        Release(schema);
                    }
                }
                else
                {
                    if (!WireValues.TryKey(collection.Type.Element, op.Key, out object element)) return Malformed("bad set element", op);
                    set.Delete(element, changes);
                }
            }
            return Result.Ok();
        }

        private Result Clear(WireOp op)
        {
            long refId = op.Target;
            if (_ignored.Contains(refId)) return Result.Ok();
            if (!_refs.TryGetValue(refId, out object? target)) return UnknownRef(refId);
            if (!(target is StateCollection collection)) return Malformed("CLEAR on a schema", op);
            ChangeQueue? changes = QueueOf(collection);
            List<object?> removed = target switch
            {
                IMapState map => map.Clear(changes),
                IArrayState array => array.Clear(changes),
                ISetState set => set.Clear(changes),
                _ => new List<object?>(),
            };
            foreach (object? value in removed) Release(value);
            return Result.Ok();
        }

        // --- helpers --------------------------------------------------------

        /// <summary>A collection element: a primitive, or a ref → an instance.</summary>
        private Result<object> DecodeElement(StateCollection collection, object? value, WireOp op)
        {
            StateType type = collection.Type;
            if (!type.HoldsSchemas)
            {
                bool ok = type.IsSet
                    ? WireValues.TryKey(type.Element, value, out object element)
                    : WireValues.TryDecode(type.Element, value, out element);
                return ok ? Result<object>.Ok(element) : Result<object>.Fail(ErrorCodes.MalformedOp, "bad " + type.Text + " element: " + op);
            }
            if (!(value is WireRef r)) return Result<object>.Fail(ErrorCodes.MalformedOp, "expected [classId, refId]: " + op);
            if (_refs.TryGetValue(r.RefId, out object? existing))
            {
                return existing is Schema known
                    ? Result<object>.Ok(known)
                    : Result<object>.Fail(ErrorCodes.MalformedOp, "ref is a collection: " + op);
            }
            // An ignored refId only stays ignored if its class is unknown here:
            // blocks are reused (§11.4), so it may now name a visible instance.
            if (!_classes.TryGetValue(r.ClassId, out ClassBinding? binding))
            {
                return Result<object>.Fail(ErrorCodes.UnknownClass, "classId " + r.ClassId + " not defined");
            }
            if (binding.Local == null)
            {
                Ignore(binding, r.RefId);
                ReportUnknown(binding.Entry.Name);
                return Result<object>.Ok(s_ignored);
            }
            Schema instance = binding.Local.Create();
            Result bound = Bind(instance, binding, r.RefId);
            return bound.IsOk ? Result<object>.Ok(instance) : Result<object>.Fail(bound.Error!);
        }

        /// <summary>
        /// Registers <paramref name="instance"/> as <paramref name="refId"/>
        /// (its collections as refId+1 …, in server field order) and resets it
        /// to zero values, since the server omits zeros (§11.5).
        /// </summary>
        private Result Bind(Schema instance, ClassBinding binding, long refId)
        {
            Result<int[]> mapped = LocalFields(binding, instance.Class);
            if (!mapped.IsOk) return Result.Fail(mapped.Error!);
            int[] local = mapped.Value;

            // A nested instance rebound to a new refId (the server replaced the
            // nested object, §11.5): forget its old block, count holders
            // afresh, and release what its collections held. Its nested
            // fields are rebound by the SETs that follow.
            if (_refOf.TryGetValue(instance, out long previous) && previous != refId && _bindingOf.TryGetValue(instance, out ClassBinding? old))
            {
                Unregister(previous, old);
                _holders[instance] = 0;
                var held = new List<Schema>();
                foreach (int index in old.LocalIndex ?? Array.Empty<int>())
                {
                    if (index >= 0 && instance.GetChild(index) is StateCollection collection) collection.CollectSchemas(held);
                }
                foreach (Schema element in held) Release(element);
            }
            _ignored.Remove(refId); // a stale mark from an earlier use of this block
            _refs[refId] = instance;
            _refOf[instance] = refId;
            _bindingOf[instance] = binding;
            if (!_holders.ContainsKey(instance)) _holders[instance] = 0;
            _created.Add(instance);

            SchemaClass cls = instance.Class;
            for (int i = 0; i < cls.Fields.Count; i++)
            {
                StateType type = cls.Fields[i].Parsed;
                if (type.IsCollection)
                {
                    if (instance.GetChild(i) is StateCollection collection) collection.ResetSilently();
                }
                else if (type.Kind != StateTypeKind.Schema)
                {
                    instance.ApplyField(i, WireValues.Zero(type.Element), null);
                }
            }

            long next = refId + 1;
            for (int index = 0; index < binding.Types.Length; index++)
            {
                if (!binding.Types[index].IsCollection) continue;
                long collectionRef = next++;
                int localIndex = local[index];
                if (localIndex >= 0 && instance.GetChild(localIndex) is StateCollection collection)
                {
                    collection.Owner = instance;
                    _refs[collectionRef] = collection;
                    _ignored.Remove(collectionRef);
                }
                else
                {
                    _refs.Remove(collectionRef);
                    _ignored.Add(collectionRef);
                }
            }
            return Result.Ok();
        }

        /// <summary>Maps server field indices to local ones, checking that shared fields agree.</summary>
        private static Result<int[]> LocalFields(ClassBinding binding, SchemaClass cls)
        {
            if (binding.LocalIndex != null) return Result<int[]>.Ok(binding.LocalIndex);
            ClassEntry entry = binding.Entry;
            var local = new int[entry.Fields.Count];
            for (int i = 0; i < local.Length; i++)
            {
                int index = cls.IndexOf(entry.Fields[i]);
                if (index >= 0 && cls.Fields[index].Type != entry.Types[i])
                {
                    return Result<int[]>.Fail(ErrorCodes.SchemaMismatch,
                        entry.Name + "." + entry.Fields[i] + ": server sends " + entry.Types[i] +
                        ", local field is " + cls.Fields[index].Type);
                }
                local[i] = index;
            }
            binding.LocalIndex = local;
            return Result<int[]>.Ok(local);
        }

        private void ReportUnknown(string name)
        {
            if (!_unknownReported.Add(name)) return;
            // About data, not an op: queued, so the frame is applied first.
            _queue.Enqueue(() => UnknownClass?.Invoke(name));
        }

        private void Ignore(ClassBinding binding, long refId)
        {
            _ignored.Add(refId);
            long next = refId + 1;
            foreach (StateType type in binding.Types)
            {
                if (type.IsCollection) _ignored.Add(next++);
            }
        }

        /// <summary>A value placed into an ignored target: a new ref it creates is ignored too.</summary>
        private Result IgnoreValue(object? value)
        {
            if (!(value is WireRef r)) return Result.Ok();
            if (_refs.ContainsKey(r.RefId) || _ignored.Contains(r.RefId)) return Result.Ok();
            if (!_classes.TryGetValue(r.ClassId, out ClassBinding? binding)) return UnknownClassId(r.ClassId);
            Ignore(binding, r.RefId);
            return Result.Ok();
        }

        private void Retain(object? value)
        {
            if (!(value is Schema instance)) return;
            _holders.TryGetValue(instance, out int count);
            if (count != int.MaxValue) _holders[instance] = count + 1;
        }

        private void Release(object? value)
        {
            if (!(value is Schema instance)) return;
            _holders.TryGetValue(instance, out int count);
            if (count == int.MaxValue) return;
            _holders[instance] = count - 1;
            if (count - 1 <= 0) _released.Add(instance);
        }

        private void Unregister(long refId, ClassBinding binding)
        {
            _refs.Remove(refId);
            long next = refId + 1;
            foreach (StateType type in binding.Types)
            {
                if (!type.IsCollection) continue;
                _refs.Remove(next);
                _ignored.Remove(next);
                next++;
            }
        }

        /// <summary>Forgets an instance and releases everything it holds.</summary>
        private void Drop(Schema instance)
        {
            if (!_refOf.TryGetValue(instance, out long refId) || !_bindingOf.TryGetValue(instance, out ClassBinding? binding))
            {
                return;
            }
            Unregister(refId, binding);
            _refOf.Remove(instance);
            _bindingOf.Remove(instance);
            _holders.Remove(instance);

            var children = new List<Schema>();
            foreach (int local in binding.LocalIndex ?? Array.Empty<int>())
            {
                if (local < 0) continue;
                object? child = instance.GetChild(local);
                if (child is Schema nested) children.Add(nested);
                else if (child is StateCollection collection) collection.CollectSchemas(children);
            }
            foreach (Schema child in children)
            {
                if (!_holders.TryGetValue(child, out int count)) continue;
                _holders[child] = count - 1;
                if (count - 1 <= 0) Drop(child);
            }
        }

        private ChangeQueue? QueueFor(Schema instance) => _created.Contains(instance) ? null : _queue;

        private ChangeQueue? QueueOf(StateCollection collection) =>
            collection.Owner == null ? _queue : QueueFor(collection.Owner);

        private static bool TryIndex(object? value, out int index)
        {
            if (Numeric.TryNumber(value, out double number) && number >= 0 && number <= int.MaxValue && number == Math.Floor(number))
            {
                index = (int)number;
                return true;
            }
            index = -1;
            return false;
        }

        private static bool TryRefId(object? value, out long refId)
        {
            if (Numeric.TryNumber(value, out double number) && Numeric.IsIntOf(number, IntKind.UInt32))
            {
                refId = (long)number;
                return true;
            }
            refId = -1;
            return false;
        }

        private static Result Malformed(string message, WireOp op) =>
            Result.Fail(ErrorCodes.MalformedOp, message + ": " + op);

        private static Result UnknownRef(long refId) =>
            Result.Fail(ErrorCodes.UnknownRef, "unknown refId " + refId);

        private static Result UnknownClassId(long classId) =>
            Result.Fail(ErrorCodes.UnknownClass, "classId " + classId + " not defined");
    }
}
