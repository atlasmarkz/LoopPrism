"""CLI behaviour that does not need a running proxy."""

import os

import pytest
from typer.testing import CliRunner

from loopprism.cli.main import _prepare_db_path, app


@pytest.mark.parametrize("arg", ["traces.db", "./traces.db"])
def test_bare_db_filename_resolves_in_cwd(monkeypatch, tmp_path, arg):
    # Issue #1: `lprism proxy --db traces.db` crashed because
    # os.makedirs(os.path.dirname("traces.db")) is os.makedirs("").
    monkeypatch.chdir(tmp_path)
    assert os.path.samefile(os.path.dirname(os.path.abspath(_prepare_db_path(arg))), tmp_path)


def test_missing_db_directories_are_created(tmp_path):
    target = tmp_path / "a" / "b" / "traces.db"
    assert _prepare_db_path(str(target)) == str(target)
    assert target.parent.is_dir()


def test_db_path_expands_home(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    got = _prepare_db_path("~/nested/traces.db")
    assert got == str(tmp_path / "nested" / "traces.db")
    assert (tmp_path / "nested").is_dir()


@pytest.mark.parametrize("arg", ["traces.db", os.path.join("new", "dir", "traces.db")])
def test_analyze_accepts_bare_and_nested_db(monkeypatch, tmp_path, arg):
    monkeypatch.chdir(tmp_path)
    result = CliRunner().invoke(app, ["analyze", "no-such-trace", "--db", arg])
    assert result.exit_code == 0, result.output
    assert "not found" in result.output
    assert (tmp_path / arg).is_file()
