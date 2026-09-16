"""Inspect only an isolated example's lifetime after a failed Windows gate."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time

repo = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="k-controller-diagnostic-") as directory:
    root = Path(directory)
    artifact = root / "service.exe"
    subprocess.run(["rustc", str(repo / "examples/native-service.rs"), "-o", str(artifact)], check=True)
    request = {"protocolVersion": 1, "action": "start", "slot": "stable", "artifactPath": str(artifact)}
    child = subprocess.Popen([str(repo / "target/debug/k-example-controller.exe")], cwd=root,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    child.stdin.write(json.dumps(request).encode())
    child.stdin.close()
    time.sleep(7)
    ready = root / "service.json"
    print(json.dumps({"controllerExit": child.poll(), "serviceReady": ready.exists()}), flush=True)
    try:
        if ready.exists():
            data = json.loads(ready.read_text())
            address, port = data["address"].split(":")
            for action in ("probe", "stop"):
                with socket.create_connection((address, int(port)), timeout=2) as connection:
                    connection.sendall((action + " " + data["id"] + "\n").encode())
                    print(action, connection.recv(8192).decode(), flush=True)
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)
        print("controller stdout:", child.stdout.read(65536).decode(), flush=True)
        print("controller stderr:", child.stderr.read(65536).decode(), flush=True)
        # Wait only for this owned cooperative service to remove its ready file.
        until = time.monotonic() + 5
        while ready.exists() and time.monotonic() < until:
            time.sleep(0.02)
