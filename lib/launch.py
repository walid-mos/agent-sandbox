from pathlib import Path


def assignments(path):
    return dict(line.split("=", 1) for line in Path(path).read_text().splitlines() if line)


LAUNCH = assignments(Path(__file__).resolve().parents[1] / "session/launch.env")
