#!/usr/bin/env python3
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'vm'))
from vault_policy import Refused, entries_for, read_grant


class ReadPolicyTests(unittest.TestCase):
    def test_policy_load_refuses_extra_grant_fields(self):
        policy = {'readRepositories': {'ExampleOrg/reference': {'credential': 'GITHUB_TOKEN_REFERENCE', 'url': 'https://evil.invalid'}}}
        with self.assertRaises(Refused):
            entries_for({'kind': 'sandbox'}, policy, {})

    def test_policy_load_refuses_malformed_grants(self):
        for grant in [None, [], {'ExampleOrg/reference': 'TOKEN'}, {'../reference': {'credential': 'TOKEN'}},
                      {'ExampleOrg/reference.git': {'credential': 'TOKEN'}}, {'ExampleOrg/reference': {'credential': 'INFISICAL_TOKEN'}}]:
            with self.subTest(grant=grant), self.assertRaises(Refused):
                entries_for({'kind': 'sandbox'}, {'readRepositories': grant}, {})

    def test_exact_read_selection_and_request_shape(self):
        policy = {'readRepositories': {'ExampleOrg/reference': {'credential': 'GITHUB_TOKEN_REFERENCE'}}}
        request = {'kind': 'read', 'repository': 'ExampleOrg/reference', 'commits': ['a' * 40]}
        self.assertEqual(read_grant(request, policy), 'GITHUB_TOKEN_REFERENCE')
        repositories = ['ExampleOrg/other', 'Other/reference', 'exampleorg/reference',
                        'https://github.com/ExampleOrg/reference', 'https://github.com.evil/ExampleOrg/reference',
                        'git@github.com:ExampleOrg/reference', 'file:///reference', '../reference', 'ExampleOrg/reference.git']
        invalid = [{**request, 'repository': repository} for repository in repositories]
        invalid += [{**request, 'commits': commits} for commits in [['--upload-pack=evil'], ['a' * 39], ['A' * 40], ['a' * 40] * 17, None]]
        invalid += [{**request, 'url': 'https://evil.invalid'}, {**request, 'credential': 'OTHER'}, {**request, 'public': True}]
        for attack in invalid:
            with self.subTest(attack=attack), self.assertRaises(Refused):
                read_grant(attack, policy)
        with self.assertRaises(Refused):
            read_grant(request, {})

    def test_policy_load_refuses_non_object_configuration(self):
        with self.assertRaises(Refused):
            read_grant({'kind': 'read', 'repository': 'ExampleOrg/reference', 'commits': []}, [])

    def test_read_grants_never_join_secret_releases(self):
        policy = {'owners': {'Existing': 'GITHUB_TOKEN_EXISTING'},
                  'readRepositories': {'ExampleOrg/reference': {'credential': 'GITHUB_TOKEN_REFERENCE'}}}
        self.assertEqual(entries_for({'kind': 'sandbox'}, policy, {}), [('/tools/github', 'GITHUB_TOKEN_EXISTING')])
        with self.assertRaises(Refused):
            entries_for({'kind': 'secret', 'path': '/tools/github', 'name': 'GITHUB_TOKEN_REFERENCE'}, policy, {})
        with self.assertRaises(Refused):
            entries_for({'kind': 'source', 'repository': 'ExampleOrg/reference'}, policy, {})


if __name__ == '__main__':
    unittest.main()
