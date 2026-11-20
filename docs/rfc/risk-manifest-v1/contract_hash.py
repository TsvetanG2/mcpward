"""Reference implementation of the mcp-tool-contract hash, rules version 1 (DRAFT).

Usage: python3 contract_hash.py tool.json   (a single tool object from tools/list)

Prints the canonical JSON and the sha256 hash, or "unhashable: <reason>" when the tool is
not valid I-JSON (RFC 7493), has an integer beyond double precision, or its inputSchema is
nested too deeply. The last line is always the result.

Kept deliberately small so it can be ported to C#, Swift or TypeScript line by line.
Serialization follows RFC 8785 (JCS), including ECMAScript number formatting.
"""

import hashlib
import json
import math
import re
import sys
import unicodedata

# Members whose string value is text for the model: canonicalized like the tool description.
TEXT_MEMBERS = ("description", "title")
# Members whose value is data: never canonicalized beyond NFC, at any depth below them.
DATA_MEMBERS = ("default", "const", "enum", "examples")
# inputSchema has depth 0; each member value or array element is one deeper than its container.
MAX_DEPTH = 64
# Integers a double holds exactly; an integer literal outside this range is ambiguous.
MAX_SAFE_INTEGER = 2**53 - 1


class Unhashable(Exception):
    """The tool has no contract hash. The reason is one of the spec's enum values."""


# --- I-JSON checks -------------------------------------------------------------------------


# When several reasons apply, the first in this order is reported.
REASONS = ("duplicate-key", "lone-surrogate", "non-finite-number", "number-precision", "too-deep")


def find_reasons(tool, found):
    """Lone surrogates in any string (key or value) and non-finite numbers (a fraction or
    exponent whose nearest double is infinite).
    A surrogate pair in the JSON text decodes to one code point, so any surrogate code
    point left in a Python string is unpaired."""
    if any(any(0xD800 <= ord(c) <= 0xDFFF for c in s) for s in strings(tool)):
        found.add("lone-surrogate")
    if any(not math.isfinite(n) for n in numbers(tool)):
        found.add("non-finite-number")
    if isinstance(tool, dict) and too_deep(tool.get("inputSchema") or {}):
        found.add("too-deep")


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for v in value:
            yield from strings(v)
    elif isinstance(value, dict):
        for k, v in value.items():
            yield k
            yield from strings(v)


def numbers(value):
    if isinstance(value, bool):
        return
    if isinstance(value, (int, float)):
        yield value
    elif isinstance(value, list):
        for v in value:
            yield from numbers(v)
    elif isinstance(value, dict):
        for v in value.values():
            yield from numbers(v)


def too_deep(value, depth=0):
    if depth > MAX_DEPTH:
        return True
    if isinstance(value, list):
        return any(too_deep(v, depth + 1) for v in value)
    if isinstance(value, dict):
        return any(too_deep(v, depth + 1) for v in value.values())
    return False


# --- Canonicalization ----------------------------------------------------------------------


def utf16_key(s: str):
    # RFC 8785 sorts object keys by UTF-16 code units, not by code points.
    return s.encode("utf-16-be")


def nfc_values(value):
    """NFC-normalize every string VALUE, recursively. Member names are identifiers (argument
    names a client must send byte for byte) and stay exactly as the server sent them; so do
    the elements of every array named "required", which are member names too."""
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value)
    if isinstance(value, list):
        return [nfc_values(v) for v in value]
    if isinstance(value, dict):
        return {k: v if k == "required" and isinstance(v, list) else nfc_values(v) for k, v in value.items()}
    return value


def canonical_text(text):
    """NFC; CRLF/CR -> LF; per line: collapse [ \\t]+ to one space, trim ASCII space/tab;
    then trim ASCII space/tab/LF from the whole string. Invisible characters are KEPT."""
    if not text:
        return ""
    text = unicodedata.normalize("NFC", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [re.sub(r"^[ \t\n]+|[ \t\n]+$", "", re.sub(r"[ \t]+", " ", line)) for line in text.split("\n")]
    return re.sub(r"^[ \t\n]+|[ \t\n]+$", "", "\n".join(lines))


def canonical_members(value, schema):
    """String members named description/title are canonical text, at any depth, except
    below default/const/enum/examples (data: nothing there is touched beyond NFC).
    In inputSchema (schema=True), arrays named required are sorted: they are sets of
    names. Other arrays keep source order."""
    if isinstance(value, list):
        return [canonical_members(v, schema) for v in value]
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k in DATA_MEMBERS:
                out[k] = v
            elif k in TEXT_MEMBERS and isinstance(v, str):
                out[k] = canonical_text(v)
            elif schema and k == "required" and isinstance(v, list):
                out[k] = sorted(v, key=lambda s: utf16_key(s) if isinstance(s, str) else b"")
            else:
                out[k] = canonical_members(v, schema)
        return out
    return value


def canonical_contract(tool: dict) -> dict:
    schema = tool.get("inputSchema") or {}
    return {
        "name": unicodedata.normalize("NFC", tool["name"]),
        "title": canonical_text(tool.get("title")),
        "description": canonical_text(tool.get("description")),
        "inputSchema": canonical_members(nfc_values(schema), schema=True),
        "annotations": canonical_members(nfc_values(tool.get("annotations") or {}), schema=False),
    }


# --- RFC 8785 serialization ----------------------------------------------------------------


def es_number(x) -> str:
    """ECMAScript Number::toString (RFC 8785 section 3.2.2.3). Integers are doubles first."""
    x = float(x)
    if x == 0:
        return "0"  # also -0
    if x < 0:
        return "-" + es_number(-x)
    # repr() gives the shortest round-trip digits, as ECMAScript does.
    mantissa, _, exp = repr(x).partition("e")
    int_part, _, frac = mantissa.partition(".")
    digits = int_part + frac
    n = len(int_part) + (int(exp) if exp else 0)  # decimal point position
    stripped = digits.lstrip("0")
    n -= len(digits) - len(stripped)
    digits = stripped.rstrip("0")
    k = len(digits)
    if k <= n <= 21:
        return digits + "0" * (n - k)
    if 0 < n <= 21:
        return digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return "0." + "0" * (-n) + digits
    e = n - 1
    sign = "+" if e >= 0 else "-"
    head = digits[0] + ("." + digits[1:] if k > 1 else "")
    return f"{head}e{sign}{abs(e)}"


def jcs(value) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return es_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(jcs(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=utf16_key)
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + jcs(value[k]) for k in keys) + "}"
    raise TypeError(f"unsupported type {type(value)}")


def contract_hash(canonical: dict) -> str:
    return "sha256:" + hashlib.sha256(jcs(canonical).encode("utf-8")).hexdigest()


def parse_tool(text: str) -> dict:
    """Parses one tool object from raw JSON text and applies the I-JSON rule to all of it,
    plus the depth limit to inputSchema. Raises Unhashable with the first reason found."""
    found = set()

    def pairs_hook(pairs):
        # A member name used twice in one object (compared after unescaping).
        names = [k for k, _ in pairs]
        if len(set(names)) != len(names):
            found.add("duplicate-key")
        return dict(pairs)

    def constant_hook(name):
        # NaN, Infinity and -Infinity are not JSON; Python accepts them by default.
        found.add("non-finite-number")
        return 0.0

    def int_hook(literal):
        # Written as an integer (no fraction, no exponent): must be exact as a double.
        # Never converted silently; an out-of-range literal makes the tool unhashable.
        if abs(int(literal)) > MAX_SAFE_INTEGER:
            found.add("number-precision")
            return 0.0
        return float(literal)

    # parse_float is Python's float(): the nearest binary64 value, round-half-even.
    tool = json.loads(text, object_pairs_hook=pairs_hook, parse_constant=constant_hook, parse_int=int_hook)
    find_reasons(tool, found)
    for reason in REASONS:
        if reason in found:
            raise Unhashable(reason)
    return tool


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    with open(sys.argv[1], encoding="utf-8") as f:
        raw = f.read()
    try:
        canonical = canonical_contract(parse_tool(raw))
    except Unhashable as reason:
        print(f"unhashable: {reason}")
        sys.exit(0)
    print(jcs(canonical))
    print(contract_hash(canonical))
