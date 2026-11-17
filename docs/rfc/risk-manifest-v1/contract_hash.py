"""Reference implementation of the mcp-tool-contract hash, rules version 1 (DRAFT).

Usage: python3 contract_hash.py tool.json   (a single tool object from tools/list)

Kept deliberately small so it can be ported to C#, Swift or TypeScript line by line.
Limitation: the JSON number formatting below is only exact for integers and simple
decimals; a full RFC 8785 implementation is required for arbitrary floats.
"""

import hashlib
import json
import re
import sys
import unicodedata


def utf16_key(s: str):
    # RFC 8785 sorts object keys by UTF-16 code units, not by code points.
    return s.encode("utf-16-be")


def nfc(value):
    """NFC-normalize every string, recursively. Keys are normalized too."""
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value)
    if isinstance(value, list):
        return [nfc(v) for v in value]
    if isinstance(value, dict):
        return {nfc(k): nfc(v) for k, v in value.items()}
    return value


def canonical_description(text):
    """NFC; CRLF/CR -> LF; per line: collapse [ \\t]+ to one space, trim ASCII space/tab;
    then trim ASCII space/tab/LF from the whole string. Invisible characters are KEPT."""
    if not text:
        return ""
    text = unicodedata.normalize("NFC", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [re.sub(r"^[ \t\n]+|[ \t\n]+$", "", re.sub(r"[ \t]+", " ", line)) for line in text.split("\n")]
    return re.sub(r"^[ \t\n]+|[ \t\n]+$", "", "\n".join(lines))


def sort_required(value):
    """Every object member named "required" whose value is an array is sorted
    (UTF-16 code unit order): it is a set. All other arrays keep source order."""
    if isinstance(value, list):
        return [sort_required(v) for v in value]
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k == "required" and isinstance(v, list):
                out[k] = sorted(v, key=lambda s: utf16_key(s) if isinstance(s, str) else b"")
            else:
                out[k] = sort_required(v)
        return out
    return value


def jcs(value) -> str:
    """RFC 8785 serialization for the value types that appear in tool contracts."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value.is_integer() and abs(value) < 1e21:
            return str(int(value))
        return repr(value)  # see limitation in the module docstring
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(jcs(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=utf16_key)
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + jcs(value[k]) for k in keys) + "}"
    raise TypeError(f"unsupported type {type(value)}")


def canonical_contract(tool: dict) -> dict:
    return {
        "name": nfc(tool["name"]),
        "description": canonical_description(tool.get("description")),
        "inputSchema": sort_required(nfc(tool.get("inputSchema") or {})),
        "annotations": nfc(tool.get("annotations") or {}),
    }


def contract_hash(tool: dict) -> str:
    data = jcs(canonical_contract(tool)).encode("utf-8")
    return "sha256:" + hashlib.sha256(data).hexdigest()


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as f:
        tool = json.load(f)
    print(jcs(canonical_contract(tool)))
    print(contract_hash(tool))
