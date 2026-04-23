#!/usr/bin/env python3
"""
View backend logs from file
"""
from pathlib import Path
import sys

log_file = Path(__file__).parent / "logs" / "backend.log"

if not log_file.exists():
    print(f"❌ Log file not found: {log_file}")
    sys.exit(1)

print(f"📋 Backend Logs: {log_file}")
print("=" * 80)

# Display last 100 lines
with open(log_file, 'r') as f:
    lines = f.readlines()
    start_idx = max(0, len(lines) - 100)
    for line in lines[start_idx:]:
        print(line, end='')

print("\n" + "=" * 80)
print(f"📊 Total lines: {len(lines)}")
print(f"💡 To follow logs in real-time, use: tail -f {log_file}")
