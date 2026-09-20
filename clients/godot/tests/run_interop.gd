extends "harness.gd"
## The end-to-end tests against a real server. Needs BUNGOHAN_INTEROP_URL,
## which `bun run test:godot` sets:
##
##     bun scripts/interop.ts --cwd clients/godot godot-mono --headless \
##         --script tests/run_interop.gd


func _suites() -> Array:
	return ["res://tests/interop_tests.gd"]
