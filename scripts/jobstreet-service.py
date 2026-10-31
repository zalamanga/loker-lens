"""Run the reviewed JobStreet WSGI app on IPv4 loopback."""

import argparse
import json
import os
from pathlib import Path
import sys


COMMIT = "47c0b1712671d07e56696b3f4a69013ba4f66a0c"
PROJECT = Path(__file__).resolve().parent.parent
LOCAL_ROOT = (PROJECT / ".local" / "jobstreet-service").resolve()
SOURCE = (LOCAL_ROOT / "upstream").resolve()


def port_number(value):
    port = int(value)
    if not 1024 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be between 1024 and 65535")
    return port


def local_get_only(application, port):
    authorities = {f"127.0.0.1:{port}", f"localhost:{port}"}
    origins = {f"http://{authority}" for authority in authorities}

    def respond(environ, start_response):
        status, message = None, None
        if environ.get("REQUEST_METHOD") != "GET":
            status, message = "405 Method Not Allowed", "Only read-only GET requests are supported."
        elif environ.get("HTTP_HOST") not in authorities:
            status, message = "403 Forbidden", "A loopback Host header is required."
        elif environ.get("HTTP_ORIGIN") and environ["HTTP_ORIGIN"] not in origins:
            status, message = "403 Forbidden", "Cross-origin browser requests are not supported."
        if status:
            body = json.dumps({"error": message}).encode("utf-8")
            headers = [("Content-Type", "application/json"), ("Content-Length", str(len(body))), ("Cache-Control", "no-store")]
            if status.startswith("405"):
                headers.append(("Allow", "GET"))
            start_response(status, headers)
            return [body]
        return application(environ, start_response)

    return respond


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=port_number, default=8131)
    arguments = parser.parse_args()
    if sys.version_info[:2] != (3, 13):
        raise SystemExit("Use the project's Python 3.13 virtual environment.")
    if not LOCAL_ROOT.is_relative_to(PROJECT / ".local") or SOURCE != LOCAL_ROOT / "upstream":
        raise SystemExit("The upstream checkout must remain inside this project's .local directory.")
    if (SOURCE / ".git" / "HEAD").read_text(encoding="ascii").strip() != COMMIT:
        raise SystemExit("The upstream checkout must be detached at the reviewed commit.")

    # Proxy and raw-response debugging are disabled only in this child process.
    for variable in ("JOBSTREET_PROXY", "JOBSTREET_DEBUG_DIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        os.environ.pop(variable, None)
    sys.path.insert(0, str(SOURCE))
    import bottle
    from cheroot import wsgi
    import routes  # Registers the reviewed routes on Bottle's default app.

    application = local_get_only(bottle.default_app(), arguments.port)
    server = wsgi.Server(("127.0.0.1", arguments.port), application, server_name="loker-lens-jobstreet", numthreads=4)
    print(f"JobStreet service PID={os.getpid()} commit={COMMIT} url=http://127.0.0.1:{arguments.port}/", flush=True)
    try:
        server.start()
    except KeyboardInterrupt:
        server.stop()


if __name__ == "__main__":
    main()
