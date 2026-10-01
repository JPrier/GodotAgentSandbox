class_name GameTest
extends Node
## Base class for agent-runnable tests. Put files named test_*.gd under res://tests/.
##
##   extends GameTest
##   func test_player_moves():
##       var level = await load_scene("res://main.tscn")
##       await hold_action("move_right", 20)
##       assert_gt(level.get_node("Player").position.x, 100.0)
##
## Every method starting with "test_" runs with a fresh, empty container.
## Optional hooks: before_each(), after_each(). Tests may use await.

var _failures: Array[String] = []
var _container: Node


func before_each() -> void:
	pass


func after_each() -> void:
	pass


# ---- scene helpers

## Instances a scene under this test's container and waits one frame so _ready has run.
func load_scene(path: String) -> Node:
	var packed := load(path) as PackedScene
	if packed == null:
		fail("could not load scene " + path)
		return null
	var n := packed.instantiate()
	_container.add_child(n)
	await get_tree().process_frame
	return n


func wait_frames(n: int) -> void:
	for i in n:
		await get_tree().process_frame


func wait_physics_frames(n: int) -> void:
	for i in n:
		await get_tree().physics_frame


func wait_seconds(s: float) -> void:
	await get_tree().create_timer(s, true, false, true).timeout


## Presses an input action, holds it for `frames` physics frames, then releases.
func hold_action(action: StringName, frames: int) -> void:
	Input.action_press(action)
	await wait_physics_frames(frames)
	Input.action_release(action)


func tap_action(action: StringName) -> void:
	await hold_action(action, 1)


func press_key(key: Key, frames := 1) -> void:
	var ev := InputEventKey.new()
	ev.keycode = key
	ev.physical_keycode = key
	ev.pressed = true
	Input.parse_input_event(ev)
	await wait_physics_frames(frames)
	var up := ev.duplicate()
	up.pressed = false
	Input.parse_input_event(up)


# ---- assertions (record and continue; the test fails if any assertion failed)

func fail(msg: String) -> void:
	_failures.append(msg)


func assert_true(cond: bool, msg := "expected true") -> void:
	if not cond:
		fail(msg)


func assert_false(cond: bool, msg := "expected false") -> void:
	if cond:
		fail(msg)


func assert_eq(actual: Variant, expected: Variant, msg := "") -> void:
	if not (typeof(actual) == typeof(expected) and actual == expected) and not _num_eq(actual, expected):
		fail("%sexpected %s, got %s" % [_p(msg), var_to_str(expected), var_to_str(actual)])


func assert_ne(actual: Variant, other: Variant, msg := "") -> void:
	if actual == other:
		fail("%sexpected value != %s" % [_p(msg), var_to_str(other)])


func assert_near(actual: float, expected: float, tolerance := 0.001, msg := "") -> void:
	if absf(actual - expected) > tolerance:
		fail("%sexpected %s ± %s, got %s" % [_p(msg), expected, tolerance, actual])


func assert_gt(actual: float, than: float, msg := "") -> void:
	if not actual > than:
		fail("%sexpected > %s, got %s" % [_p(msg), than, actual])


func assert_lt(actual: float, than: float, msg := "") -> void:
	if not actual < than:
		fail("%sexpected < %s, got %s" % [_p(msg), than, actual])


func assert_not_null(v: Variant, msg := "expected non-null") -> void:
	if v == null:
		fail(msg)


func assert_has_node(root: Node, path: NodePath, msg := "") -> void:
	if root == null or not root.has_node(path):
		fail("%smissing node %s" % [_p(msg), path])


func _p(msg: String) -> String:
	return msg + ": " if msg != "" else ""


func _num_eq(a: Variant, b: Variant) -> bool:
	var nums := [TYPE_INT, TYPE_FLOAT]
	return nums.has(typeof(a)) and nums.has(typeof(b)) and is_equal_approx(float(a), float(b))
