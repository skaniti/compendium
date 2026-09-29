"""ops_mask.py: exact-value and shape masking for the ops journal."""

import subprocess
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
SCRIPT = API_DIR / "scripts" / "server" / "ops_mask.py"


def run_mask(text, secrets_file, *, chunks=None):
    env = {"OPS_MASK_SECRETS": str(secrets_file), "PATH": "/usr/bin:/bin"}
    proc = subprocess.Popen(
        [sys.executable, str(SCRIPT)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        env=env,
    )
    data = text.encode()
    if chunks:
        for i in range(0, len(data), chunks):
            proc.stdin.write(data[i : i + chunks])
            proc.stdin.flush()
    else:
        proc.stdin.write(data)
    proc.stdin.close()
    out = proc.stdout.read().decode()
    proc.wait()
    return out


@pytest.fixture
def secrets(tmp_path):
    f = tmp_path / "secrets"
    f.write_text(
        "# comment\n"
        "DB_PASSWORD=" + "pw" + "Xy7" + "QzLm" + "\n"
        'export API_KEY="' + "ak" + "Zq" + "19Lp0Rt" + '"\n'
        "SHORT=" + "abc" + "1234" + "\n"
        "LONG=" + "longer" + "value" + "-with-more" + "\n"
        "LONGER=" + "longer" + "value" + "-with-more-tail" + "\n"
    )
    return f


def test_exact_values_masked_with_key(secrets):
    out = run_mask("a pwXy7QzLm b akZq19Lp0Rt c\n", secrets)
    assert out == "a <SECRET:DB_PASSWORD> b <SECRET:API_KEY> c\n"


def test_export_and_quotes_parsed(secrets):
    assert "<SECRET:API_KEY>" in run_mask("x akZq19Lp0Rt\n", secrets)


def test_short_value_untouched(secrets):
    assert run_mask("abc1234\n", secrets) == "abc1234\n"


def test_longest_value_first(secrets):
    out = run_mask("longervalue-with-more-tail\n", secrets)
    assert out == "<SECRET:LONGER>\n"


@pytest.mark.parametrize(
    ("token", "kind"),
    [
        ("sk-ant-" + "a1B2c3D4" * 4, "token"),
        ("sk-" + "a1B2c3D4" * 4, "token"),
        ("cmp_" + "a1B2c3D4" * 5, "token"),
        ("hf_" + "aB3dE5gH" * 4, "token"),
        ("ghp_" + "aB3dE5gH" * 4, "token"),
        ("eyJ" + "hbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIx" + "." + "SflKxwRJSMeKKF2QT4", "jwt"),
        ("Bearer " + "abcdef0123456789" + "XYZ", "bearer"),
        ("PGPASSWORD=" + "hunter2", "assignment"),
        ("token=" + "xyz", "assignment"),
        ("postgresql://user:" + "p@ss" + "@", "dsn"),
        ("0123456789abcdef" * 3 + "01", "hex"),
        ("Zx9_-" * 10 + "Q", "b64"),
    ],
)
def test_shape_masked(token, kind, tmp_path):
    empty = tmp_path / "none"
    empty.write_text("")
    out = run_mask(f"pre {token} post\n", empty)
    assert f"<REDACTED:{kind}>" in out
    assert token not in out
    assert out.startswith("pre ") or kind == "assignment"


def test_git_sha_and_ordinary_word_survive(tmp_path):
    empty = tmp_path / "none"
    empty.write_text("")
    line = "commit " + "a1b2c3d4e5" * 4 + " deploy\n"
    assert run_mask(line, empty) == line


def test_multiline_and_partial_line_streaming(secrets):
    text = "one pwXy7QzLm\ntwo\nthree akZq19Lp0Rt"
    out = run_mask(text, secrets, chunks=3)
    assert out == "one <SECRET:DB_PASSWORD>\ntwo\nthree <SECRET:API_KEY>"


def test_invalid_utf8_does_not_crash(tmp_path):
    empty = tmp_path / "none"
    empty.write_text("")
    proc = subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=b"ok \xff\xfe end\n",
        capture_output=True,
        check=False,
        env={"OPS_MASK_SECRETS": str(empty)},
    )
    assert proc.returncode == 0
    assert proc.stdout.startswith(b"ok ")


def test_missing_secrets_file_still_shape_masks(tmp_path):
    out = run_mask("hf_" + "aB3dE5gH" * 4 + "\n", tmp_path / "absent")
    assert out == "<REDACTED:token>\n"


def test_shape_patterns_match_audit_repo():
    sys.path.insert(0, str(API_DIR))
    sys.path.insert(0, str(API_DIR / "scripts" / "server"))
    import ops_mask

    from backend.db import audit_repo

    assert tuple(ops_mask.SECRET_SHAPE_PATTERNS) == tuple(audit_repo.SECRET_SHAPE_PATTERNS)


def test_inline_comment_stripped(tmp_path):
    f = tmp_path / "s"
    f.write_text("A=" + "plainvalue1" + " # note\n" + 'B="' + "quotedval2" + '" # note\n')
    out = run_mask("plainvalue1 quotedval2 note\n", f)
    assert out == "<SECRET:A> <SECRET:B> note\n"


def test_every_env_example_secret_key_masked(tmp_path):
    import re
    import secrets as pysecrets

    keys = []
    for line in (API_DIR / ".env.example").read_text().splitlines():
        m = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=", line)
        if m and (
            re.search(r"(?i)(key|secret|token|password|passwd)", m.group(1))
            or m.group(1) in ("DATABASE_URL", "TEST_DATABASE_URL")
        ):
            keys.append(m.group(1))
    keys = sorted(set(keys))
    assert len(keys) >= 8
    values = {k: pysecrets.token_hex(12) for k in keys}  # 24 chars, runtime-made
    f = tmp_path / "s"
    f.write_text("".join(f"{k}={v}\n" for k, v in values.items()))
    text = "".join(f"{k} is {v}\n" for k, v in values.items())
    out = run_mask(text, f)
    for k, v in values.items():
        assert v not in out
        assert f"<SECRET:{k}>" in out


def test_ordinary_eight_char_word_survives(tmp_path):
    empty = tmp_path / "none"
    empty.write_text("")
    assert run_mask("status: deployed ok\n", empty) == "status: deployed ok\n"
