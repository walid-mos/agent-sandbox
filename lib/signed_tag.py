from hashlib import sha1
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from signed_commit import GIT_OPTIONS, OPENPGP_SIGNATURE, Untrusted, git_environment, read_signers, valid_signer

SIGNATURE_START = b"\n" + OPENPGP_SIGNATURE


def tag_object(directory, tag_id, git_options):
    result = subprocess.run(["git", *GIT_OPTIONS, *git_options, "-C", str(directory), "cat-file", "tag", tag_id],
                            env=git_environment(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if result.returncode:
        raise Untrusted(f"signed-tag: {tag_id} is not an annotated tag in {directory}.")
    if sha1(f"tag {len(result.stdout)}\0".encode() + result.stdout, usedforsecurity=False).hexdigest() != tag_id:
        raise Untrusted(f"signed-tag: {tag_id} in {directory} does not hash to its own ID.")
    return result.stdout


def require_signed_tag(directory, tag_id, signers_path, git_options=()):
    raw = tag_object(directory, tag_id, git_options)
    payload, separator, rest = raw.partition(SIGNATURE_START)
    if not separator:
        raise Untrusted(f"signed-tag: {tag_id} in {directory} carries no OpenPGP signature, so it is not trusted.")
    signer = valid_signer(read_signers(signers_path), payload + b"\n", OPENPGP_SIGNATURE + rest)
    if not signer:
        raise Untrusted(f"signed-tag: {tag_id} in {directory} is not signed by a key in {signers_path}, so it is not trusted.")
    return signer, payload + b"\n"
