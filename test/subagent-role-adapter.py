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

        async def host_request(kind, payload):
            self.calls.append((kind, payload))
            return {"handle": "role-handle"}

        module = SimpleNamespace(spawn=original, host_request=host_request,
                                 _spawn_handle_from_payload=lambda payload: payload["handle"])
        adapter._RoleLoader(SimpleNamespace(exec_module=lambda module: None)).exec_module(module)
        return module

    async def test_omitted_role_keeps_native_behavior(self):
        module = self.module()
        self.assertEqual(await module.spawn("task", name="worker"), "native-handle")
        self.assertEqual(self.calls, [("native", "task", {"name": "worker", "model": None, "thinking": None})])

    async def test_role_preserves_explicit_fields_for_host_validation(self):
        module = self.module()
        self.assertEqual(await module.spawn("task", name="worker", role="explore", model="fixture/model", thinking="off"), "role-handle")
        self.assertEqual(self.calls, [("rlm.run", {"prompt": "task", "kwargs": {
            "name": "worker", "role": "explore", "model": "fixture/model", "thinking": "off"}})])

    async def test_unsupported_native_contract_fails_before_host_request(self):
        module = self.module()
        del module._spawn_handle_from_payload
        with self.assertRaisesRegex(RuntimeError, "updated Studio role adapter"):
            await module.spawn("task", name="worker", role="review")
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
