"""Deterministic adapter contract tests; no native host or provider calls."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location("studio_roles", Path(__file__).resolve().parents[1] / "runtime/python/studio_subagent_roles.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class RoleAdapterTests(unittest.IsolatedAsyncioTestCase):
    def module(self):
        self.calls = []

        async def original(prompt, **kwargs):
            self.calls.append(("native", prompt, kwargs))
            return "native-handle"

        module = SimpleNamespace(spawn=original)
        adapter._RoleLoader(SimpleNamespace(exec_module=lambda module: None)).exec_module(module)
        return module

    async def test_omitted_role_keeps_native_behavior(self):
        module = self.module()
        self.assertEqual(await module.spawn("task", name="worker"), "native-handle")
        self.assertEqual(self.calls, [("native", "task", {"name": "worker", "model": None, "thinking": None})])

    async def test_legacy_role_is_stripped_for_compatibility(self):
        module = self.module()
        self.assertEqual(await module.spawn("task", name="worker", role="explore", model="fixture/model", thinking="off"), "native-handle")
        self.assertEqual(self.calls, [("native", "task", {"name": "worker", "model": "fixture/model", "thinking": "off"})])

    async def test_unknown_role_is_ignored_not_rejected(self):
        module = self.module()
        self.assertEqual(await module.spawn("task", name="worker", role="typo"), "native-handle")
        self.assertEqual(self.calls, [("native", "task", {"name": "worker", "model": None, "thinking": None})])


if __name__ == "__main__":
    unittest.main()
