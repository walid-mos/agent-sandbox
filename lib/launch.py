from pathlib import Path

LAUNCH = dict(line.split("=", 1) for line in (Path(__file__).resolve().parents[1] / "session/launch.env").read_text().splitlines() if line)
