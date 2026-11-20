#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "vm/pots-door.py"
SPEC = importlib.util.spec_from_file_location("door", SOURCE)
door = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(door)


class DialogWireBoundary(unittest.TestCase):
    def test_board_uses_distinct_wire_with_ask_access_and_exact_origin(self):
        wire = "board alpha.12345678\n{}"
        self.assertEqual(door.request_id(wire, "alpha", "mastermind", "ask"), "alpha.12345678")
        for caller, access in [("other", "ask"), ("alpha", "reply")]:
            with self.subTest(caller=caller, access=access), self.assertRaises(door.Refusal):
                door.request_id(wire, caller, "mastermind", access)
        with self.assertRaises(door.Refusal):
            door.request_id("board alpha.12345678 0\n{}", "alpha", "mastermind", "ask")

    def test_dialog_uses_ask_access_and_exact_caller_origin(self):
        wire = "dialog nextnode.12345678\n{}"
        self.assertEqual(door.request_id(wire, "nextnode", "mastermind", "ask"), "nextnode.12345678")
        with self.assertRaises(door.Refusal) as denied:
            door.request_id(wire, "nextnode", "mastermind", "reply")
        self.assertEqual(denied.exception.status, 77)
        with self.assertRaises(door.Refusal) as forged:
            door.request_id(wire, "other", "mastermind", "ask")
        self.assertEqual(forged.exception.status, 64)

    def test_dialog_does_not_weaken_ordinary_or_reply_headers(self):
        for header in ["dialog nextnode.12345678 0", "dialog ../nextnode.12345678", "request nextnode.12345678", "reply nextnode.12345678 0"]:
            with self.subTest(header=header), self.assertRaises(door.Refusal):
                door.request_id(header + "\n{}", "nextnode", "mastermind", "ask")
        self.assertEqual(door.request_id("request nextnode.12345678 2\nordinary", "nextnode", "mastermind", "ask"), "nextnode.12345678")
        self.assertEqual(door.request_id("reply mastermind.12345678\nanswer", "nextnode", "mastermind", "reply"), "mastermind.12345678")
        with self.assertRaises(door.Refusal):
            door.request_id("reply nextnode.12345678\nanswer", "nextnode", "mastermind", "ask")


if __name__ == "__main__":
    unittest.main()
