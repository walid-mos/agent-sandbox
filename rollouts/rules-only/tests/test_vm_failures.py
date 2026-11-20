from itertools import product
import json
import unittest

from fixture import EXPECTED, ORIGINAL, Fixture


class VmFailureTests(unittest.TestCase):
    def test_failure_before_or_after_each_vm_replacement_never_acknowledges_or_retries(self):
        names = ('sandbox.json', 'vault.json', 'git-identity.json', 'RULES.md')
        for name, point in product(names, ('before', 'after')):
            with self.subTest(name=name, point=point):
                fixture = Fixture(self)
                fixture.options['storeFault'] = f'{name}:{point}'
                result = fixture.run()
                self.assertNotEqual(result.returncode, 0)
                state = json.loads((fixture.directory / 'client-rules.json').read_bytes())
                self.assertIs(state['isPending'], True)
                self.assertEqual(fixture.records()[-1]['step'], 'vm-transfer')
                self.assertEqual(fixture.records()[-1]['status'], 'failed-unknown')
                expected = EXPECTED if (name, point) == ('RULES.md', 'after') else ORIGINAL
                self.assertEqual(fixture.target.read_bytes(), expected)
                self.assertNotEqual(fixture.run().returncode, 0)
                fixture.scratch.cleanup()


if __name__ == '__main__':
    unittest.main()
