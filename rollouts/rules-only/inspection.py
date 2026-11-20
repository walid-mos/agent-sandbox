from pathlib import Path
import platform

from guards import AREA, Commands, digest, private_file, read_json, require
from journal import inspect_journal
from mutation_records import inspect_operations
from process_state import ENDED, LIVE, UNKNOWN
from preflight import path_proof
from sources import prove_files
from transport import FixtureTransport, Transport, fixture_scope


def inspect(options):
    path = private_file(options.contract)
    require(digest(path.read_bytes()) == options.contract_sha256, 'contract hash differs')
    contract = read_json(path)
    records, owner = inspect_journal(contract)
    mutations = inspect_operations(Path(contract['journal']), contract)
    blocked = continuation_status(records, owner, mutations)
    if blocked:
        return {'journal': records, 'owner': owner, 'mutations': mutations, 'observed': {},
                'action': blocked + '. No target reads. Owner reconciliation required. No writes performed.'}
    private = Path(contract['privateCheckout'])
    directory = Path(contract['runtime']) / 'sandboxes/accor'
    paths = {'original': Path(contract['original']), 'canonical': private / 'rules/AGENTS.md',
             'snapshot': directory / 'client-rules.md', 'approval': directory / 'client-rules.json'}
    observed = {name: path_proof(path) for name, path in paths.items()}
    original = observed['original']
    if 'link' in original:
        observed['original'] = {'isSnapshotLink': original['link'] == str(paths['snapshot'])}
    if paths['approval'].is_file():
        state = read_json(paths['approval'])
        require(type(state['isPending']) is bool, 'invalid pending state')
        observed['isPending'] = state['isPending']
    commands = Commands(60)
    observed['privateCommit'] = commands.git(private, 'rev-parse', 'HEAD')
    branch = commands.git(private, 'branch', '--show-current')
    resources = read_json(AREA / 'resources.json')
    require(branch in ('main', resources['privateBranch']), 'unexpected private branch. Reconcile privately.')
    observed['privateBranch'] = branch
    if options.vm:
        observed['vm'] = inspect_vm(options, commands, contract, resources, directory)
    return {'journal': records, 'owner': owner, 'mutations': mutations, 'observed': observed,
            'action': 'owner reconciliation required. No resume, retry, rollback, cleanup, or writes performed.'}


def continuation_status(records, owner, mutations):
    if owner == LIVE or any(operation['status'] == LIVE for operation in mutations):
        return LIVE + ' continuation or journal owner'
    latest = {record.get('step', ''): record['status'] for record in records}
    if any(operation['status'] != ENDED or latest.get(operation['stage']) != 'confirmed' for operation in mutations):
        return UNKNOWN + ' continuation. Local group completion does not prove detached or remote quiescence'
    return ''


def inspect_vm(options, commands, contract, resources, directory):
    if options.fixture_root:
        root, fixture, resources = fixture_scope(options, contract, resources)
        transport = FixtureTransport(commands, contract, resources, root, fixture)
    else:
        require(platform.system() == 'Darwin', 'VM inspection requires the reviewed operator Mac')
        prove_files(Path(contract['checkout']), resources)
        transport = Transport(commands, contract, resources)
    configuration = read_json(directory / 'sandbox.json')
    target = Path(configuration['rules'])
    require(target.parent == Path(contract['installed']) and target.suffix == '.md', 'inspection target differs')
    return transport.observe(target)
