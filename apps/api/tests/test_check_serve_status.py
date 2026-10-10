"""check_serve_status.sh evaluates `tailscale serve status` text per block."""
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/server/check_serve_status.sh"

B8443 = "https://box.tail0000.ts.net:8443 (tailnet only)\n|-- / proxy http://127.0.0.1:8001\n"
B443 = "https://box.tail0000.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:3000\n"


def run(text):
    p = subprocess.run(["bash", str(SCRIPT)], input=text, capture_output=True, text=True)
    return p.returncode, p.stdout


def test_script_parses_and_is_executable():
    subprocess.run(["bash", "-n", str(SCRIPT)], check=True)
    assert SCRIPT.stat().st_mode & 0o111


def test_post_cutover_only_8443_passes():
    rc, out = run(B8443)
    assert rc == 0, out
    assert "keeps :8443 -> 127.0.0.1:8001" in out
    assert "holds nothing but :8443" in out


def test_pre_cutover_443_block_fails():
    rc, out = run(B443 + "\n" + B8443)
    assert rc == 1
    assert "still holds :443" in out
    assert "keeps :8443 -> 127.0.0.1:8001" in out


def test_8443_proxying_elsewhere_fails():
    rc, out = run("https://box.tail0000.ts.net:8443 (tailnet only)\n|-- / proxy http://127.0.0.1:9999\n")
    assert rc == 1
    assert "[FAIL]" in out and "keeps" not in out


def test_no_serve_config_fails():
    for text in ("No serve config\n", ""):
        rc, out = run(text)
        assert rc == 1
        assert "no config" in out


def test_extra_block_on_10000_fails():
    extra = "https://box.tail0000.ts.net:10000 (tailnet only)\n|-- / proxy http://127.0.0.1:5000\n"
    rc, out = run(B8443 + "\n" + extra)
    assert rc == 1
    assert "still holds :10000" in out
    assert "keeps :8443 -> 127.0.0.1:8001" in out
