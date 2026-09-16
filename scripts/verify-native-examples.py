#!/usr/bin/env python3
"""Run the shipped Rust examples with real, temporary native service processes."""
import functools
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading

REPO = Path(__file__).resolve().parents[1]
EXE = ".exe" if os.name == "nt" else ""


def run(args, **kwargs):
    print("running", Path(args[0]).name, " ".join(args[1:3]), flush=True)
    timeout = kwargs.pop("timeout", 60)
    input_text = kwargs.pop("input", None)
    child = subprocess.Popen(args, cwd=REPO, text=True, stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
    try:
        stdout, stderr = child.communicate(input=input_text, timeout=timeout)
    except subprocess.TimeoutExpired:
        # Do not call unbounded communicate() after kill: a resident child with
        # an inherited pipe is precisely one of the bugs this example catches.
        child.kill()
        child.wait(timeout=5)
        raise
    if child.returncode:
        print(stderr[-4096:], file=sys.stderr, flush=True)
        print(stdout[-4096:], file=sys.stderr, flush=True)
        raise subprocess.CalledProcessError(child.returncode, args, stdout, stderr)
    return subprocess.CompletedProcess(args, child.returncode, stdout, stderr)


def main():
    with tempfile.TemporaryDirectory(prefix="k-native-examples-") as directory:
        root = Path(directory)
        artifacts = root / "artifacts"
        artifacts.mkdir()
        for version in ("1.0.0", "2.0.0"):
            env = dict(os.environ, K_EXAMPLE_VERSION=version)
            run(["rustc", "--edition=2024", "-C", "debuginfo=0",
                 "examples/native-service.rs", "-o", str(artifacts / (version + EXE))], env=env)
            run(["cargo", "build", "--locked", "--example", "native-swap"], env=env, timeout=600)
            shutil.copy2(REPO / "target/debug/examples" / ("native-swap" + EXE),
                         root / ("swap-" + version + EXE))
        run(["cargo", "build", "--locked", "--bin", "k-example-controller", "--bin", "k-harness",
             "--example", "native-installer"], timeout=600)
        controller = REPO / "target/debug" / ("k-example-controller" + EXE)
        installer = REPO / "target/debug/examples" / ("native-installer" + EXE)
        harness = REPO / "target/debug" / ("k-harness" + EXE)
        platform = {"darwin": "darwin", "linux": "linux", "win32": "win32"}[sys.platform]
        import platform as platform_module
        arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "AMD64": "x64"}[platform_module.machine()]
        data = (artifacts / ("2.0.0" + EXE)).read_bytes()
        (artifacts / "manifest.json").write_text(json.dumps({"version": "2.0.0", "targets": {
            platform + "-" + arch: {"file": "2.0.0" + EXE, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}}}))
        class QuietHandler(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *_args):
                pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0),
            functools.partial(QuietHandler, directory=str(artifacts)))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        work = root / "service"
        work.mkdir()
        env = dict(os.environ, K_EXAMPLE_ROOT=str(work), K_EXAMPLE_CONTROLLER=str(controller),
                   K_RELEASE_BASE=f"http://127.0.0.1:{server.server_address[1]}", PATH="/nonexistent",
                   NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
        try:
            run([str(installer), "bootstrap", "1.0.0", str(artifacts / ("1.0.0" + EXE))], env=env)
            request = {"protocolVersion": 1, "action": "upgrade", "id": "native-example", "targetVersion": "2.0.0", "consented": True}
            first = json.loads(run([str(installer)], input=json.dumps(request), env=env).stdout)
            assert first["response"]["operation"]["operation"]["outcome"] == "promoted", first
            replay = json.loads(run([str(installer)], input=json.dumps(request), env=env).stdout)
            assert replay["response"]["operation"]["operation"]["id"] == "native-example", replay
            probe = subprocess.run([str(controller)], cwd=work, env=env, input=json.dumps({"protocolVersion": 1, "action": "probe"}),
                                   check=True, text=True, capture_output=True, timeout=10)
            assert json.loads(probe.stdout)["evidence"]["version"] == "2.0.0"
            target = root / "k.target.json"
            target.write_text(json.dumps({"version": ["--version"], "selfUpgrade": ["upgrade"], "artifact": str(root / ("swap-2.0.0" + EXE))}))
            blackbox = json.loads(run([str(harness), "--bin", str(root / ("swap-1.0.0" + EXE)), "--target", str(target), "--json"], env=env).stdout)
            assert blackbox["result"] == "pass", blackbox
            print(json.dumps({"result": "pass", "platform": platform + "-" + arch,
                              "checks": ["native-example-bootstrap", "supervised-upgrade", "receipt-replay", "live-probe", "verified-http-self-swap"], "nodeRequired": False}))
        finally:
            try:
                subprocess.run([str(controller)], cwd=work, env=env,
                    input=json.dumps({"protocolVersion": 1, "action": "stop", "slot": "stable"}),
                    check=True, text=True, capture_output=True, timeout=10)
                assert not (work / "service.json").exists(), "example service cleanup incomplete"
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)


if __name__ == "__main__":
    main()
