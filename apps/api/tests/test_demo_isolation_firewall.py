"""demo-isolation-firewall.sh: render + idempotent ufw rule-file edits,
exercised against temp copies of before.rules/after.rules."""
import os
import subprocess
from pathlib import Path

SCRIPT = (Path(__file__).resolve().parent.parent
          / "scripts/server-setup/demo-isolation-firewall.sh")
BEGIN = "# BEGIN compendium-demo-isolation"
END = "# END compendium-demo-isolation"
COMMIT_MARK = "# don't delete the 'COMMIT' line or these rules won't be processed"
ESTABLISHED = "-A ufw-before-input -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT"
DROP_RULE = "-A ufw-before-input -i br-compdemo -m conntrack --ctstate NEW -j DROP"
SUBNET = "172.31.250.0/24"
BLOCKED = ["100.64.0.0/10", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"]  # scan-ok: test-ip
EXPECTED_AFTER = [
    BEGIN, "*filter", ":DOCKER-USER - [0:0]",
    f"-A DOCKER-USER -s {SUBNET} -d {SUBNET} -j RETURN",
    f"-A DOCKER-USER -s {SUBNET} -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN",
    *[f"-A DOCKER-USER -s {SUBNET} -d {d} -j DROP" for d in BLOCKED],
    "-A DOCKER-USER -j RETURN", "COMMIT", END,
]
EXPECTED_BEFORE = [BEGIN, DROP_RULE, END]
BEFORE = f"""# rules.before
*filter
:ufw-before-input - [0:0]
-A ufw-before-input -i lo -j ACCEPT
{ESTABLISHED}
-A ufw-before-input -p icmp --icmp-type echo-request -j ACCEPT
-A ufw-before-input -p udp --sport 67 --dport 68 -j ACCEPT
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
    lines = r.stdout.splitlines()
    a = lines.index(BEGIN)
    assert lines[a:a + len(EXPECTED_AFTER)] == EXPECTED_AFTER
    b = lines.index(BEGIN, a + 1)
    assert lines[b:b + len(EXPECTED_BEFORE)] == EXPECTED_BEFORE


def test_before_rule_follows_established_accept_and_precedes_icmp(tmp_path):
    before, _ = _apply(tmp_path)
    lines = before.splitlines()
    est = lines.index(ESTABLISHED)
    assert lines[est + 1:est + 1 + len(EXPECTED_BEFORE)] == EXPECTED_BEFORE
    assert lines[est + 1 + len(EXPECTED_BEFORE)] == "-A ufw-before-input -p icmp --icmp-type echo-request -j ACCEPT"
    assert lines.index("*filter") < est < lines.index(COMMIT_MARK)


def test_after_block_is_its_own_filter_table_at_the_end(tmp_path):
    _, after = _apply(tmp_path)
    tail = after[after.index(BEGIN):]
    assert tail.splitlines() == EXPECTED_AFTER


def test_applying_twice_leaves_one_block(tmp_path):
    _apply(tmp_path)
    before, after = _apply(tmp_path)
    assert before.count(BEGIN) == 1 and after.count(BEGIN) == 1


def _refused(tmp_path, before_text):
    ufw = tmp_path / "ufw"
    ufw.mkdir()
    (ufw / "before.rules").write_text(before_text)
    (ufw / "after.rules").write_text(AFTER)
    r = _run({"UFW_DIR": str(ufw), "SUDO": "", "NO_HOST": "1"}, tmp_path)
    assert r.returncode != 0
    assert (ufw / "before.rules").read_text() == before_text
    assert (ufw / "after.rules").read_text() == AFTER
    assert not list(ufw.glob("*.bak-*"))


def test_refuses_a_before_rules_without_the_established_anchor(tmp_path):
    _refused(tmp_path, "*filter\nCOMMIT\n")


def test_refuses_when_the_anchor_is_only_in_a_nat_table(tmp_path):
    _refused(tmp_path, f"*nat\n{ESTABLISHED}\nCOMMIT\n*filter\n:ufw-before-input - [0:0]\nCOMMIT\n")


def test_after_rules_without_trailing_newline(tmp_path):
    ufw = tmp_path / "ufw"
    ufw.mkdir()
    (ufw / "before.rules").write_text(BEFORE)
    (ufw / "after.rules").write_text(AFTER.rstrip("\n"))
    r = _run({"UFW_DIR": str(ufw), "SUDO": "", "NO_HOST": "1"}, tmp_path)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "COMMIT\n" + BEGIN in (ufw / "after.rules").read_text()
    r = _run({"UFW_DIR": str(ufw), "SUDO": "", "NO_HOST": "1"}, tmp_path)
    assert r.returncode == 0, r.stdout + r.stderr
    assert (ufw / "after.rules").read_text().count(BEGIN) == 1
