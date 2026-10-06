"""demo-isolation-firewall.sh: render + idempotent ufw rule-file edits,
exercised against temp copies of before.rules/after.rules."""
import os
import subprocess
from pathlib import Path

SCRIPT = (Path(__file__).resolve().parent.parent
          / "scripts/server-setup/demo-isolation-firewall.sh")
BEGIN = "# BEGIN compendium-demo-isolation"
COMMIT_MARK = "# don't delete the 'COMMIT' line or these rules won't be processed"
BEFORE = f"""# rules.before
*filter
:ufw-before-input - [0:0]
-A ufw-before-input -i lo -j ACCEPT
-A ufw-before-input -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A ufw-before-input -p udp -d 239.255.255.250 --dport 1900 -j ACCEPT

{COMMIT_MARK}
COMMIT
"""
AFTER = f"""# rules.input-after
*filter
:ufw-after-input - [0:0]
-A ufw-after-input -p udp --dport 137 -j ufw-skip-to-policy-input

{COMMIT_MARK}
COMMIT
"""


def _run(env, tmp_path):
    full = {"PATH": os.environ["PATH"], "HOME": str(tmp_path), **env}
    return subprocess.run(["bash", str(SCRIPT)], env=full, capture_output=True,
                          text=True, timeout=20)


def _apply(tmp_path):
    ufw = tmp_path / "ufw"
    ufw.mkdir(exist_ok=True)
    if not (ufw / "before.rules").exists():
        (ufw / "before.rules").write_text(BEFORE)
        (ufw / "after.rules").write_text(AFTER)
    r = _run({"UFW_DIR": str(ufw), "SUDO": "", "NO_HOST": "1"}, tmp_path)
    assert r.returncode == 0, r.stdout + r.stderr
    return (ufw / "before.rules").read_text(), (ufw / "after.rules").read_text()


def test_render_only_prints_both_blocks(tmp_path):
    r = _run({"RENDER_ONLY": "1"}, tmp_path)
    assert r.returncode == 0
    out = r.stdout
    assert "-A ufw-before-input -i br-compdemo -m conntrack --ctstate NEW -j DROP" in out
    assert "-A DOCKER-USER -s 172.31.250.0/24 -d 172.31.250.0/24 -j RETURN" in out
    for dst in ("100.64.0.0/10", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",  # scan-ok: test-ip
                "169.254.0.0/16"):
        assert f"-A DOCKER-USER -s 172.31.250.0/24 -d {dst} -j DROP" in out


def test_before_rule_lands_inside_filter_before_commit(tmp_path):
    before, _ = _apply(tmp_path)
    lines = before.splitlines()
    rule = lines.index("-A ufw-before-input -i br-compdemo -m conntrack --ctstate NEW -j DROP")
    assert lines.index("*filter") < rule < lines.index(COMMIT_MARK)


def test_after_block_is_its_own_filter_table_at_the_end(tmp_path):
    _, after = _apply(tmp_path)
    tail = after[after.index(BEGIN):]
    assert tail.splitlines()[1] == "*filter"
    assert ":DOCKER-USER - [0:0]" in tail
    assert "-A DOCKER-USER -j RETURN" in tail
    assert tail.rstrip().endswith("# END compendium-demo-isolation")


def test_applying_twice_leaves_one_block(tmp_path):
    _apply(tmp_path)
    before, after = _apply(tmp_path)
    assert before.count(BEGIN) == 1 and after.count(BEGIN) == 1


def test_refuses_a_before_rules_without_the_commit_marker(tmp_path):
    ufw = tmp_path / "ufw"
    ufw.mkdir()
    (ufw / "before.rules").write_text("*filter\nCOMMIT\n")
    (ufw / "after.rules").write_text(AFTER)
    r = _run({"UFW_DIR": str(ufw), "SUDO": "", "NO_HOST": "1"}, tmp_path)
    assert r.returncode != 0
    assert (ufw / "before.rules").read_text() == "*filter\nCOMMIT\n"
