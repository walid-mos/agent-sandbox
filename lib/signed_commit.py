#!/usr/bin/env python3
import base64
import binascii
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from source_refresh import GIT_OPTIONS, git_environment

PUBLIC_BLOCK_BEGIN = "-----BEGIN PGP PUBLIC KEY BLOCK-----"
PUBLIC_BLOCK_END = "-----END PGP PUBLIC KEY BLOCK-----"
PRIVATE_BLOCK = "PRIVATE KEY BLOCK"
PUBLIC_KEY_PACKET = 6
SECRET_KEY_PACKETS = {5, 7}
SIGNATURE_HEADERS = (b"gpgsig", b"gpgsig-sha256")
OPENPGP_SIGNATURE = b"-----BEGIN PGP SIGNATURE-----"
VALID_SIGNATURE = b"[GNUPG:] VALIDSIG "
WRITABLE_BY_OTHERS = stat.S_IWGRP | stat.S_IWOTH
ROOT = 0
USAGE = "usage: signed_commit.py signers FILE | verify DIRECTORY REVISION FILE"


class Untrusted(RuntimeError):
    pass


def require_owned_file(path):
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_uid not in (ROOT, os.geteuid()) or info.st_mode & WRITABLE_BY_OTHERS:
        raise Untrusted(f"signed-commit: {path} must be a regular file owned by root or by this user, writable by its owner only.")


def new_format_length(keyring, position):
    first = keyring[position]
    if first < 192:
        return first, position + 1
    if first < 224:
        return ((first - 192) << 8) + keyring[position + 1] + 192, position + 2
    if first == 255:
        return int.from_bytes(keyring[position + 1:position + 5], "big"), position + 5
    raise Untrusted("signed-commit: the signers file holds a partial-length packet, which no exported public key uses.")


def old_format_length(keyring, position, length_type):
    sizes = {0: 1, 1: 2, 2: 4}
    if length_type not in sizes:
        raise Untrusted("signed-commit: the signers file holds an indeterminate-length packet, which no exported public key uses.")
    size = sizes[length_type]
    return int.from_bytes(keyring[position:position + size], "big"), position + size


def next_packet(keyring, position):
    header = keyring[position]
    if not header & 0x80:
        raise Untrusted("signed-commit: the signers file is not an OpenPGP key export.")
    if header & 0x40:
        tag = header & 0x3F
        length, start = new_format_length(keyring, position + 1)
    else:
        tag = (header >> 2) & 0x0F
        length, start = old_format_length(keyring, position + 1, header & 0x03)
    if start + length > len(keyring):
        raise Untrusted("signed-commit: the signers file ends inside a packet.")
    return tag, start + length


def packet_tags(keyring):
    tags, position = [], 0
    try:
        while position < len(keyring):
            tag, position = next_packet(keyring, position)
            tags.append(tag)
    except IndexError:
        raise Untrusted("signed-commit: the signers file ends inside a packet header.") from None
    return tags


def dearmor(block):
    lines = [line.strip() for line in block.splitlines()]
    payload = "".join(line for line in lines if line and ":" not in line and not line.startswith("="))
    try:
        return base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        raise Untrusted("signed-commit: a public key block in the signers file is not valid base64.") from None


def public_keyring(text):
    if PRIVATE_BLOCK in text:
        raise Untrusted("signed-commit: the signers file holds private key material. Export only the public key with gpg --export --armor.")
    blocks, rest = [], text
    while PUBLIC_BLOCK_BEGIN in rest:
        body, found, rest = rest.partition(PUBLIC_BLOCK_BEGIN)[2].partition(PUBLIC_BLOCK_END)
        if not found:
            raise Untrusted("signed-commit: a public key block in the signers file has no end line.")
        blocks.append(dearmor(body))
    keyring = b"".join(blocks)
    tags = packet_tags(keyring)
    if not tags or tags[0] != PUBLIC_KEY_PACKET or SECRET_KEY_PACKETS.intersection(tags):
        raise Untrusted("signed-commit: the signers file must hold OpenPGP public keys only, exported with gpg --export --armor.")
    return keyring


def read_signers(path):
    require_owned_file(path)
    return public_keyring(Path(path).read_text())


def commit_object(directory, revision, git_options):
    result = subprocess.run(["git", *GIT_OPTIONS, *git_options, "-C", str(directory), "cat-file", "commit", revision],
                            env=git_environment(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if result.returncode:
        raise Untrusted(f"signed-commit: {revision} is not a commit in {directory}.")
    return result.stdout


# Git signs the commit object without its signature headers, continuation lines included.
def split_signature(commit):
    header, separator, message = commit.partition(b"\n\n")
    kept, signature = [], []
    dropping = collecting = False
    for line in header.split(b"\n"):
        value = line[1:]
        if not line.startswith(b" "):
            name, _, value = line.partition(b" ")
            dropping, collecting = name in SIGNATURE_HEADERS, name == SIGNATURE_HEADERS[0]
        if collecting:
            signature.append(value)
        if not dropping:
            kept.append(line)
    return b"\n".join(kept) + separator + message, b"\n".join(signature) + b"\n"


def write_private(path, content):
    path.write_bytes(content)
    path.chmod(0o600)


def valid_signer(keyring, payload, signature):
    gpgv = shutil.which("gpgv")
    if not gpgv:
        raise Untrusted("signed-commit: gpgv is missing, so no commit can be verified. Install it (Debian package gpgv).")
    with tempfile.TemporaryDirectory(prefix="signed-commit.") as scratch:
        files = {name: Path(scratch, name) for name in ("keyring.gpg", "payload", "payload.asc")}
        for name, content in zip(files, (keyring, payload, signature)):
            write_private(files[name], content)
        home = Path(scratch, "home")
        home.mkdir(mode=0o700)
        result = subprocess.run([gpgv, "--homedir", str(home), "--keyring", str(files["keyring.gpg"]), "--status-fd", "1",
                                 str(files["payload.asc"]), str(files["payload"])],
                                env={"PATH": os.environ.get("PATH", ""), "LANG": "C"}, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    signers = [line.split()[-1].decode() for line in result.stdout.splitlines() if line.startswith(VALID_SIGNATURE)]
    return signers[0] if result.returncode == 0 and signers else None


def require_signed(directory, revision, signers_path, git_options=()):
    payload, signature = split_signature(commit_object(directory, revision, git_options))
    if not signature.startswith(OPENPGP_SIGNATURE):
        raise Untrusted(f"signed-commit: {revision} in {directory} carries no OpenPGP signature, so it is not trusted.")
    signer = valid_signer(read_signers(signers_path), payload, signature)
    if not signer:
        raise Untrusted(f"signed-commit: {revision} in {directory} is not signed by a key in {signers_path}, so it is not trusted.")
    return signer


def check_signers(path):
    read_signers(path)
    return f"signed-commit: {path} holds public keys only."


COMMANDS = {"signers": (check_signers, 1), "verify": (require_signed, 3)}


def main(arguments):
    command, count = COMMANDS.get(arguments[0] if arguments else "", (None, -1))
    if not command or len(arguments) - 1 != count:
        print(USAGE, file=sys.stderr)
        return 2
    try:
        print(command(*arguments[1:]))
    except (Untrusted, OSError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
