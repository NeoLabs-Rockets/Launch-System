#!/usr/bin/env python3
import argparse
import datetime
import hashlib
import json
import pathlib
import re


MAX_OTA_SLOT_BYTES = 0x140000


def main():
    parser = argparse.ArgumentParser(description="Create a validated NeoLabs firmware release manifest")
    parser.add_argument("--firmware", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--environment", default="esp32dev")
    parser.add_argument("--published-at")
    args = parser.parse_args()

    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,62}", args.version):
        raise SystemExit("invalid firmware version")
    if not re.fullmatch(r"[0-9a-f]{40}", args.commit):
        raise SystemExit("commit must be a full lowercase Git SHA")
    firmware = args.firmware.read_bytes()
    if not firmware or len(firmware) > MAX_OTA_SLOT_BYTES:
        raise SystemExit(f"firmware is empty or exceeds the {MAX_OTA_SLOT_BYTES}-byte OTA slot")

    published_at = args.published_at or datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    manifest = {
        "schemaVersion": 1,
        "version": args.version,
        "commit": args.commit,
        "environment": args.environment,
        "size": len(firmware),
        "sha256": hashlib.sha256(firmware).hexdigest(),
        "asset": "firmware.bin",
        "publishedAt": published_at,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
