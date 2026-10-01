extends RefCounted
## Loads every script, scene and resource in the project and reports anything that fails.
## Runs inside the real project (autoloads present), so global identifiers resolve correctly.

const SKIP_DIRS := [".godot", ".git", ".gck", "addons/agent_bridge", "builds"]
const EXTS := ["gd", "tscn", "scn", "tres", "res", "gdshader"]


func validate(bridge: Node) -> Dictionary:
	var files: Array[String] = []
	_collect("res://", files)
	# Include everything logged since startup: errors from loading the main scene count too.
	var start_seq := 0
	var failures := []
	for path in files:
		var before := _error_count(bridge, start_seq)
		var res := ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_REUSE)
		var problem := ""
		if res == null:
			problem = "failed to load"
		elif res is Script and not res.can_instantiate() and not (res as Script).is_abstract():
			problem = "script cannot be instantiated (parse/compile error)"
		elif res is PackedScene:
			# Instantiate (without adding to the tree) to surface broken scripts/sub-scenes.
			var inst: Node = res.instantiate()
			if inst == null:
				problem = "scene failed to instantiate"
			else:
				inst.free()
		if problem != "":
			failures.append({"file": path, "problem": problem})
		elif _error_count(bridge, start_seq) > before:
			failures.append({"file": path, "problem": "errors logged while loading"})
	# Main scene must exist.
	var main := str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if main == "":
		failures.append({"file": "project.godot", "problem": "no main scene set"})
	elif not ResourceLoader.exists(main):
		failures.append({"file": "project.godot", "problem": "main scene not found: " + main})
	var errors: Array = bridge.get_logs(start_seq).filter(func(e): return e.level == "error")
	var warnings: Array = bridge.get_logs(start_seq).filter(func(e): return e.level == "warning")
	return {
		"ok": failures.is_empty() and errors.is_empty(),
		"checked": files.size(),
		"failures": failures,
		"errors": errors,
		"warnings": warnings,
	}


func _error_count(bridge: Node, since: int) -> int:
	return bridge.get_logs(since).filter(func(e): return e.level == "error").size()


func _collect(dir: String, out: Array[String]) -> void:
	for d in DirAccess.get_directories_at(dir):
		var full := dir.path_join(d)
		var rel := full.trim_prefix("res://")
		if d.begins_with(".") or SKIP_DIRS.has(rel):
			continue
		_collect(full, out)
	for f in DirAccess.get_files_at(dir):
		if EXTS.has(f.get_extension()):
			out.append(dir.path_join(f))
