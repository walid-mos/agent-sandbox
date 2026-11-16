#!/usr/bin/env python3
import json
from pathlib import Path

MEMORY_FIELDS = {"MemTotal", "MemFree", "MemAvailable", "Buffers", "Cached", "SReclaimable", "SwapTotal", "SwapFree"}
COUNTERS = {"balloon_inflate", "balloon_deflate", "balloon_migrate"}
BALLOON_DEVICE = "0x0005"
REPORTING_BIT = 5

memory = {}
for line in Path("/proc/meminfo").read_text().splitlines():
    name, amount = line.split(":", 1)
    if name in MEMORY_FIELDS:
        memory[name] = int(amount.split()[0])

balloons = []
for device in Path("/sys/bus/virtio/devices").glob("*"):
    if (device / "device").read_text().strip() != BALLOON_DEVICE:
        continue
    features = (device / "features").read_text().strip()
    balloons.append({"device": device.name, "features": features, "hasFreePageReporting": features[REPORTING_BIT] == "1"})

counters = {}
for line in Path("/proc/vmstat").read_text().splitlines():
    name, amount = line.split()
    if name in COUNTERS:
        counters[name] = int(amount)

print(json.dumps({"memoryKiB": memory, "balloons": balloons, "balloonPages": counters}))
