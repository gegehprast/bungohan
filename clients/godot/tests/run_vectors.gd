extends "harness.gd"
## The conformance vector runner. Exits 0 when every vector (except the
## `behavior` kind) passes and no script error was logged, else 1:
##
##     cd clients/godot && godot-mono --headless --script tests/run_vectors.gd


func _suites() -> Array:
	return ["res://tests/vector_tests.gd"]
