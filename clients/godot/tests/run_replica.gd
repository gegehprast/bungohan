extends "harness.gd"
## Replica tests: cd clients/godot && godot-mono --headless --script tests/run_replica.gd


func _suites() -> Array:
	return ["res://tests/replica_tests.gd"]
