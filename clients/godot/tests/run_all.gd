extends "harness.gd"
## Every GDScript suite: the conformance vectors, the replica, and the
## generated bindings (recorded shooter stream, codegen goldens).
##
##     cd clients/godot && godot-mono --headless --script tests/run_all.gd


func _suites() -> Array:
	return ["res://tests/vector_tests.gd", "res://tests/replica_tests.gd", "res://tests/bindings_tests.gd"]
