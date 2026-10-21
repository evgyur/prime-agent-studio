"""Keep subprocess consoles hidden in GUI-owned Prime Agent Python kernels.

Python automatically loads this local module through PYTHONPATH. It is scoped
to the agent process tree and never changes the user's Python installation.
"""
import os

if os.environ.get("PRIME_STUDIO_SUBAGENT_POLICY"):
    import studio_subagent_roles

if os.name == "nt" and os.environ.get("PRIME_GUI_SILENT") == "1":
    import functools
    import importlib.abc
    import importlib.machinery
    import inspect
    import subprocess
    import sys

    if not getattr(subprocess.Popen, "_prime_gui_hidden", False):
        _original_init = subprocess.Popen.__init__
        _signature = inspect.signature(_original_init)

        @functools.wraps(_original_init)
        def _hidden_init(self, *args, **kwargs):
            bound = _signature.bind(self, *args, **kwargs)
            flags = bound.arguments.get("creationflags", 0)
            bound.arguments["creationflags"] = (
                flags & ~subprocess.CREATE_NEW_CONSOLE
            ) | subprocess.CREATE_NO_WINDOW
            startup = bound.arguments.get("startupinfo")
            startup = startup.copy() if startup is not None else subprocess.STARTUPINFO()
            startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startup.wShowWindow = subprocess.SW_HIDE
            bound.arguments["startupinfo"] = startup
            env = bound.arguments.get("env")
            if env is not None:
                env = dict(env)
                env["PRIME_GUI_SILENT"] = "1"
                runtime = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
                preload = os.path.join(runtime, "windows-hidden.cjs").replace("\\", "/")
                if preload not in env.get("NODE_OPTIONS", "").replace("\\", "/"):
                    env["NODE_OPTIONS"] = (env.get("NODE_OPTIONS", "") + ' --require="' + preload + '"').strip()
                python_path = os.path.dirname(os.path.abspath(__file__))
                paths = [p for p in env.get("PYTHONPATH", "").split(os.pathsep) if p and p != python_path]
                env["PYTHONPATH"] = os.pathsep.join([python_path, *paths])
                bound.arguments["env"] = env
            return _original_init(*bound.args, **bound.kwargs)

        subprocess.Popen.__init__ = _hidden_init
        subprocess.Popen._prime_gui_hidden = True

    # Prime Agent 0.9.1's rlm.bash uses ctypes CreateProcessW directly to keep
    # descendants inside a Windows Job Object. Preserve that containment and
    # add hidden-window flags when its module is imported; do not eagerly load
    # the runtime, and never alter an installed file.
    class _HiddenJobLoader(importlib.abc.Loader):
        def __init__(self, original):
            self.original = original

        def create_module(self, spec):
            return self.original.create_module(spec) if hasattr(self.original, "create_module") else None

        def exec_module(self, module):
            self.original.exec_module(module)
            if hasattr(module, "_CREATE_UNICODE_ENVIRONMENT"):
                module._CREATE_UNICODE_ENVIRONMENT |= subprocess.CREATE_NO_WINDOW
            if hasattr(module, "_STARTF_USESTDHANDLES"):
                module._STARTF_USESTDHANDLES |= subprocess.STARTF_USESHOWWINDOW

    class _HiddenJobFinder(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path, target=None):
            if fullname != "rlm._winjob":
                return None
            spec = importlib.machinery.PathFinder.find_spec(fullname, path, target)
            if spec is not None and spec.loader is not None:
                spec.loader = _HiddenJobLoader(spec.loader)
            return spec

    sys.meta_path.insert(0, _HiddenJobFinder())
