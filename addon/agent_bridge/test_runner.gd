extends Node
## Discovers res://tests/**/test_*.gd (classes extending GameTest) and runs every test_* method.

const TEST_ROOT := "res://tests"
const PER_TEST_TIMEOUT_S := 20.0


func run(filter := "") -> Dictionary:
	var files: Array[String] = []
	_collect(TEST_ROOT, files)
	var results := []
	var started := Time.get_ticks_msec()
	for path in files:
		var script := load(path) as GDScript
		if script == null or not script.can_instantiate():
			results.append({"file": path, "test": "<load>", "passed": false, "message": "script failed to load/compile", "ms": 0})
			continue
		for m in script.get_script_method_list():
			var name: String = m.name
			if not name.begins_with("test_"):
				continue
			if filter != "" and not (path + "::" + name).contains(filter):
				continue
			results.append(await _run_one(script, path, name))
	var failed := results.filter(func(r): return not r.passed)
	return {
		"ok": failed.is_empty(),
		"total": results.size(),
		"passed": results.size() - failed.size(),
		"failed": failed.size(),
		"ms": Time.get_ticks_msec() - started,
		"results": results,
	}


func _run_one(script: GDScript, path: String, method: String) -> Dictionary:
	var t0 := Time.get_ticks_msec()
	var test: Node = script.new()
	if not test.has_method("assert_true"):
		test.free()
		return {"file": path, "test": method, "passed": false, "message": "test file must extend GameTest", "ms": 0}
	var container := Node.new()
	container.name = "TestContainer"
	add_child(test)
	add_child(container)
	test._container = container
	var done := [false]
	var runner := func():
		await test.before_each()
		await test.call(method)
		await test.after_each()
		done[0] = true
	runner.call()
	var deadline := Time.get_ticks_msec() + int(PER_TEST_TIMEOUT_S * 1000)
	while not done[0] and Time.get_ticks_msec() < deadline:
		await get_tree().process_frame
	var failures: Array = test._failures.duplicate()
	if not done[0]:
		failures.append("timed out after %ss" % PER_TEST_TIMEOUT_S)
	for action in InputMap.get_actions():
		Input.action_release(action)
	container.queue_free()
	test.queue_free()
	await get_tree().process_frame
	return {
		"file": path, "test": method, "passed": failures.is_empty(),
		"message": "; ".join(failures), "ms": Time.get_ticks_msec() - t0,
	}


func _collect(dir: String, out: Array[String]) -> void:
	if not DirAccess.dir_exists_absolute(dir):
		return
	for d in DirAccess.get_directories_at(dir):
		_collect(dir.path_join(d), out)
	for f in DirAccess.get_files_at(dir):
		# Exported builds may list "x.gd.remap" instead of "x.gd".
		var clean := f.trim_suffix(".remap")
		if clean.begins_with("test_") and clean.ends_with(".gd"):
			out.append(dir.path_join(clean))
