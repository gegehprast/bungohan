using System;
using System.Collections.Generic;
using System.Linq;
using Bungohan.Protocol;

namespace Bungohan.Protocol.Tests
{
    // Hand-written classes in the shape the generator emits (§4.2).

    public sealed class Vec : Schema
    {
        public static readonly SchemaClass Schema = new SchemaClass("Vec", () => new Vec(),
            new SchemaField("x", "fixed:2"), new SchemaField("y", "fixed:2"));

        private double _x = 7; // a local default the replica must reset to 0
        private double _y;

        public override SchemaClass Class => Schema;
        public double X => _x;
        public double Y => _y;
        public event Action<double, double>? XChanged;
        public event Action<double, double>? YChanged;

        protected override bool ApplyField(int index, object? wire, ChangeQueue? changes) => index switch
        {
            0 => Apply(0, ref _x, wire, changes, XChanged),
            1 => Apply(1, ref _y, wire, changes, YChanged),
            _ => false,
        };

        protected override object? GetChild(int index) => null;
    }

    public sealed class Unit : Schema
    {
        public static readonly SchemaClass Schema = new SchemaClass("Unit", () => new Unit(),
            new SchemaField("name", "string"), new SchemaField("pos", "schema<Vec>"),
            new SchemaField("hp", "uint8"), new SchemaField("tags", "set<string>"));

        private string _name = "";
        private byte _hp;

        public override SchemaClass Class => Schema;
        public string Name => _name;
        public Vec Pos { get; } = new Vec();
        public byte Hp => _hp;
        public SetSchema<string> Tags { get; } = new SetSchema<string>("set<string>");
        public event Action<string, string>? NameChanged;
        public event Action<byte, byte>? HpChanged;

        protected override bool ApplyField(int index, object? wire, ChangeQueue? changes) => index switch
        {
            0 => Apply(0, ref _name, wire, changes, NameChanged),
            2 => Apply(2, ref _hp, wire, changes, HpChanged),
            _ => false,
        };

        protected override object? GetChild(int index) => index switch
        {
            1 => Pos,
            3 => Tags,
            _ => null,
        };
    }

    public sealed class World : Schema
    {
        public static readonly SchemaClass Schema = new SchemaClass("World", () => new World(),
            new SchemaField("tick", "float64"), new SchemaField("units", "schemaMap<uint32,Unit>"),
            new SchemaField("order", "schemaArray<Unit>"), new SchemaField("scores", "map<string,fixed:1>"));

        private double _tick;

        public override SchemaClass Class => Schema;
        public double Tick => _tick;
        public MapSchema<uint, Unit> Units { get; } = new MapSchema<uint, Unit>("schemaMap<uint32,Unit>");
        public ArraySchema<Unit> Order { get; } = new ArraySchema<Unit>("schemaArray<Unit>");
        public MapSchema<string, double> Scores { get; } = new MapSchema<string, double>("map<string,fixed:1>");
        public event Action<double, double>? TickChanged;

        protected override bool ApplyField(int index, object? wire, ChangeQueue? changes) =>
            index == 0 && Apply(0, ref _tick, wire, changes, TickChanged);

        protected override object? GetChild(int index) => index switch
        {
            1 => Units,
            2 => Order,
            3 => Scores,
            _ => null,
        };
    }

    public static class ReplicaTests
    {
        // Server class table: World 0, Unit 1, Vec 2. World's collections:
        // units 1, order 2, scores 3. A Unit at R: pos is a ref, tags R+1.
        private static readonly WireOp[] s_defines =
        {
            WireOp.Define(0, "World", new[] { "tick", "units", "order", "scores" },
                new[] { "float64", "schemaMap<uint32,Unit>", "schemaArray<Unit>", "map<string,fixed:1>" }),
            WireOp.Define(1, "Unit", new[] { "name", "pos", "hp", "tags" },
                new[] { "string", "schema<Vec>", "uint8", "set<string>" }),
            WireOp.Define(2, "Vec", new[] { "x", "y" }, new[] { "fixed:2", "fixed:2" }),
        };

        private static SchemaRegistry Registry() =>
            new SchemaRegistry().Register(World.Schema).Register(Unit.Schema).Register(Vec.Schema);

        /// <summary>A unit at refId <paramref name="r"/> (its Vec at r + 2), placed by <paramref name="place"/>.</summary>
        private static IEnumerable<WireOp> Spawn(WireOp place, long r, string name, double x)
        {
            yield return place;
            yield return WireOp.Set(r, 0, name);
            yield return WireOp.Set(r, 1, new WireRef(2, r + 2));
            yield return WireOp.Set(r + 2, 0, x);
            yield return WireOp.Set(r, 2, 100.0);
            yield return WireOp.AddToSet(r + 1, "new");
        }

        private static List<WireOp> Snapshot() =>
            s_defines.Concat(new[] { WireOp.Set(0, 0, 1.5) })
                .Concat(Spawn(WireOp.Add(1, 7.0, new WireRef(1, 4)), 4, "ann", 150))
                .ToList();

        private static void Ok(Result result) => Suite.That(result.IsOk, "unexpected error: " + result.Error);

        public static Suite Run()
        {
            var suite = new Suite("replica");

            suite.Run("a snapshot builds the tree, resets zero values and defers events", () =>
            {
                var root = new World();
                var decoder = new StateDecoder(root, Registry());
                var events = new List<string>();
                root.TickChanged += (v, old) => events.Add("tick " + v + " (was " + old + ")");
                root.Units.Added += (unit, key) =>
                    events.Add("added " + key + " " + unit.Name + " x=" + unit.Pos.X + " tags=" + unit.Tags.Count);
                Ok(decoder.Apply(Snapshot()));
                Suite.Equal(new List<object?> { "tick 1.5 (was 0)", "added 7 ann x=1.5 tags=1" }, events.Cast<object?>().ToList(), "events");
                Unit unit = root.Units[7];
                Suite.Equal("ann", unit.Name, "name");
                Suite.Equal(1.5, unit.Pos.X, "fixed:2 decodes by dividing");
                Suite.Equal(0.0, unit.Pos.Y, "a local default is reset to zero");
                Suite.Equal(100.0, (double)unit.Hp, "hp");
            });

            suite.Run("an instance created in a frame fires none of its own listeners", () =>
            {
                var root = new World();
                var decoder = new StateDecoder(root, Registry());
                int fired = 0;
                root.Units.Added += (unit, _) =>
                {
                    unit.NameChanged += (_, _) => fired++;
                };
                Ok(decoder.Apply(Snapshot()));
                Suite.Equal(0.0, (double)fired, "listeners attached in onAdd see only later frames");
                Ok(decoder.Apply(new[] { WireOp.Set(4, 0, "bea") }));
                Suite.Equal(1.0, (double)fired, "a later change fires");
            });

            suite.Run("a move within one frame keeps the same object", () =>
            {
                var root = new World();
                var decoder = new StateDecoder(root, Registry());
                Ok(decoder.Apply(Snapshot()));
                Unit before = root.Units[7];
                Ok(decoder.Apply(new[] { WireOp.Remove(1, 7.0), WireOp.Add(1, 8.0, new WireRef(1, 4)) }));
                Suite.That(ReferenceEquals(before, root.Units[8]), "identity kept across the move");
                Ok(decoder.Apply(new[] { WireOp.Set(4, 0, "moved") }));
                Suite.Equal("moved", before.Name, "the moved instance still receives ops");
            });

            suite.Run("a removed instance is dropped at the end of the frame, and its refId can be reused", () =>
            {
                var root = new World();
                var decoder = new StateDecoder(root, Registry());
                Ok(decoder.Apply(Snapshot()));
                Unit old = root.Units[7];
                Ok(decoder.Apply(new[] { WireOp.Remove(1, 7.0) }));
                Result stale = decoder.Apply(new[] { WireOp.Set(4, 0, "ghost") });
                Suite.Equal(ErrorCodes.UnknownRef, stale.Error?.Code, "the dropped refId is unknown");
                Ok(decoder.Apply(Spawn(WireOp.Add(1, 9.0, new WireRef(1, 4)), 4, "cid", 2).ToList()));
                Suite.That(!ReferenceEquals(old, root.Units[9]), "a reused block creates a fresh object");
                Suite.Equal("cid", root.Units[9].Name, "new content");
            });

            suite.Run("clearing a collection releases its instances", () =>
            {
                var root = new World();
                var decoder = new StateDecoder(root, Registry());
                Ok(decoder.Apply(Snapshot().Concat(new[] { WireOp.Add(2, 0.0, new WireRef(1, 4)) }).ToList()));
                Ok(decoder.Apply(new[] { WireOp.Clear(1) }));
                Suite.Equal("ann", root.Order[0].Name, "still held by the array");
                Ok(decoder.Apply(new[] { WireOp.Clear(2) }));
                Suite.Equal(ErrorCodes.UnknownRef, decoder.Apply(new[] { WireOp.Set(4, 0, "x") }).Error?.Code, "now dropped");
            });

            suite.Run("an unknown class is ignored with its subtree, and reported once", () =>
            {
                var root = new World();
                var decoder = new StateDecoder(root, new SchemaRegistry().Register(World.Schema));
                var unknown = new List<string>();
                decoder.UnknownClass += unknown.Add;
                Ok(decoder.Apply(Snapshot()));
                Ok(decoder.Apply(Spawn(WireOp.Add(1, 8.0, new WireRef(1, 10)), 10, "bo", 3).ToList()));
                Suite.Equal(0.0, (double)root.Units.Count, "nothing of the unknown class");
                Suite.Equal(new List<object?> { "Unit" }, unknown.Cast<object?>().ToList(), "reported once");
                Result array = decoder.Apply(new[] { WireOp.Add(2, 0.0, new WireRef(1, 20)) });
                Suite.Equal(ErrorCodes.UnknownClass, array.Error?.Code, "an unknown array element is an error");
            });

            suite.Run("server fields the client lacks are skipped; type disagreements are a schema mismatch", () =>
            {
                var extra = WireOp.Define(0, "World", new[] { "tick", "units", "order", "scores", "wind" },
                    new[] { "float64", "schemaMap<uint32,Unit>", "schemaArray<Unit>", "map<string,fixed:1>", "float32" });
                var root = new World();
                Ok(new StateDecoder(root, Registry()).Apply(new[] { extra, WireOp.Set(0, 4, 2.5), WireOp.Set(0, 0, 3.0) }));
                Suite.Equal(3.0, root.Tick, "known fields still apply");

                var clash = WireOp.Define(0, "World", new[] { "tick" }, new[] { "float32" });
                Result mismatch = new StateDecoder(new World(), Registry()).Apply(new[] { clash });
                Suite.Equal(ErrorCodes.SchemaMismatch, mismatch.Error?.Code, "float32 vs float64");
            });

            suite.Run("malformed values and bad refs are rejected", () =>
            {
                var decoder = new StateDecoder(new World(), Registry());
                Ok(decoder.Apply(s_defines));
                Suite.Equal(ErrorCodes.MalformedOp, decoder.Apply(new[] { WireOp.Set(0, 0, "x") }).Error?.Code, "string into float64");
                Suite.Equal(ErrorCodes.MalformedOp, decoder.Apply(new[] { WireOp.Add(3, "k", 0.5) }).Error?.Code, "fixed:1 element must be an integer");
                Suite.Equal(ErrorCodes.UnknownRef, decoder.Apply(new[] { WireOp.Clear(99) }).Error?.Code, "unknown ref");
                Suite.Equal(ErrorCodes.MalformedOp, decoder.Apply(new[] { WireOp.Add(0, 1.0, 1.0) }).Error?.Code, "ADD on an instance");
            });

            suite.Run("a throwing listener is caught and the others still fire", () =>
            {
                var root = new World();
                var decoder = new StateDecoder(root, Registry());
                var errors = new List<Exception>();
                decoder.ListenerError += errors.Add;
                int after = 0;
                root.TickChanged += (_, _) => throw new InvalidOperationException("boom");
                root.TickChanged += (_, _) => after++;
                Ok(decoder.Apply(Snapshot()));
                Suite.Equal(1.0, (double)errors.Count, "reported");
                Suite.Equal(0.0, (double)after, "a multicast delegate stops at the throw");
                Suite.Equal(1.5, root.Tick, "state applied anyway");
            });

            suite.Run("a stream restarts on every snapshot; a patch before one is NO_SNAPSHOT", () =>
            {
                var codec = new SchemaCodec();
                var stream = new StateStream<World>(codec, Registry());
                Suite.Equal(ErrorCodes.NoSnapshot, stream.ApplyPatch(Array.Empty<byte>()).Error?.Code, "no snapshot yet");
                byte[] snapshot = codec.CreateSession().EncodeOps(Snapshot()).Value;
                var roots = new List<World>();
                stream.Replaced += roots.Add;
                Ok(stream.ApplySnapshot(snapshot));
                World first = stream.State!;
                Ok(stream.ApplySnapshot(snapshot));
                Suite.That(!ReferenceEquals(first, stream.State), "a new root per snapshot");
                Suite.Equal(2.0, (double)roots.Count, "Replaced fired for each");
                Suite.Equal("ann", stream.State!.Units[7].Name, "content");
            });

            return suite;
        }
    }
}
