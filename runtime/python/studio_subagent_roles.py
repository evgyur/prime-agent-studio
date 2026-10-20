"""Add Studio's role keyword without modifying the installed native runtime."""
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
            if role is omitted:
                return await original(prompt, name=name, model=model, thinking=thinking)
            if not isinstance(prompt, str):
                raise TypeError(f"prompt must be str, got {type(prompt).__name__}")
            if not callable(getattr(module, "host_request", None)) or not callable(getattr(module, "_spawn_handle_from_payload", None)):
                raise RuntimeError("This Prime Agent version requires an updated Studio role adapter.")
            kwargs = {"name": name, "role": role}
            if model is not None:
                kwargs["model"] = model
            if thinking is not None:
                kwargs["thinking"] = thinking
            payload = await module.host_request("rlm.run", {"prompt": prompt, "kwargs": kwargs})
            return module._spawn_handle_from_payload(payload)

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
