extends "harness.gd"
## Every GDScript suite: the conformance vectors, the replica, the
## generated bindings (recorded shooter stream, codegen goldens) and the
## end-to-end interop tests against a real server.
##
##     bun run test:godot           # starts the interop server first
##     cd clients/godot && godot-mono --headless --script tests/run_all.gd


func _suites() -> Array:
	return [
		"res://tests/vector_tests.gd",
		"res://tests/replica_tests.gd",
		"res://tests/bindings_tests.gd",
		"res://tests/interop_tests.gd",
	]
