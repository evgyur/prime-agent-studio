"""Compatibility shim: accept (and ignore) legacy role keyword.

Per-role routing was removed in 4.4.1. Old conversations may still call
``rlm.spawn(..., role="explore")``. The native runtime rejects unknown
keywords, so this loader keeps the keyword accepted but strips it before
delegating to the native implementation. Only general subagent defaults
(model/thinking) apply, via the Studio Node hook.
"""
import importlib.abc
import importlib.machinery
import sys


class _RoleLoader(importlib.abc.Loader):
    def __init__(self, original):
        self.original = original

    def create_module(self, spec):
        return self.original.create_module(spec) if hasattr(self.original, "create_module") else None

    def exec_module(self, module):
        self.original.exec_module(module)
        original = module.spawn
        omitted = object()

        async def spawn(prompt, *, name, model=None, thinking=None, role=omitted):
            # `role` is legacy: silently ignored for backward compatibility.
            return await original(prompt, name=name, model=model, thinking=thinking)

        module.spawn = spawn


class _RoleFinder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path, target=None):
        if fullname != "rlm":
            return None
        spec = importlib.machinery.PathFinder.find_spec(fullname, path, target)
        if spec is not None and spec.loader is not None:
            spec.loader = _RoleLoader(spec.loader)
        return spec


sys.meta_path.insert(0, _RoleFinder())
