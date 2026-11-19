from uuid import uuid4

from managed_update import Blocked
from receiver_state import GATEWAY_PHASES, QUIESCING, RESUMING, write_state

GATEWAY_UNAVAILABLE = 'gateway-drain-unavailable'


def hold_gateway(receiver, state, target, revision, descriptor):
    hold = uuid4().hex
    pending = write_state(receiver.root, {**state, 'phase': QUIESCING, 'gateway_hold': hold, 'loaded': None})
    try:
        receiver.gateway.pause(hold)
        receiver.gateway.drain(hold)
        receiver.vm.require_idle()
    except (Blocked, OSError) as problem:
        return resume_gateway(receiver, {**pending, 'blocked': failure_reason(problem)}, descriptor)
    return receiver.switch_release(pending, target, revision, descriptor)


def resume_gateway(receiver, state, descriptor):
    revision = state['known_good']
    settling = write_state(receiver.root, {**state, 'phase': RESUMING, 'loaded': None})
    try:
        if receiver.gateway is None:
            raise Blocked(GATEWAY_UNAVAILABLE)
        checkout = receiver.require_release(revision)
        receiver.require_health(checkout, revision, descriptor)
        receiver.gateway.resume(settling['gateway_hold'])
    except (Blocked, OSError) as problem:
        return record_gateway_failure(receiver, settling, problem)
    settling.pop('gateway_hold')
    settling.pop('recovery_failure', None)
    return write_state(receiver.root, {**settling, 'phase': 'ready', 'filesystem': revision, 'loaded': revision})


def recover_gateway(receiver, state, reason, descriptor):
    if state['phase'] in GATEWAY_PHASES:
        return resume_gateway(receiver, {**state, 'blocked': reason}, descriptor)
    try:
        if receiver.gateway is None:
            raise Blocked(GATEWAY_UNAVAILABLE)
        receiver.gateway.drain(state['gateway_hold'])
        receiver.vm.require_idle()
    except (Blocked, OSError) as problem:
        return record_gateway_failure(receiver, {**state, 'blocked': reason}, problem)
    return receiver.restore_release(state, reason, descriptor)


def failure_reason(problem):
    return str(problem) if isinstance(problem, Blocked) else 'receiver-io-failed'


def record_gateway_failure(receiver, state, problem):
    failure = failure_reason(problem)
    return write_state(receiver.root, {**state, 'blocked': state['blocked'] or failure, 'recovery_failure': failure})
