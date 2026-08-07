from __future__ import annotations

import json
import re


def extract_json_from_llm_output(output: str) -> object | None:
    if not output:
        return None
    try:
        return json.loads(output)
    except json.JSONDecodeError:
        match = re.search(r"```(?:json)?\s*(.*?)\s*```", output, re.DOTALL)
        if not match:
            return None
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            return None
