#!/usr/bin/env python3
"""Regression tests for narrow, fail-closed PostgreSQL restore equivalence."""
import importlib.util
from pathlib import Path
import unittest

PATH = Path(__file__).with_name("verify-restored-catalog.py")
spec = importlib.util.spec_from_file_location("verify_restored_catalog", PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CatalogParityTests(unittest.TestCase):
    def fixture(self):
        original = ["role|pulse_metrics_app|true|false|false|false|false|false",
                    *module.KNOWN_DEPARSE_VARIANTS.keys(),
                    "grant|invitation_rate_limits|SELECT|false",
                    "table|public.invitation_rate_limits|pulse_metrics_migrator|r|true|true"]
        return original

    def encode(self, lines):
        return ("\n".join(lines) + "\n").encode()

    def test_identical_snapshot_passes(self):
        value = self.encode(self.fixture())
        self.assertEqual(module.compare_catalogs(value, value, pin_source=False), 0)

    def test_both_exact_checked_rewrites_pass(self):
        original = self.fixture()
        restored = [module.KNOWN_DEPARSE_VARIANTS.get(line, line) for line in original]
        self.assertEqual(module.compare_catalogs(self.encode(original), self.encode(restored), pin_source=False), 2)

    def test_security_grant_change_fails(self):
        original = self.fixture()
        restored = [line.replace('SELECT|false', 'SELECT|true') for line in original]
        with self.assertRaisesRegex(ValueError, "Unexpected"):
            module.compare_catalogs(self.encode(original), self.encode(restored), pin_source=False)

    def test_constraint_value_change_fails(self):
        original = self.fixture()
        restored = [line.replace("'accept'::character varying", "'delete'::character varying") for line in original]
        with self.assertRaisesRegex(ValueError, "Unexpected"):
            module.compare_catalogs(self.encode(original), self.encode(restored), pin_source=False)

    def test_missing_catalog_row_fails(self):
        original = self.fixture()
        with self.assertRaisesRegex(ValueError, "row count"):
            module.compare_catalogs(self.encode(original), self.encode(original[:-1]), pin_source=False)

    def test_source_fingerprint_cannot_be_bypassed(self):
        value = self.encode(self.fixture())
        with self.assertRaisesRegex(ValueError, "independently reviewed"):
            module.compare_catalogs(value, value)

    def test_truncated_snapshot_fails(self):
        original = self.encode(self.fixture())
        with self.assertRaisesRegex(ValueError, "truncated"):
            module.compare_catalogs(original, original[:-1], pin_source=False)

    def test_order_swap_fails(self):
        original = self.fixture()
        altered = original.copy()
        altered[0], altered[1] = altered[1], altered[0]
        with self.assertRaisesRegex(ValueError, "Unexpected"):
            module.compare_catalogs(self.encode(original), self.encode(altered), pin_source=False)


if __name__ == '__main__':
    unittest.main(verbosity=2)
