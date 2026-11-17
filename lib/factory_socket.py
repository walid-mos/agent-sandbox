import hmac
import json
from pathlib import Path
import secrets
import socket
import socketserver

TOKEN_FILE = "token"
TOKEN_LENGTH = 64
REQUEST_SECONDS = 30
CLIENT_SECONDS = 150
REQUEST_LIMIT = 16384
RESPONSE_LIMIT = 65536


class Refused(Exception):
    pass


# The caller authenticates with a token VM root writes into the socket's directory, which only the isolated factory mounts. A session reaches neither file, and VM root is trusted.
def token_file(path):
    return Path(path).parent / TOKEN_FILE


def serve(path, name, limit, answer, guarantee):
    path = Path(path)

    class Handler(socketserver.StreamRequestHandler):
        timeout = REQUEST_SECONDS

        def handle(self):
            try:
                if not hmac.compare_digest(self.rfile.readline(TOKEN_LENGTH + 2), token_file(path).read_bytes()):
                    raise Refused("the isolated factory's token is missing or wrong. Nothing was done.")
                line = self.rfile.readline(limit + 1)
                if len(line) > limit or not line.endswith(b"\n"):
                    raise Refused(f"{name}: send one bounded JSON line.")
                reply = {"ok": True, **answer(json.loads(line))}
            except Refused as error:
                reply = {"ok": False, "error": f"{name}: {error} {guarantee}"}
            except (ValueError, OSError, KeyError):
                reply = {"ok": False, "error": f"{name}: malformed request or unavailable state. {guarantee}"}
            self.wfile.write((json.dumps(reply) + "\n").encode())

    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    path.unlink(missing_ok=True)
    with socketserver.UnixStreamServer(str(path), Handler) as server:
        path.chmod(0o666)
        token = token_file(path)
        token.write_text(secrets.token_hex(TOKEN_LENGTH // 2) + "\n")
        token.chmod(0o444)
        print(f"{name}: ready", flush=True)
        server.serve_forever()


def ask(path, request):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(CLIENT_SECONDS)
        connection.connect(str(path))
        connection.sendall(token_file(path).read_bytes() + (json.dumps(request) + "\n").encode())
        connection.shutdown(socket.SHUT_WR)
        with connection.makefile("rb") as incoming:
            response = incoming.readline(RESPONSE_LIMIT + 1)
    if len(response) > RESPONSE_LIMIT or not response.endswith(b"\n"):
        raise ValueError("unreadable service response")
    reply = json.loads(response)
    if reply.get("ok") is not True:
        raise ValueError(reply.get("error", "service refused the operation"))
    return reply
