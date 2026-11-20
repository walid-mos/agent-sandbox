from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from launch import LAUNCH

FACTORY_STATE = Path(LAUNCH["POTS_FACTORY_STATE"])
FACTORY_SEED = FACTORY_STATE / "bootstrap"
